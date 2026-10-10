import { format, isValid, parseISO } from 'date-fns';
import type { ExchangeRate } from '../types';

// Settings → Currencies (docs/multi-currency): the wording and checks behind the rates screen.
// Pure, so the same text shows everywhere and the rules can be tested.

/** The largest rate the server accepts */
export const MAX_RATE = 1e9;

const rateNumber = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const countNumber = new Intl.NumberFormat('en-US');
const listWords = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** "1 GBP = 1.1798 EUR": one `base` is `rate` `quote` (the budget's currency) */
export function rateText(base: string, quote: string, rate: number): string {
  return `1 ${base} = ${rateNumber.format(rate)} ${quote}`;
}

/** "Oct 9, 2026", or the text itself when it isn't a day */
export function dayText(day: string): string {
  const date = parseISO(day);
  return isValid(date) ? format(date, 'MMM d, yyyy') : day;
}

/** "1 GBP = 1.1798 EUR on Oct 9, 2026", or "No rate yet" */
export function latestRateText(
  base: string,
  quote: string,
  latest: { rate: number; date: string } | null,
): string {
  if (!latest) return 'No rate yet';
  return `${rateText(base, quote, latest.rate)} on ${dayText(latest.date)}`;
}

/** "1 account", "2 accounts" */
export function accountCountText(count: number): string {
  return count === 1 ? '1 account' : `${countNumber.format(count)} accounts`;
}

/** Transactions still waiting for a rate, or null when none are */
export function waitingText(count: number): string | null {
  if (!(count > 0)) return null;
  if (count === 1) return '1 transaction is waiting for a rate';
  return `${countNumber.format(count)} transactions are waiting for a rate`;
}

/** Where a rate came from, as shown next to it */
export function rateSourceLabel(source: ExchangeRate['source']): string {
  return source === 'ecb' ? 'Downloaded' : 'Typed in';
}

/** When the rates were last downloaded, from `ratesUpdatedAt` */
export function ratesUpdatedText(updatedAt: string | null): string {
  if (!updatedAt) return 'Not downloaded yet';
  const date = new Date(updatedAt);
  return isValid(date) ? `Last updated ${format(date, "MMM d, yyyy 'at' HH:mm")}` : 'Last updated';
}

/** Whether `text` is a calendar day as the server sends it: yyyy-MM-dd */
export function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = parseISO(text);
  return isValid(date) && format(date, 'yyyy-MM-dd') === text;
}

/** Today's day (yyyy-MM-dd) for the date field */
export function todayDay(now: Date = new Date()): string {
  return format(now, 'yyyy-MM-dd');
}

// Plain decimal numbers, as a number input gives them (no hex, no signs, no spaces inside)
const RATE_TEXT = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A rate typed in: a number above zero (and at most MAX_RATE), otherwise null */
export function parseRate(text: string): number | null {
  const trimmed = text.trim();
  if (!RATE_TEXT.test(trimmed)) return null;
  const rate = Number(trimmed);
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_RATE ? rate : null;
}

/** Checks the form before a rate is saved: a real day and a rate above zero */
export function checkRateEntry(
  day: string,
  rateText: string,
): { ok: true; date: string; rate: number } | { ok: false; error: string } {
  if (!isDay(day)) return { ok: false, error: 'Pick a date for the rate.' };
  const rate = parseRate(rateText);
  if (rate === null) return { ok: false, error: 'Enter a rate above zero, such as 1.1798.' };
  return { ok: true, date: day, rate };
}

/** The codes the ECB doesn't publish rates for, from `ratesError` ('unsupported:ARS,KES') */
export function unsupportedCurrencies(error: string | null): string[] {
  if (!error?.startsWith('unsupported:')) return [];
  return error
    .slice('unsupported:'.length)
    .split(',')
    .filter((code) => /^[A-Z]{3}$/.test(code));
}

export type RatesProblem =
  { kind: 'unreachable' } | { kind: 'unsupported'; codes: string[] } | { kind: 'unknown' };

/** What went wrong with the last download, or null when nothing did */
export function ratesProblem(error: string | null): RatesProblem | null {
  if (!error) return null;
  if (error === 'unreachable') return { kind: 'unreachable' };
  const codes = unsupportedCurrencies(error);
  if (codes.length > 0) return { kind: 'unsupported', codes };
  return { kind: 'unknown' };
}

const UNREACHABLE_TEXT =
  "Couldn't reach the rates service. FlyBudget tries again when it starts, or you can update now.";

function unsupportedText(codes: readonly string[]): string {
  return `The European Central Bank doesn't publish rates for ${listWords.format(codes)}. Enter their rates below.`;
}

/** The message for `ratesError`, or null when there's nothing to say */
export function ratesErrorText(error: string | null): string | null {
  const problem = ratesProblem(error);
  if (!problem) return null;
  if (problem.kind === 'unreachable') return UNREACHABLE_TEXT;
  if (problem.kind === 'unsupported') return unsupportedText(problem.codes);
  return "Some rates couldn't be downloaded. Try again with Update now.";
}

/** What a download did, for the line under the switch */
export function downloadSummaryText(result: {
  downloaded: number;
  error: string | null;
  unsupported: readonly string[];
}): string {
  const parts: string[] = [];
  if (result.downloaded > 0) {
    parts.push(
      result.downloaded === 1
        ? 'Downloaded 1 rate.'
        : `Downloaded ${countNumber.format(result.downloaded)} rates.`,
    );
  }
  if (result.error) parts.push(UNREACHABLE_TEXT);
  if (result.unsupported.length > 0) parts.push(unsupportedText(result.unsupported));
  return parts.length > 0 ? parts.join(' ') : 'The rates are up to date.';
}

/** What the confirmation says before the budget's currency changes */
export function budgetCurrencyChangeText(from: string, to: string): string {
  return `The budget will be in ${to}. Accounts in ${to} count as the budget's currency from now on, and accounts in ${from} keep ${from}, so no money changes. Amounts you typed in for conversions are reset, and every conversion is worked out again.`;
}
