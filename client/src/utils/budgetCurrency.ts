import { usePreferencesStore } from '../store/preferencesStore';

// A budget has one currency. Accounts in another one store its ISO code (`Account.currency`);
// null means the budget's. Until the user picks the budget currency in Preferences, it is
// guessed from the currency symbol they chose.

const CODE_FOR_SYMBOL: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  kr: 'SEK',
  zł: 'PLN',
  Fr: 'CHF',
  CHF: 'CHF',
  R$: 'BRL',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  Kč: 'CZK',
  Ft: 'HUF',
  lei: 'RON',
};

/** The budget's ISO 4217 currency code */
export function budgetCurrency(code: string | null, symbol: string): string {
  return code ?? CODE_FOR_SYMBOL[symbol.trim()] ?? 'USD';
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
