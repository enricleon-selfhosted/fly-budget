import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { defaultOffBudget, type AccountType } from '../utils/accountTypes.js';
import { startsOffBudget, storedCurrency } from '../utils/currency.js';
import { accountTransactionSum } from './balances.js';
import { scheduleRatesDownload } from './fx/download.js';
import { refreshFx } from './fx/fxService.js';
import { budgetCurrency } from './fx/settings.js';
import { uncategorizeTransfersThatStopCrossing } from './transactionHelpers.js';

// Creating and changing accounts, and one account's balance. The accounts API and bank
// connections both come here, so the rules have one owner: a null currency means the budget's
// (docs/multi-currency M2), new accounts in another currency start off budget (M1), and a change
// of currency or budget status keeps their transactions right (M3, M8).

export type Account = typeof accounts.$inferSelect;

export type NewAccount = {
  name: string;
  type: AccountType;
  startingBalance?: number;
  /** Unset: by its type, and off budget in another currency */
  isOffBudget?: 0 | 1;
  currency?: string | null;
  logo?: string | null;
};

export type AccountChanges = Partial<
  Pick<Account, 'name' | 'type' | 'startingBalance' | 'isOffBudget' | 'currency' | 'logo'>
>;

/** The currency to store: null for the budget's own; as given while the budget has none yet */
function toStored(currency: string | null): string | null {
  const budget = budgetCurrency();
  return budget ? storedCurrency(currency, budget) : currency;
}

function findAccount(id: string): Account | null {
  return db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

/**
 * Adds an account. Opens no transaction of its own, so it can run inside a caller's (a bank
 * connection creates the account and links it in one).
 */
export function createAccount(input: NewAccount): Account {
  const currency = toStored(input.currency ?? null);
  const account: Account = {
    id: nanoid(),
    name: input.name,
    type: input.type,
    startingBalance: input.startingBalance ?? 0,
    isOffBudget: startsOffBudget(currency, input.isOffBudget, defaultOffBudget(input.type)),
    sortOrder: 0,
    closedAt: null,
    logo: input.logo ?? null,
    currency,
    createdAt: new Date().toISOString(),
  };
  db.insert(accounts).values(account).run();
  // Its transactions need rates
  if (currency) scheduleRatesDownload();
  return account;
}

/**
 * Changes an account. Moving it on or off budget uncategorizes the transfers that stop crossing
 * the budget's boundary (M8); a new currency re-converts its transactions (M3), all in one
 * database transaction. Null when the account doesn't exist.
 */
export function updateAccount(
  id: string,
  changes: AccountChanges,
): { account: Account; transfersUncategorized: number } | null {
  const before = findAccount(id);
  if (!before) return null;
  const values = { ...changes };
  if (values.currency !== undefined) values.currency = toStored(values.currency);

  const result = db.transaction((tx) => {
    if (Object.keys(values).length)
      tx.update(accounts).set(values).where(eq(accounts.id, id)).run();
    const account = findAccount(id)!;
    const transfersUncategorized =
      account.isOffBudget !== before.isOffBudget ? uncategorizeTransfersThatStopCrossing(id) : 0;
    if (account.currency !== before.currency) refreshFx({ accountIds: [id] });
    return { account, transfersUncategorized };
  });
  if (result.account.currency !== before.currency) scheduleRatesDownload();
  return result;
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
