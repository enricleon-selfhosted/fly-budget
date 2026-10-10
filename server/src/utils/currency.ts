import { z } from 'zod';

// A budget has one currency (like YNAB). Accounts in another currency keep it in
// `accounts.currency`; null means the budget's currency, so the server can tell them apart
// without knowing which currency the budget uses. Without exchange rates their money can't
// be budgeted or added to the rest, so they stay off budget and out of net worth totals.

export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code such as EUR');

/** The value to store for an account in `currency` when the budget uses `budgetCurrency` */
export function storedCurrency(currency: string | null, budgetCurrency: string): string | null {
  return currency && currency !== budgetCurrency ? currency : null;
}

/** The currency an account's amounts are in */
export function accountCurrency(stored: string | null, budgetCurrency: string): string {
  return stored ?? budgetCurrency;
}

/** Accounts in another currency are always off budget (1); others keep what was asked */
export function offBudgetFor(stored: string | null, requested: 0 | 1): 0 | 1 {
  return stored ? 1 : requested;
}
