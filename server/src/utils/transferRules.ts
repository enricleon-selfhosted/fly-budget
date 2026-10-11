// What makes two transactions a valid transfer, and how its sides behave (decisions D25, D26).
// Pure: callers pass the rows and their accounts.

export type TransferAccount = { id: string; currency: string | null; isOffBudget: number };
export type TransferSide = { amount: number; account: TransferAccount };

/** Accounts in one currency (null = the budget's): a transfer between them moves one amount */
export function sameCurrency(a: TransferAccount, b: TransferAccount): boolean {
  return a.currency === b.currency;
}

/**
 * Why two transactions can't be the two sides of one transfer, or null if they can: different
 * accounts, money out on one side and in on the other, and — within one currency — the same
 * amount. Across currencies (an exchange) each side keeps its own amount.
 */
export function transferPairProblem(a: TransferSide, b: TransferSide): string | null {
  if (a.account.id === b.account.id) return 'Both sides are in the same account';
  if (a.amount === 0 || b.amount === 0 || Math.sign(a.amount) === Math.sign(b.amount))
    return 'A transfer takes money out of one account and puts it into the other';
  if (sameCurrency(a.account, b.account) && a.amount !== -b.amount)
    return 'Both sides of a transfer in one currency have the same amount';
  return null;
}

/**
 * Whether this side of a transfer can have a category: only the on-budget side of a transfer
 * with an off-budget account, because only then does money enter or leave the budget.
 */
export function sideTakesCategory(self: TransferAccount, other: TransferAccount): boolean {
  return self.isOffBudget === 0 && other.isOffBudget === 1;
}

/** Whether editing one side's amount changes the other's (not for exchanges) */
export function mirrorsAmount(a: TransferAccount, b: TransferAccount): boolean {
  return sameCurrency(a, b);
}

/** What decides whether an existing transaction can become one side of a transfer */
export type LinkableRow = {
  transferTransactionId: string | null;
  isParent: number;
  parentTransactionId: string | null;
  isAdjustment: number;
  reconciled: number;
};

/**
 * Why a transaction can't be linked as a side of a transfer, or null if it can: it must be plain
 * (not already a transfer, not a split or one of its parts, not a balance correction) and not
 * reconciled.
 */
export function linkableProblem(
  t: LinkableRow,
): { reason: 'not_plain' | 'reconciled'; error: string } | null {
  if (t.transferTransactionId || t.isParent || t.parentTransactionId || t.isAdjustment)
    return { reason: 'not_plain', error: 'Only plain transactions can be linked' };
  if (t.reconciled)
    return { reason: 'reconciled', error: 'Cannot modify a reconciled transaction' };
  return null;
}

/** "Link as transfer" looks this many days either side for the other side */
export const TRANSFER_CANDIDATE_DAYS = 7;
/** …and offers at most this many */
export const MAX_TRANSFER_CANDIDATES = 20;

export type LinkCandidate = LinkableRow & TransferSide & { id: string; date: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What "Link as transfer" offers as the other side of `source`: transactions that can be linked
 * and would make a valid pair with it, closest date first (then by id, so the order is stable),
 * at most MAX_TRANSFER_CANDIDATES. Nothing when the source itself can't be linked.
 */
export function rankTransferCandidates<T extends LinkCandidate>(
  source: LinkCandidate,
  nearby: readonly T[],
): T[] {
  if (linkableProblem(source)) return [];
  const days = (d: string) => Math.abs(Date.parse(d) - Date.parse(source.date)) / DAY_MS;
  return nearby
    .filter((c) => !linkableProblem(c) && !transferPairProblem(source, c))
    .sort((a, b) => days(a.date) - days(b.date) || a.id.localeCompare(b.id))
    .slice(0, MAX_TRANSFER_CANDIDATES);
}
