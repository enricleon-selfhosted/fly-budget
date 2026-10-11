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

export type TransferCandidate = {
  id: string;
  accountId: string;
  /** Its account's stored currency (null = the budget's) */
  currency: string | null;
  date: string;
  amount: number;
};

export type TransferQuery = {
  accountId: string;
  /** This account's stored currency (null = the budget's) */
  currency: string | null;
  date: string;
  amount: number;
  /** The user's account the bank says the money went to or came from (by IBAN), if any */
  counterpartyAccountId: string | null;
  /** Other unlinked transactions in this account with the same amount within the window */
  siblings: number;
};

/**
 * The other side of a transfer between the user's own accounts: an opposite amount in another
 * account in the same currency, within TRANSFER_WINDOW_DAYS. When the bank names the other
 * account, only that account counts and its closest candidate wins (if no other one there is as
 * close). Otherwise it must be the only candidate, and this transaction the only one of its
 * amount here. Anything ambiguous: null.
 */
export function pickTransferCounterpart(
  query: TransferQuery,
  candidates: TransferCandidate[],
): string | null {
  if (query.amount === 0) return null;
  const eligible = candidates.filter(
    (c) =>
      c.accountId !== query.accountId &&
      // One amount on both sides only within a currency, like `sameCurrency` in
      // utils/transferRules.ts; across currencies it's an exchange (pickExchangeCounterpart)
      c.currency === query.currency &&
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

/** The two sides of a currency exchange book on the same day, or the next */
export const EXCHANGE_WINDOW_DAYS = 1;

/** Whether bank text names a currency, e.g. "Exchanged to EUR" names EUR (not "Eurostar") */
export function mentionsCurrency(text: string, currency: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${currency}([^A-Za-z]|$)`, 'i').test(text);
}

export type ExchangeCandidate = {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  /** The bank's text for it (imported payee and notes) */
  text: string;
};

export type ExchangeQuery = {
  accountId: string;
  /** This account's currency */
  currency: string;
  date: string;
  amount: number;
  text: string;
  /** The user's other accounts at the same bank, with their currencies */
  partners: ReadonlyMap<string, string>;
  /** Other unlinked transactions in this account that could be the same exchange */
  siblings: number;
};

/**
 * The other side of a currency exchange at the same bank (decision D27): an account in another
 * currency, the opposite direction, at most a day apart, and the bank text of each side naming the
 * other side's currency ("Exchanged to EUR" / "Exchanged from GBP"): one side alone could be a card
 * payment abroad ("CAFE PARIS 14.00 EUR"). It must be the only candidate, and this the only
 * transaction here that could be it. Anything ambiguous: null (the user can link it by hand).
 */
export function pickExchangeCounterpart(
  query: ExchangeQuery,
  candidates: ExchangeCandidate[],
): string | null {
  if (query.amount === 0 || query.siblings > 0) return null;
  const eligible = candidates.filter((c) => {
    const currency = query.partners.get(c.accountId);
    return (
      currency !== undefined &&
      c.accountId !== query.accountId &&
      currency !== query.currency &&
      c.amount !== 0 &&
      Math.sign(c.amount) === -Math.sign(query.amount) &&
      daysBetween(c.date, query.date) <= EXCHANGE_WINDOW_DAYS &&
      mentionsCurrency(query.text, currency) &&
      mentionsCurrency(c.text, query.currency)
    );
  });
  return eligible.length === 1 ? eligible[0].id : null;
}

/**
 * How many other transactions in this account (`here`, around the same date) could be the same
 * exchange as transaction `id`: the same direction, and bank text naming another currency at the
 * bank. Any of them makes pairing it a guess.
 */
export function exchangeSiblings(
  here: readonly ExchangeCandidate[],
  id: string,
  amount: number,
  currency: string,
  partners: ReadonlyMap<string, string>,
): number {
  return here.filter(
    (c) =>
      c.id !== id &&
      Math.sign(c.amount) === Math.sign(amount) &&
      looksLikeExchange(c.text, currency, partners),
  ).length;
}

/** Whether a transaction's text names any of the other currencies at its bank */
export function looksLikeExchange(
  text: string,
  currency: string,
  partners: ReadonlyMap<string, string>,
): boolean {
  return [...partners.values()].some((c) => c !== currency && mentionsCurrency(text, c));
}
