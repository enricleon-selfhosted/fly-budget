// all money is integer cents — convert at the UI edges only
import { usePreferencesStore } from '../store/preferencesStore';

export function centsToInput(cents: number): string {
  return cents === 0 ? '' : (Math.abs(cents) / 100).toFixed(2);
}

export function parseCents(s: string): number {
  const cents = Math.round(parseFloat(s) * 100);
  // NaN, Infinity (e.g. "1e400"), and amounts too large to store exactly are invalid
  return Number.isSafeInteger(cents) ? cents : 0;
}

function getCurrencySymbol(): string {
  return usePreferencesStore.getState().currencySymbol || '$';
}

// Made once: toLocaleString builds a new formatter on every call, and charts format thousands
const wholeDollars = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const withCents = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// null: the code isn't valid for Intl (not three letters), so the amount is formatted by hand
const foreignFormatters = new Map<string, Intl.NumberFormat | null>();

/**
 * Amounts of an account in another currency than the budget's, e.g. "CHF 1,234.50". The code
 * is shown rather than a symbol, so "USD" can't be mistaken for the budget's "$". Always two
 * decimals: amounts are hundredths in every currency (D12), even for currencies with none.
 */
function formatForeign(cents: number, currency: string): string {
  let formatter = foreignFormatters.get(currency);
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      formatter = null;
    }
    foreignFormatters.set(currency, formatter);
  }
  if (!formatter) {
    return `${cents < 0 ? '-' : ''}${currency} ${withCents.format(Math.abs(cents) / 100)}`;
  }
  return formatter.format(cents / 100 || 0);
}

/**
 * `currency` is an account's own currency (`Account.currency`): set only for accounts in another
 * currency than the budget's. Without it, amounts use the budget's currency symbol.
 */
export function formatCurrency(cents: number, currency?: string | null): string {
  if (currency) return formatForeign(cents, currency);
  const sym = getCurrencySymbol();
  const abs = Math.abs(cents);
  const formatted = (abs % 100 === 0 ? wholeDollars : withCents).format(abs / 100);
  return cents < 0 ? `-${sym}${formatted}` : `${sym}${formatted}`;
}

const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);

/** Short axis label: "$950", "$12.5k", "-$1.2M". Thresholds sit where rounding would reach the next unit. */
export function formatCentsAxis(cents: number): string {
  const sym = getCurrencySymbol();
  const sign = cents < 0 ? '-' : '';
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 999_950) return `${sign}${sym}${oneDecimal(dollars / 1_000_000)}M`;
  if (dollars >= 999.5) return `${sign}${sym}${oneDecimal(dollars / 1_000)}k`;
  return `${sign}${sym}${Math.round(dollars)}`;
}
