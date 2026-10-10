import type { Account } from '../types';

// Totals add up one currency, the budget's. An account in another currency counts at its balance
// at the latest rate (`budgetBalance`, docs/multi-currency M6). Without a rate it's left out.

type Valued = Pick<Account, 'balance' | 'currency' | 'budgetBalance'>;

/**
 * An account's balance in the budget's currency: the balance itself for an account in the
 * budget's currency, the balance at the latest rate for another one. Null when that account
 * has no rate.
 */
export function valueInBudget(account: Valued): number | null {
  if (!account.currency) return account.balance;
  return typeof account.budgetBalance === 'number' ? account.budgetBalance : null;
}

/** Sum of the accounts' values in the budget's currency. Accounts without a value add nothing. */
export function totalInBudget(accounts: Valued[]): number {
  let total = 0;
  for (const account of accounts) total += valueInBudget(account) ?? 0;
  return total;
}

/**
 * An account's balance a month ago, in the budget's currency at today's rate. The rate is the
 * one implied by the balance now, so the change is only what moved, not what the exchange rate
 * did. Null when there's no rate, or no balance now to take the rate from.
 */
export function valueAgoInBudget(account: Valued, balanceAgo: number): number | null {
  if (!account.currency) return balanceAgo;
  const now = valueInBudget(account);
  if (now === null || account.balance === 0) return null;
  return Math.round((balanceAgo * now) / account.balance);
}

/**
 * How much the accounts' values changed since their balances a month ago, counting only the
 * accounts whose value can be compared both times. `base` is the earlier total of those accounts,
 * for a percentage.
 */
export function changeInBudget(
  accounts: (Valued & { id: string })[],
  balancesAgo: Record<string, number>,
): { change: number; base: number } {
  let now = 0;
  let base = 0;
  for (const account of accounts) {
    const before = valueAgoInBudget(account, balancesAgo[account.id] ?? account.balance);
    const value = valueInBudget(account);
    if (before === null || value === null) continue;
    now += value;
    base += before;
  }
  return { change: now - base, base };
}

/** Accounts in another currency with no rate yet: they're left out of every total */
export function accountsWithoutRate<T extends Valued>(accounts: T[]): T[] {
  return accounts.filter((account) => valueInBudget(account) === null);
}
