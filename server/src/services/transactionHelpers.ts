import { db } from '../db/index.js';
import { accounts, payees, transactions } from '../db/schema.js';
import { and, eq, gte, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { addDays, format, parseISO } from 'date-fns';
import { nanoid } from 'nanoid';
import { unlinkOccurrenceByTransactionId } from './matchingEngine.js';
import {
  TRANSFER_CANDIDATE_DAYS,
  linkableProblem,
  mirrorsAmount,
  rankTransferCandidates,
  sameCurrency,
  sideTakesCategory,
  transferPairProblem,
} from '../utils/transferRules.js';
import { convertTransactions } from './fx/fxService.js';
import { afterTransactionsWritten } from './transactionFx.js';

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
  // The other side is no longer an exchange: it goes back to a rate of its own (M3)
  if (row.transferTransactionId) convertTransactions([row.transferTransactionId]);
}

// ---------------------------------------------------------------------------
// Transfers: creating a pair, keeping its sides in step, linking and unlinking (decisions D25,
// D26). What makes a valid pair is pure, in utils/transferRules.ts; these functions load the rows
// and write them.

/** Why a transfer write was refused; the API turns it into a status */
export type TransferRefusal =
  | 'not_found'
  /** Already a transfer, a split or one of its parts, or a balance correction */
  | 'not_plain'
  | 'reconciled'
  | 'not_a_transfer'
  /** The two sides wouldn't be one movement of money (transferPairProblem) */
  | 'invalid_pair'
  /** A category on a side that can't have one (sideTakesCategory) */
  | 'no_category';

export type TransferOutcome = { ok: true } | { ok: false; reason: TransferRefusal; error: string };
type Refused = Extract<TransferOutcome, { ok: false }>;

const refuse = (reason: TransferRefusal, error: string): Refused => ({ ok: false, reason, error });

type Db = Pick<typeof db, 'select' | 'update'>;

/** An account as transfers need it: what the rules look at, and its name for the payee */
export type TransferAccountRow = {
  id: string;
  name: string;
  currency: string | null;
  isOffBudget: number;
};

const transferAccountColumns = {
  id: accounts.id,
  name: accounts.name,
  currency: accounts.currency,
  isOffBudget: accounts.isOffBudget,
};

/** Loads an account as transfers need it (inside a database transaction, pass its handle) */
export function transferAccount(tx: Db, id: string): TransferAccountRow | undefined {
  return tx.select(transferAccountColumns).from(accounts).where(eq(accounts.id, id)).get();
}

/** The payee each side of a transfer shows: the account on the other side */
export const transferPayeeName = (other: { name: string }) => `Transfer: ${other.name}`;

export type NewTransfer = {
  /** Chosen by the device for a transfer saved offline: the id of the side leaving */
  id?: string;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  /** What leaves the first account (positive) */
  amount: number;
  /** What arrives in the other account when its currency differs (an exchange, D25) */
  toAmount?: number;
  /** Only for the on-budget side of a transfer with an off-budget account (D26) */
  categoryId?: string | null;
  notes?: string | null;
};

function transferRow(
  side: { id: string; account: TransferAccountRow; amount: number; categoryId: string | null },
  other: { id: string; account: TransferAccountRow },
  shared: { date: string; notes: string | null; createdAt: string },
) {
  return {
    id: side.id,
    accountId: side.account.id,
    date: shared.date,
    amount: side.amount,
    payeeId: null,
    payeeName: transferPayeeName(other.account),
    categoryId: side.categoryId,
    notes: shared.notes,
    transferTransactionId: other.id,
    reconciled: 0,
    isParent: 0,
    parentTransactionId: null,
    importedId: null,
    createdAt: shared.createdAt,
  };
}

type TransferRow = ReturnType<typeof transferRow>;

/**
 * Creates a transfer: two linked rows, money leaving one account and arriving in the other, each
 * with a "Transfer: <other account>" payee. Within one currency both sides move the same amount;
 * an exchange needs what arrived (D25). A category goes on the budget side of money entering or
 * leaving the budget (D26). Returns both rows, the side leaving first.
 */
export function createTransfer(
  input: NewTransfer,
): { ok: true; rows: [TransferRow, TransferRow] } | Refused {
  const from = transferAccount(db, input.fromAccountId);
  const to = transferAccount(db, input.toAccountId);
  if (!from || !to) return refuse('not_found', 'Account not found');
  const received = sameCurrency(from, to) ? input.amount : input.toAmount;
  if (received === undefined)
    return refuse('invalid_pair', 'Enter the amount received in the other currency');
  const problem = transferPairProblem(
    { amount: -input.amount, account: from },
    { amount: received, account: to },
  );
  if (problem) return refuse('invalid_pair', problem);
  const categoryId = input.categoryId ?? null;
  const categorized = !categoryId
    ? null
    : sideTakesCategory(from, to)
      ? 'from'
      : sideTakesCategory(to, from)
        ? 'to'
        : null;
  if (categoryId && !categorized)
    return refuse('no_category', 'Transfers between two budget accounts have no category');

  const fromId = input.id ?? nanoid();
  const toId = nanoid();
  const shared = {
    date: input.date,
    notes: input.notes ?? null,
    createdAt: new Date().toISOString(),
  };
  const fromTx = transferRow(
    {
      id: fromId,
      account: from,
      amount: -input.amount,
      categoryId: categorized === 'from' ? categoryId : null,
    },
    { id: toId, account: to },
    shared,
  );
  const toTx = transferRow(
    {
      id: toId,
      account: to,
      amount: received,
      categoryId: categorized === 'to' ? categoryId : null,
    },
    { id: fromId, account: from },
    shared,
  );
  db.transaction((tx) => {
    tx.insert(transactions).values(fromTx).run();
    tx.insert(transactions).values(toTx).run();
  });
  afterTransactionsWritten([fromId, toId]);
  return { ok: true, rows: [fromTx, toTx] };
}

/** The side of a transfer being edited, as it is before the edit */
export type EditedTransferSide = {
  id: string;
  accountId: string;
  amount: number;
  transferTransactionId: string | null;
};

export type TransferSideEdit = {
  accountId?: string;
  categoryId?: string | null;
  date?: string;
  amount?: number;
};

/**
 * Checks an edit of one side of a transfer against the transfer rules, and keeps the other side
 * in step: its date always, its amount only within one currency (an exchange keeps each side's
 * amount, D25). The pair must still be valid after the edit. Call it inside the edit's database
 * transaction, before writing the edited row: it writes nothing when it refuses. A transaction
 * that isn't a transfer passes unchanged.
 */
export function updateTransferSide(
  tx: Db,
  existing: EditedTransferSide,
  edit: TransferSideEdit,
): TransferOutcome {
  if (!existing.transferTransactionId) return { ok: true };
  const other = tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      date: transactions.date,
      reconciled: transactions.reconciled,
    })
    .from(transactions)
    .where(eq(transactions.id, existing.transferTransactionId))
    .get();
  const self = transferAccount(tx, existing.accountId);
  const otherAccount = other && transferAccount(tx, other.accountId);
  // The other side is gone (deleting it unlinks this one): nothing to keep in step
  if (!self || !other || !otherAccount) return { ok: true };

  if (edit.accountId !== undefined && edit.accountId !== existing.accountId)
    return refuse('invalid_pair', 'Transfers stay in their accounts');
  if (edit.categoryId && !sideTakesCategory(self, otherAccount))
    return refuse('no_category', 'Transfers between two budget accounts have no category');
  const mirrored =
    edit.amount !== undefined && mirrorsAmount(self, otherAccount) ? -edit.amount : undefined;
  if (edit.amount !== undefined) {
    const problem = transferPairProblem(
      { amount: edit.amount, account: self },
      { amount: mirrored ?? other.amount, account: otherAccount },
    );
    if (problem) return refuse('invalid_pair', problem);
  }
  const changesOther =
    (edit.date !== undefined && edit.date !== other.date) ||
    (mirrored !== undefined && mirrored !== other.amount);
  // Like linking and unlinking: a reconciled row never changes behind the user's back
  if (changesOther && other.reconciled)
    return refuse('reconciled', 'The other side of this transfer is reconciled');
  if (edit.date !== undefined || mirrored !== undefined) {
    tx.update(transactions)
      .set({ date: edit.date, amount: mirrored })
      .where(eq(transactions.id, other.id))
      .run();
  }
  return { ok: true };
}

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
    if (!a || !b) return refuse('not_found', 'Not found');
    for (const t of [a, b]) {
      const problem = linkableProblem(t);
      if (problem) return refuse(problem.reason, problem.error);
    }
    const [accountA, accountB] = [
      transferAccount(tx, a.accountId),
      transferAccount(tx, b.accountId),
    ];
    if (!accountA || !accountB) return refuse('not_found', 'Not found');
    const problem = transferPairProblem(
      { amount: a.amount, account: accountA },
      { amount: b.amount, account: accountB },
    );
    if (problem) return refuse('invalid_pair', problem);

    for (const [self, selfAccount, other, otherAccount] of [
      [a, accountA, b, accountB],
      [b, accountB, a, accountA],
    ] as const) {
      tx.update(transactions)
        .set({
          transferTransactionId: other.id,
          payeeId: null,
          payeeName: transferPayeeName(otherAccount),
          categoryId: sideTakesCategory(selfAccount, otherAccount) ? self.categoryId : null,
        })
        .where(eq(transactions.id, self.id))
        .run();
    }
    return { ok: true } as const;
  });
}

/**
 * Splits a transfer pair back into two ordinary transactions, keeping their amounts, dates and
 * categories (only a budget side crossing the boundary has one, D26). Each side gets the payee
 * the bank (or CSV) named, if it has one.
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
    if (!row) return refuse('not_found', 'Not found');
    if (!row.transferTransactionId) return refuse('not_a_transfer', 'Not a transfer');
    const other = tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, row.transferTransactionId))
      .get();
    const sides = other ? [row, other] : [row];
    if (sides.some((t) => t.reconciled))
      return refuse('reconciled', 'Cannot modify a reconciled transaction');
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

/** A transaction "Link as transfer" offers as the other side, with its account */
export type TransferCandidate = {
  id: string;
  accountId: string;
  accountName: string;
  currency: string | null;
  date: string;
  amount: number;
  payeeName: string | null;
};

/**
 * What "Link as transfer" offers as a transaction's other side: transactions in the user's other
 * open accounts, a few days either side, that could be linked with it (rankTransferCandidates),
 * closest date first. Nothing when the transaction itself can't be linked; null when it doesn't
 * exist.
 */
export function transferCandidates(id: string): TransferCandidate[] | null {
  const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!row) return null;
  const self = transferAccount(db, row.accountId);
  if (!self || linkableProblem(row)) return [];

  const shift = (days: number) => format(addDays(parseISO(row.date), days), 'yyyy-MM-dd');
  const nearby = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      currency: accounts.currency,
      isOffBudget: accounts.isOffBudget,
      date: transactions.date,
      amount: transactions.amount,
      payeeName: transactions.payeeName,
      transferTransactionId: transactions.transferTransactionId,
      isParent: transactions.isParent,
      parentTransactionId: transactions.parentTransactionId,
      isAdjustment: transactions.isAdjustment,
      reconciled: transactions.reconciled,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        ne(transactions.accountId, row.accountId),
        isNull(accounts.closedAt),
        gte(transactions.date, shift(-TRANSFER_CANDIDATE_DAYS)),
        lte(transactions.date, shift(TRANSFER_CANDIDATE_DAYS)),
      ),
    )
    .all()
    .map((c) => ({
      ...c,
      account: { id: c.accountId, currency: c.currency, isOffBudget: c.isOffBudget },
    }));

  return rankTransferCandidates({ ...row, account: self }, nearby).map((c) => ({
    id: c.id,
    accountId: c.accountId,
    accountName: c.accountName,
    currency: c.currency,
    date: c.date,
    amount: c.amount,
    payeeName: c.payeeName,
  }));
}

/**
 * After an account moves on or off budget: transfers between it and other accounts that no longer
 * cross the budget boundary lose their category (docs/multi-currency M8, D26), so money isn't
 * counted twice. Returns how many transactions changed.
 */
export function uncategorizeTransfersThatStopCrossing(accountId: string): number {
  const budgetStatus = new Map(
    db
      .select(transferAccountColumns)
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
