import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { defaultOffBudget, type AccountType } from '../utils/accountTypes.js';
import { offBudgetFor } from '../utils/currency.js';
import { accountTransactionSum } from './balances.js';

// Creating accounts, and one account's balance. The accounts API and bank connections both
// come here, so the rules have one owner: accounts start on or off budget by their type, and an
// account in another currency is always off budget (utils/currency.ts).

export type Account = typeof accounts.$inferSelect;

export type NewAccount = {
  name: string;
  type: AccountType;
  startingBalance?: number;
  /** Unset: by its type. An account in another currency is off budget either way */
  isOffBudget?: 0 | 1;
  /** Only for an account in another currency than the budget's (null = the budget's) */
  currency?: string | null;
  logo?: string | null;
};

function findAccount(id: string): Account | null {
  return db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

/**
 * Adds an account. Opens no transaction of its own, so it can run inside a caller's (a bank
 * connection creates the account and links it in one).
 */
export function createAccount(input: NewAccount): Account {
  const currency = input.currency ?? null;
  const account: Account = {
    id: nanoid(),
    name: input.name,
    type: input.type,
    startingBalance: input.startingBalance ?? 0,
    // Homes, cars, investments and loans start off budget unless asked otherwise
    isOffBudget: offBudgetFor(currency, input.isOffBudget ?? defaultOffBudget(input.type)),
    sortOrder: 0,
    closedAt: null,
    logo: input.logo ?? null,
    currency,
    createdAt: new Date().toISOString(),
  };
  db.insert(accounts).values(account).run();
  return account;
}

/** Starting balance plus its transactions (split parts counted once); null if it doesn't exist */
export function accountBalance(id: string): number | null {
  const account = findAccount(id);
  return account ? account.startingBalance + accountTransactionSum(id) : null;
}

/**
 * Sets the starting balance so the balance is `cents` at the end of `asOf` (now when null): a
 * bank's opening balance (D7). A bank's closing balance is often yesterday's, so transactions
 * after its date aren't in it yet.
 */
export function setBalanceTo(id: string, cents: number, asOf: string | null = null) {
  db.update(accounts)
    .set({ startingBalance: cents - accountTransactionSum(id, asOf ?? undefined) })
    .where(eq(accounts.id, id))
    .run();
}

/** An account that is still open; null when it's closed or doesn't exist */
export function openAccount(id: string): { id: string; name: string } | null {
  const account = findAccount(id);
  return account && !account.closedAt ? { id: account.id, name: account.name } : null;
}

/** An account's name and balance, closed or not; null when it doesn't exist */
export function accountSummary(id: string): { name: string; balance: number } | null {
  const account = findAccount(id);
  return account
    ? { name: account.name, balance: account.startingBalance + accountTransactionSum(id) }
    : null;
}
