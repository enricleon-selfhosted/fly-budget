import { db } from '../db/index.js';
import { accounts, payees, transactions } from '../db/schema.js';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';
import { unlinkOccurrenceByTransactionId } from './matchingEngine.js';
import { sideTakesCategory, transferPairProblem } from '../utils/transferRules.js';
import { convertTransactions } from './fx/fxService.js';

export function resolvePayee(
  payeeName: string | null | undefined,
  payeeId: string | null | undefined,
) {
  let id = payeeId ?? null;
  let name = payeeName ?? null;
  if (!id && payeeName) {
    const existing = db.select().from(payees).where(eq(payees.name, payeeName)).get();
    if (existing) {
      id = existing.id;
    } else {
      id = nanoid();
      db.insert(payees)
        .values({
          id,
          name: payeeName,
          defaultCategoryId: null,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    name = payeeName;
  }
  return { payeeId: id, payeeName: name };
}

/**
 * Deletes a transaction with everything that hangs off it: a split's parts, the link
 * from a transfer's other side, and a schedule occurrence it paid (back to pending).
 */
export function deleteTransactionRow(row: { id: string; transferTransactionId: string | null }) {
  db.transaction((tx) => {
    const ids = [
      row.id,
      ...tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.parentTransactionId, row.id))
        .all()
        .map((c) => c.id),
    ];
    for (const id of ids) unlinkOccurrenceByTransactionId(id);
    if (row.transferTransactionId) {
      tx.update(transactions)
        .set({ transferTransactionId: null })
        .where(eq(transactions.id, row.transferTransactionId))
        .run();
    }
    tx.delete(transactions).where(eq(transactions.parentTransactionId, row.id)).run();
    tx.delete(transactions).where(eq(transactions.id, row.id)).run();
  });
}

type TransferOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Turns two existing transactions into a transfer pair, like one created as a transfer: each
 * points at the other and has a "Transfer: <other account>" payee. Accounts in different
 * currencies make an exchange, each side keeping its amount (D25). A category stays only on
 * the on-budget side of a transfer with an off-budget account (D26). Used when bank sync
 * recognizes money moving between the user's own accounts, and by "Link as transfer".
 */
export function linkTransfer(aId: string, bId: string): TransferOutcome {
  const outcome = linkTransferRows(aId, bId);
  // An exchange into the budget's currency fixes the other side's rate (docs/multi-currency M3)
  if (outcome.ok) convertTransactions([aId, bId]);
  return outcome;
}

function linkTransferRows(aId: string, bId: string): TransferOutcome {
  return db.transaction((tx) => {
    const [a, b] = [aId, bId].map((id) =>
      tx.select().from(transactions).where(eq(transactions.id, id)).get(),
    );
    if (!a || !b) return { ok: false, status: 404, error: 'Not found' } as const;
    for (const t of [a, b]) {
      if (t.transferTransactionId || t.isParent || t.parentTransactionId || t.isAdjustment)
        return { ok: false, status: 400, error: 'Only plain transactions can be linked' } as const;
      if (t.reconciled)
        return { ok: false, status: 403, error: 'Cannot modify a reconciled transaction' } as const;
    }
    const accountOf = (id: string) =>
      tx
        .select({
          id: accounts.id,
          name: accounts.name,
          currency: accounts.currency,
          isOffBudget: accounts.isOffBudget,
        })
        .from(accounts)
        .where(eq(accounts.id, id))
        .get();
    const [accountA, accountB] = [accountOf(a.accountId), accountOf(b.accountId)];
    if (!accountA || !accountB) return { ok: false, status: 404, error: 'Not found' } as const;
    const problem = transferPairProblem(
      { amount: a.amount, account: accountA },
      { amount: b.amount, account: accountB },
    );
    if (problem) return { ok: false, status: 400, error: problem } as const;

    for (const [self, selfAccount, other, otherAccount] of [
      [a, accountA, b, accountB],
      [b, accountB, a, accountA],
    ] as const) {
      tx.update(transactions)
        .set({
          transferTransactionId: other.id,
          payeeId: null,
          payeeName: `Transfer: ${otherAccount.name}`,
          categoryId: sideTakesCategory(selfAccount, otherAccount) ? self.categoryId : null,
        })
        .where(eq(transactions.id, self.id))
        .run();
    }
    return { ok: true } as const;
  });
}

/**
 * Splits a transfer pair back into two ordinary, uncategorized transactions. Each side gets
 * the payee the bank (or CSV) named, if it has one.
 */
export function unlinkTransfer(id: string): TransferOutcome {
  const otherId = db
    .select({ other: transactions.transferTransactionId })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get()?.other;
  const outcome = unlinkTransferRows(id);
  if (outcome.ok) convertTransactions(otherId ? [id, otherId] : [id]);
  return outcome;
}

function unlinkTransferRows(id: string): TransferOutcome {
  return db.transaction((tx) => {
    const row = tx.select().from(transactions).where(eq(transactions.id, id)).get();
    if (!row) return { ok: false, status: 404, error: 'Not found' } as const;
    if (!row.transferTransactionId)
      return { ok: false, status: 400, error: 'Not a transfer' } as const;
    const other = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, row.transferTransactionId))
      .get();
    const sides = other ? [row, other] : [row];
    if (sides.some((t) => t.reconciled))
      return {
        ok: false,
        status: 403,
        error: 'Cannot modify a reconciled transaction',
      } as const;
    for (const t of sides) {
      const payee = resolvePayee(t.importedPayee, null);
      tx.update(transactions)
        .set({ transferTransactionId: null, payeeId: payee.payeeId, payeeName: payee.payeeName })
        .where(eq(transactions.id, t.id))
        .run();
    }
    return { ok: true } as const;
  });
}

/**
 * After an account moves on or off budget: transfers between it and other accounts that no longer
 * cross the budget boundary lose their category (docs/multi-currency M8, D26), so money isn't
 * counted twice. Returns how many transactions changed.
 */
export function uncategorizeTransfersThatStopCrossing(accountId: string): number {
  const budgetStatus = new Map(
    db
      .select({ id: accounts.id, currency: accounts.currency, isOffBudget: accounts.isOffBudget })
      .from(accounts)
      .all()
      .map((a) => [a.id, a]),
  );
  const other = alias(transactions, 'other');
  const rows = db
    .select({ id: transactions.id, self: transactions.accountId, other: other.accountId })
    .from(transactions)
    .innerJoin(other, eq(other.id, transactions.transferTransactionId))
    .where(
      and(
        isNotNull(transactions.categoryId),
        or(eq(transactions.accountId, accountId), eq(other.accountId, accountId)),
      ),
    )
    .all();
  const stale = rows.filter((r) => {
    const self = budgetStatus.get(r.self);
    const otherAccount = budgetStatus.get(r.other);
    return !self || !otherAccount || !sideTakesCategory(self, otherAccount);
  });
  db.transaction((tx) => {
    for (const r of stale) {
      tx.update(transactions).set({ categoryId: null }).where(eq(transactions.id, r.id)).run();
    }
  });
  return stale.length;
}
