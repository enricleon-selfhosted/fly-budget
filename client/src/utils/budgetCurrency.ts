import { usePreferencesStore } from '../store/preferencesStore';

// A budget has one currency. Accounts in another one store its ISO code (`Account.currency`);
// null means the budget's. Until the user picks the budget currency in Preferences, it is
// guessed from the currency symbol they chose.

/** Currencies offered in Preferences and on accounts (the budget's and any others) */
export const CURRENCY_CODES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'ISK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'BGN',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'MXN',
  'BRL',
  'INR',
  'ZAR',
] as const;

// A Map, not an object: `obj['constructor']` would find Object.prototype's members
const CODE_FOR_SYMBOL = new Map<string, string>([
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['kr', 'SEK'],
  ['zł', 'PLN'],
  ['Fr', 'CHF'],
  ['CHF', 'CHF'],
  ['R$', 'BRL'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['₺', 'TRY'],
  ['Kč', 'CZK'],
  ['Ft', 'HUF'],
  ['lei', 'RON'],
]);

/** The budget's ISO 4217 currency code */
export function budgetCurrency(code: string | null, symbol: string): string {
  if (code) return code;
  return CODE_FOR_SYMBOL.get(symbol.trim()) ?? 'USD';
}

export function useBudgetCurrency(): string {
  const code = usePreferencesStore((s) => s.currencyCode);
  const symbol = usePreferencesStore((s) => s.currencySymbol);
  return budgetCurrency(code, symbol);
}

/** The currency an account's amounts are in */
export function accountCurrency(account: { currency: string | null }, budget: string): string {
  return account.currency ?? budget;
}

/** Whether an account is in another currency than the budget's */
export const isForeignCurrency = (account: { currency: string | null }) =>
  account.currency !== null;

/**
 * The codes an account can be in when it isn't the budget's: the common ones minus the budget's.
 * An account's current code is kept in the list even when it isn't a common one.
 */
export function otherCurrencyCodes(budget: string, current: string | null): string[] {
  const codes = CURRENCY_CODES.filter((code) => code !== budget) as string[];
  if (current && current !== budget && !codes.includes(current)) codes.push(current);
  return codes;
}
