import { formatCurrency } from '../../utils/currency';
import {
  addMonths,
  addYears,
  differenceInCalendarDays,
  endOfMonth,
  parseISO,
  startOfMonth,
} from 'date-fns';
import {
  RECURRENCE_TYPE_LABELS,
  type Account,
  type AmountType,
  type OccurrenceDisplayStatus,
  type Schedule,
  type ScheduleOccurrence,
} from '../../types';
import type { RecurringBadgeStatus } from './StatusBadge';

export const FREQ_LABEL = new Map(RECURRENCE_TYPE_LABELS.map((f) => [f.value, f.label]));

/**
 * Query-data defaults. A fresh `[]` per render would make every memo and effect that reads
 * the data run again while it loads, so the defaults are shared constants instead.
 */
export const NO_ACCOUNTS: Account[] = [];
export const NO_SCHEDULES: Schedule[] = [];

/**
 * Actual-style amount: `~` prefix when not exact, `+` prefix for income. `currency` is the
 * item's account's own currency (null or omitted = the budget's).
 */
export function formatScheduleAmount(
  amount: number,
  amountType: AmountType,
  currency?: string | null,
): string {
  const approx = amountType !== 'exact' ? '~' : '';
  const sign = amount > 0 ? '+' : '';
  return `${approx}${sign}${formatCurrency(Math.abs(amount), currency)}`;
}

/**
 * Each account's own currency by id (null = the budget's), for formatCurrency. Unknown or
 * missing accounts (no account, or a closed one, which the accounts list leaves out) give null.
 */
export function accountCurrencyLookup(
  accounts: readonly Pick<Account, 'id' | 'currency'>[],
): (accountId: string | null | undefined) => string | null {
  const byId = new Map(accounts.map((a) => [a.id, a.currency]));
  return (accountId) => (accountId ? byId.get(accountId) : undefined) ?? null;
}

// ─── Upcoming length (port of Actual Budget's getUpcomingDays) ───────────────

export const DEFAULT_UPCOMING_LENGTH = '7';

export const UPCOMING_PRESETS: { value: string; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '1 week' },
  { value: '14', label: '2 weeks' },
  { value: 'oneMonth', label: '1 month' },
  { value: 'currentMonth', label: 'End of the current month' },
];

export const isCustomUpcomingLength = (v: string) => !UPCOMING_PRESETS.some((p) => p.value === v);

/** Number of days after today that still count as "upcoming". */
export function getUpcomingDays(
  length: string = DEFAULT_UPCOMING_LENGTH,
  today = new Date(),
): number {
  switch (length) {
    case 'currentMonth':
      return differenceInCalendarDays(endOfMonth(today), today);
    case 'oneMonth':
      return differenceInCalendarDays(addMonths(startOfMonth(today), 1), startOfMonth(today));
    default: {
      if (length.includes('-')) {
        const [num, unit] = length.split('-');
        const value = Math.max(1, parseInt(num, 10) || 1);
        switch (unit) {
          case 'day':
            return value;
          case 'week':
            return value * 7;
          case 'month':
            return differenceInCalendarDays(addMonths(today, value), today);
          case 'year':
            return differenceInCalendarDays(addYears(today, value), today);
        }
      }
      return parseInt(length, 10) || 7;
    }
  }
}

export function describeUpcomingLength(length: string): string {
  const preset = UPCOMING_PRESETS.find((p) => p.value === length);
  if (preset) return preset.label;
  const [num, unit] = length.split('-');
  const n = Math.max(1, parseInt(num, 10) || 1);
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Badge status for an occurrence, following Actual's getStatus(): pending dates
 * beyond the upcoming window show as "Scheduled" instead of "Upcoming".
 */
export function occurrenceBadgeStatus(
  occ: ScheduleOccurrence,
  upcomingDays: number,
): RecurringBadgeStatus {
  if (
    occ.displayStatus === 'upcoming' &&
    differenceInCalendarDays(parseISO(occ.expectedDate), new Date()) > upcomingDays
  )
    return 'scheduled';
  return occ.displayStatus;
}

// ─── Monthly summary totals (per currency) ───────────────────────────────────

/** The part of an occurrence the monthly summary adds up */
export interface SummaryItem {
  expectedAmount: number;
  matchedAmount: number | null;
  displayStatus: OccurrenceDisplayStatus;
}

export interface Totals {
  total: number;
  paid: number;
  remaining: number;
}

/**
 * Paid uses the actual matched amount; remaining uses the expected amount of unpaid items.
 * Skipped and canceled items don't count.
 */
export function computeTotals(items: readonly SummaryItem[]): Totals {
  let paid = 0;
  let remaining = 0;
  for (const o of items) {
    if (o.displayStatus === 'skipped' || o.displayStatus === 'cancelled') continue;
    if (o.displayStatus === 'paid') paid += Math.abs(o.matchedAmount ?? o.expectedAmount);
    else remaining += Math.abs(o.expectedAmount);
  }
  return { total: paid + remaining, paid, remaining };
}

export interface CurrencyGroup<T> {
  currency: string;
  items: T[];
}

/**
 * Splits items by the currency their amounts are in. Items in the budget's currency come back
 * as `budget`; the rest are grouped by code (sorted), so they never add into the budget's sums.
 */
export function splitByCurrency<T>(
  items: readonly T[],
  currencyOf: (item: T) => string,
  budget: string,
): { budget: T[]; others: CurrencyGroup<T>[] } {
  const own: T[] = [];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const currency = currencyOf(item);
    if (currency === budget) {
      own.push(item);
      continue;
    }
    const list = groups.get(currency);
    if (list) list.push(item);
    else groups.set(currency, [item]);
  }
  const others = [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, list]) => ({ currency, items: list }));
  return { budget: own, others };
}

export interface CurrencySummary {
  /** The budget's currency only: this is what the headline figures show */
  totals: Totals;
  /** One entry per other currency with something to show */
  others: { currency: string; totals: Totals }[];
}

export function summarizeByCurrency<T extends SummaryItem>(
  items: readonly T[],
  currencyOf: (item: T) => string,
  budget: string,
): CurrencySummary {
  const split = splitByCurrency(items, currencyOf, budget);
  return {
    totals: computeTotals(split.budget),
    others: split.others
      .map((g) => ({ currency: g.currency, totals: computeTotals(g.items) }))
      .filter((o) => o.totals.total > 0),
  };
}

const plainAmount = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "1,200.00": an amount with no symbol or code, for a line that already names its currency */
export function formatPlainAmount(cents: number): string {
  return plainAmount.format(cents / 100);
}

/** "GBP: 1,200.00 of 2,400.00 received" (or "paid"): one currency's line under the summary */
export function describeCurrencyTotals(currency: string, totals: Totals, verb: string): string {
  return `${currency}: ${formatPlainAmount(totals.paid)} of ${formatPlainAmount(totals.total)} ${verb}`;
}
