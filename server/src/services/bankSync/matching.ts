// Pure decisions for importing bank transactions (docs/enable-banking/decisions.md D5, D6).
// No database or clock: callers pass the candidates, so the same logic can run anywhere.

/** An import merges into a transaction typed in up to this many days before or after it */
export const MATCH_WINDOW_DAYS = 10;
/** The two sides of a transfer between the user's own accounts book within this many days */
export const TRANSFER_WINDOW_DAYS = 4;

/** Whole days between two YYYY-MM-DD dates, ignoring order */
export function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
}

export type ManualCandidate = { id: string; date: string; amount: number; createdAt: string };

/**
 * The typed-in transaction an imported one should merge into instead of being added: same
 * amount, within MATCH_WINDOW_DAYS, closest date first, then the oldest row. Null if none.
 */
export function pickManualMatch(
  imported: { date: string; amount: number },
  candidates: ManualCandidate[],
): string | null {
  const best = candidates
    .filter(
      (c) =>
        c.amount === imported.amount && daysBetween(c.date, imported.date) <= MATCH_WINDOW_DAYS,
    )
    .map((c) => ({ c, days: daysBetween(c.date, imported.date) }))
    .sort(
      (x, y) =>
        x.days - y.days ||
        x.c.createdAt.localeCompare(y.c.createdAt) ||
        x.c.id.localeCompare(y.c.id),
    )[0];
  return best?.c.id ?? null;
}

export type TransferCandidate = { id: string; accountId: string; date: string; amount: number };

export type TransferQuery = {
  accountId: string;
  date: string;
  amount: number;
  /** The user's account the bank says the money went to or came from (by IBAN), if any */
  counterpartyAccountId: string | null;
  /** Other unlinked transactions in this account with the same amount within the window */
  siblings: number;
};

/**
 * The other side of a transfer between the user's own accounts: an opposite amount in another
 * account within TRANSFER_WINDOW_DAYS. When the bank names the other account, only that
 * account counts and its closest candidate wins (if no other one there is as close). Otherwise
 * it must be the only candidate, and this transaction the only one of its amount here.
 * Anything ambiguous: null.
 */
export function pickTransferCounterpart(
  query: TransferQuery,
  candidates: TransferCandidate[],
): string | null {
  if (query.amount === 0) return null;
  const eligible = candidates.filter(
    (c) =>
      c.accountId !== query.accountId &&
      c.amount === -query.amount &&
      daysBetween(c.date, query.date) <= TRANSFER_WINDOW_DAYS,
  );

  if (query.counterpartyAccountId) {
    const named = eligible
      .filter((c) => c.accountId === query.counterpartyAccountId)
      .map((c) => ({ id: c.id, days: daysBetween(c.date, query.date) }))
      .sort((a, b) => a.days - b.days);
    // Its other side may simply not be imported yet: never pair it with a different account
    if (!named.length || (named.length > 1 && named[0].days === named[1].days)) return null;
    return named[0].id;
  }

  return eligible.length === 1 && query.siblings === 0 ? eligible[0].id : null;
}
