import { z } from 'zod';

// A budget has one currency (like YNAB), stored in `budget_settings`. Accounts in another
// currency keep it in `accounts.currency`; null means the budget's, so a change of budget
// currency only re-labels accounts (docs/multi-currency M2). Their transactions are converted to
// the budget's currency at a rate (services/fx/), and they can be on or off budget (M1).

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

/**
 * Whether a new account starts off budget: what was asked; otherwise off for an account in
 * another currency, so it doesn't change the budget until the user says so (M1), and by its type
 * for the rest.
 */
export function startsOffBudget(
  stored: string | null,
  requested: 0 | 1 | undefined,
  byType: 0 | 1,
): 0 | 1 {
  return requested ?? (stored ? 1 : byType);
}
