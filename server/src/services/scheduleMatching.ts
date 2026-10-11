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

/** The most days a recurring item's transactions may be from their expected date */
export const MAX_DATE_FLEXIBILITY = 14;

/**
 * How an amount fits an item's expected one: `exact`; `close` (approximate within 10%, variable
 * within 25%); `loose` (variable, in the right direction but further from the usual).
 */
export type AmountFit = 'exact' | 'close' | 'loose';

const AMOUNT_POINTS: Record<AmountFit, number> = { exact: 30, close: 20, loose: 10 };

/**
 * How the amount fits, by the item's amount type: exact must be exact; approximate within 10%;
 * variable can be anything in the same direction. null = doesn't fit.
 */
export function amountFit(amountType: string, amount: number, expected: number): AmountFit | null {
  if (amount === 0 || expected === 0 || Math.sign(amount) !== Math.sign(expected)) {
    return amount === expected ? 'exact' : null;
  }
  const diff = Math.abs(amount - expected);
  const ratio = diff / Math.abs(expected);
  if (diff === 0) return 'exact';
  if (amountType === 'approximate') return ratio <= 0.1 ? 'close' : null;
  if (amountType === 'variable') return ratio <= 0.25 ? 'close' : 'loose';
  return null;
}

/** Whether the bank's text (or the payee or notes) contains the item's match text */
export function textMatches(tx: MatchTransaction, matchText: string | null | undefined): boolean {
  const needle = matchText?.trim().toLowerCase();
  if (!needle) return false;
  return [tx.importedPayee, tx.payeeName, tx.notes].some((t) => t?.toLowerCase().includes(needle));
}

/**
 * Whether the item's payee or its bank text says who the transaction is. Only that recognizes an
 * item; a similar name adds points to a suggestion but never matches on its own (D29).
 */
export function recognizes(tx: MatchTransaction, schedule: MatchSchedule): boolean {
  return (
    (!!schedule.payeeId && tx.payeeId === schedule.payeeId) || textMatches(tx, schedule.matchText)
  );
}

/** Points for recognizing who it is: the item's payee, its bank text, or a similar name */
export function identityScore(tx: MatchTransaction, schedule: MatchSchedule): number {
  if (recognizes(tx, schedule)) return 25;
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
  const fit = amountFit(schedule.amountType, tx.amount, occ.expectedAmount);
  if (!fit) return none;

  const payeeScore = identityScore(tx, schedule);
  // A variable amount far from the usual one only counts when the payee or bank text says who
  if (fit === 'loose' && !recognizes(tx, schedule)) return none;
  let accountScore = 0;
  if (schedule.accountId && tx.accountId === schedule.accountId) accountScore = 15;
  else if (!schedule.accountId) accountScore = 5;

  const amount = AMOUNT_POINTS[fit];
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
      // A score means the dates and the amount fit; the payee or bank text must say who it is
      .filter((p) => p.score > 0 && recognizes(p.tx, p.occ.schedule)),
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
