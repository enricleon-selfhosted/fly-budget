// How well a transaction fits an occurrence of a recurring item, and which imported
// transactions can be matched to one without asking (decisions D28, D29). Pure: callers pass
// the rows. The database side is matchingEngine.ts.

export type MatchTransaction = {
  date: string;
  amount: number;
  payeeId: string | null;
  payeeName: string | null;
  /** The bank's own text, when the transaction was imported */
  importedPayee?: string | null;
  notes?: string | null;
  accountId: string;
};

export type MatchOccurrence = { expectedDate: string; expectedAmount: number };

export type MatchSchedule = {
  amount: number;
  amountType: string;
  dateFlexibility: number;
  payeeId: string | null;
  accountId: string | null;
  name: string;
  /** Bank text that identifies the item's transactions ("contains", case-insensitive) */
  matchText?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A variable amount in the right direction but more than 25% from the usual */
const LOOSE_AMOUNT_SCORE = 10;

/**
 * Points for the amount, by the item's amount type: exact must be exact; approximate within
 * 10%; variable can be anything in the same direction, closer scoring higher. 0 = doesn't fit.
 */
export function amountScore(amountType: string, amount: number, expected: number): number {
  if (amount === 0 || expected === 0 || Math.sign(amount) !== Math.sign(expected)) {
    return amount === expected ? 30 : 0;
  }
  const diff = Math.abs(amount - expected);
  const ratio = diff / Math.abs(expected);
  if (diff === 0) return 30;
  if (amountType === 'approximate') return ratio <= 0.1 ? 20 : 0;
  if (amountType === 'variable') return ratio <= 0.25 ? 20 : LOOSE_AMOUNT_SCORE;
  return 0;
}

/** Whether the bank's text (or the payee or notes) contains the item's match text */
export function textMatches(tx: MatchTransaction, matchText: string | null | undefined): boolean {
  const needle = matchText?.trim().toLowerCase();
  if (!needle) return false;
  return [tx.importedPayee, tx.payeeName, tx.notes].some((t) => t?.toLowerCase().includes(needle));
}

/** Points for recognizing who it is: the item's payee, its bank text, or a similar name */
export function identityScore(tx: MatchTransaction, schedule: MatchSchedule): number {
  if (schedule.payeeId && tx.payeeId === schedule.payeeId) return 25;
  if (textMatches(tx, schedule.matchText)) return 25;
  if (schedule.payeeId && tx.payeeName && schedule.name) {
    const name = tx.payeeName.toLowerCase();
    const item = schedule.name.toLowerCase();
    if (name.includes(item) || item.includes(name)) return 15;
  }
  return 0;
}

export function scoreMatch(
  tx: MatchTransaction,
  occ: MatchOccurrence,
  schedule: MatchSchedule,
): { score: number; payeeScore: number; amountScore: number } {
  const daysDiff =
    Math.abs(Date.parse(`${tx.date}T00:00:00Z`) - Date.parse(`${occ.expectedDate}T00:00:00Z`)) /
    DAY_MS;
  const none = { score: 0, payeeScore: 0, amountScore: 0 };
  if (daysDiff > schedule.dateFlexibility) return none;

  const dateScore = Math.max(0, 30 - daysDiff * 5);
  const amount = amountScore(schedule.amountType, tx.amount, occ.expectedAmount);
  if (amount === 0) return none;

  const payeeScore = identityScore(tx, schedule);
  // A variable amount far from the usual one only counts when the payee or bank text says who
  if (amount === LOOSE_AMOUNT_SCORE && payeeScore === 0) return none;
  let accountScore = 0;
  if (schedule.accountId && tx.accountId === schedule.accountId) accountScore = 15;
  else if (!schedule.accountId) accountScore = 5;

  return { score: dateScore + amount + payeeScore + accountScore, payeeScore, amountScore: amount };
}

export type ImportedTransaction = MatchTransaction & { id: string };
export type PendingOccurrence = MatchOccurrence & { id: string; schedule: MatchSchedule };

/**
 * The imported transactions that can be matched to a recurring item without asking (D29): same
 * account, recognized by payee or bank text, an amount that fits, within the item's dates, and
 * one-to-one — a transaction with two possible occurrences, or an occurrence with two possible
 * transactions, is left for the user.
 */
export function pickImportMatches(
  txs: readonly ImportedTransaction[],
  occurrences: readonly PendingOccurrence[],
): { transactionId: string; occurrenceId: string; score: number }[] {
  const pairs = txs.flatMap((tx) =>
    occurrences
      .filter((occ) => occ.schedule.accountId === tx.accountId)
      .map((occ) => ({ tx, occ, ...scoreMatch(tx, occ, occ.schedule) }))
      .filter((p) => p.score > 0 && p.payeeScore > 0 && p.amountScore > 0),
  );
  const perTx = new Map<string, number>();
  const perOcc = new Map<string, number>();
  for (const p of pairs) {
    perTx.set(p.tx.id, (perTx.get(p.tx.id) ?? 0) + 1);
    perOcc.set(p.occ.id, (perOcc.get(p.occ.id) ?? 0) + 1);
  }
  return pairs
    .filter((p) => perTx.get(p.tx.id) === 1 && perOcc.get(p.occ.id) === 1)
    .map((p) => ({ transactionId: p.tx.id, occurrenceId: p.occ.id, score: p.score }));
}
