import { db } from '../db/index.js';
import { accounts, payees, transactions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { unlinkOccurrenceByTransactionId } from './matchingEngine.js';

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
 * Turns two existing transactions into a transfer pair, like one created as a transfer:
 * each points at the other, has a "Transfer: <other account>" payee and no category.
 * Used when bank sync recognizes money moving between the user's own accounts.
 */
export function linkTransfer(aId: string, bId: string): TransferOutcome {
  return db.transaction((tx) => {
    const [a, b] = [aId, bId].map((id) =>
      tx.select().from(transactions).where(eq(transactions.id, id)).get(),
    );
    if (!a || !b) return { ok: false, status: 404, error: 'Not found' } as const;
    if (a.accountId === b.accountId || a.amount !== -b.amount || a.amount === 0)
      return { ok: false, status: 400, error: 'Not two sides of one transfer' } as const;
    for (const t of [a, b]) {
      if (t.transferTransactionId || t.isParent || t.parentTransactionId || t.isAdjustment)
        return { ok: false, status: 400, error: 'Only plain transactions can be linked' } as const;
      if (t.reconciled)
        return { ok: false, status: 403, error: 'Cannot modify a reconciled transaction' } as const;
    }
    const accountName = (id: string) =>
      tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, id)).get()?.name ??
      'account';
    for (const [self, other] of [
      [a, b],
      [b, a],
    ]) {
      tx.update(transactions)
        .set({
          transferTransactionId: other.id,
          payeeId: null,
          payeeName: `Transfer: ${accountName(other.accountId)}`,
          categoryId: null,
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
