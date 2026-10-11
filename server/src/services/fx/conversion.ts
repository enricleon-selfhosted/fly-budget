// Converting amounts in an account's own currency to the budget's (docs/multi-currency M3, M4).
// Pure: callers pass the rates and rows; the database side is fxService.ts.

/** Where a transaction's rate came from, strongest first */
export const FX_SOURCES = ['manual', 'exchange', 'rate'] as const;
export type FxSource = (typeof FX_SOURCES)[number];

/** A transaction's rate to the budget currency, or null when it has none */
export type FxChoice = { rate: number; source: FxSource } | null;

/** One day's rate of a currency pair: 1 base = `rate` quote */
export type DailyRate = { date: string; rate: number; source: 'ecb' | 'manual' };

/** A downloaded rate this many days older than the transaction still applies (weekends, holidays) */
export const MAX_RATE_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * `amount` converted at `rate`, in whole hundredths, rounded half away from zero exactly like
 * SQLite's `round()` does, so this matches the `budgetValue` the database adds up.
 */
export function convertCents(amount: number, rate: number): number {
  const value = Math.trunc(Math.abs(amount) * rate + 0.5);
  return amount < 0 && value !== 0 ? -value : value;
}

/**
 * The rate that converts `amount` into exactly `target` (an exchange's other side, or an amount
 * typed in the budget currency). Null when either is zero.
 */
export function impliedRate(amount: number, target: number): number | null {
  if (amount === 0 || target === 0) return null;
  return Math.abs(target) / Math.abs(amount);
}

/**
 * The rate that applies on `date`: the latest one on or before it. A rate typed in applies until
 * the next one; a downloaded rate only up to MAX_RATE_AGE_DAYS later, so a stopped download
 * doesn't quietly convert months of transactions at an old rate. `rates` sorted by date.
 */
export function rateOn(rates: readonly DailyRate[], date: string): number | null {
  let lo = 0;
  let hi = rates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rates[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const r = rates[found];
  if (r.source === 'ecb' && dayNumber(date) - dayNumber(r.date) > MAX_RATE_AGE_DAYS) return null;
  return r.rate;
}

/**
 * The latest rate on or before `date`, however old: what a balance is shown at when the rates
 * stopped (M6). `rates` sorted by date.
 */
export function latestRateOn(
  rates: readonly DailyRate[],
  date: string,
): { rate: number; date: string } | null {
  for (let i = rates.length - 1; i >= 0; i--) {
    if (rates[i].date <= date) return { rate: rates[i].rate, date: rates[i].date };
  }
  return null;
}

/** What decides a transaction's rate */
export type FxInput = {
  amount: number;
  date: string;
  /** What it has now: a rate typed in is kept */
  current: { rate: number | null; source: string | null };
  /** For a split part: its parent's rate, which the parts share */
  parent?: FxChoice;
  /** For one side of a transfer whose other side is in the budget currency: that side's amount */
  exchangeOther?: number | null;
  /** The pair's rate on a date (see rateOn) */
  lookup: (date: string) => number | null;
};

/**
 * For one side of a transfer: the other side's amount when that side is in the budget's currency
 * (an exchange, converted exactly), else null. `foreign` maps accounts in another currency to it.
 */
export function exchangeOtherAmount(
  other: { accountId: string; amount: number } | undefined,
  foreign: ReadonlyMap<string, string>,
): number | null {
  return other && !foreign.has(other.accountId) ? other.amount : null;
}

/** What decides whether a transaction's value in the budget currency can be typed in */
export type BudgetAmountRow = {
  amount: number;
  /** In an account in another currency than the budget's */
  inForeignAccount: boolean;
  /** A split part: parts follow their parent's rate */
  isSplitPart: boolean;
  /** One side of an exchange whose other side is in the budget's currency: exact already */
  exchangeIntoBudget: boolean;
};

/**
 * Why `budgetAmount` can't be typed in as a transaction's value in the budget currency (M3), or
 * null when it can. `null` goes back to the day's rate, which only split parts can't do.
 */
export function budgetAmountProblem(
  row: BudgetAmountRow,
  budgetAmount: number | null,
): { status: 400; error: string } | null {
  const refuse = (error: string) => ({ status: 400 as const, error });
  if (!row.inForeignAccount) return refuse('This account is in the budget’s currency');
  if (row.isSplitPart) return refuse('Split parts use the rate of the whole transaction');
  if (budgetAmount === null) return null;
  if (row.exchangeIntoBudget) return refuse('The amount comes from the exchange');
  if (
    impliedRate(row.amount, budgetAmount) === null ||
    Math.sign(budgetAmount) !== Math.sign(row.amount)
  ) {
    return refuse('Enter an amount in the same direction as the transaction');
  }
  return null;
}

/**
 * A transaction's rate, by the order of M3: an exchange into the budget's currency (exact, and
 * never typed over: a value typed in before it was linked no longer applies), typed in, then the
 * day's rate
 */
export function pickFxRate(input: FxInput): FxChoice {
  if (input.parent !== undefined) return input.parent;
  if (input.exchangeOther != null) {
    const exact = impliedRate(input.amount, input.exchangeOther);
    if (exact !== null) return { rate: exact, source: 'exchange' };
  }
  const { current } = input;
  if (current.source === 'manual' && current.rate !== null && current.rate > 0) {
    return { rate: current.rate, source: 'manual' };
  }
  const rate = input.lookup(input.date);
  return rate === null ? null : { rate, source: 'rate' };
}

/** The id of a pair's rate on a date: the same row on every device */
export const rateId = (base: string, quote: string, date: string) => `${base}${quote}:${date}`;

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * The date ranges to download so a pair has rates from `from` to `today`, given the first and
 * last dates already downloaded (null when none). Each range starts a week early: the service
 * answers with business days only, so a weekend start would otherwise have no rate.
 */
export function downloadRanges(
  have: { first: string; last: string } | null,
  from: string,
  today: string,
): { from: string; to: string }[] {
  if (from > today) return [];
  const early = (date: string) => isoDay(dayNumber(date) - MAX_RATE_AGE_DAYS);
  if (!have) return [{ from: early(from), to: today }];
  const ranges: { from: string; to: string }[] = [];
  if (from < have.first) ranges.push({ from: early(from), to: isoDay(dayNumber(have.first) - 1) });
  if (have.last < today) ranges.push({ from: isoDay(dayNumber(have.last) + 1), to: today });
  return ranges;
}
