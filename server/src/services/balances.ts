import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, transactions } from '../db/schema.js';

// A split is stored as a parent row holding the full amount plus child rows holding
// the parts, all in the same account. Account balances count the parent only;
// category totals count the children only (the parent has no category).

/** Rows that make up an account's balance: everything except split children. */
export const inAccountBalance: SQL = isNull(transactions.parentTransactionId);

/**
 * Rows that are money earned or spent, for income and spending reports: everything except
 * balance corrections (reconciliation, "Update value") the user left without a category.
 * Balances and net worth still count those.
 */
export const isIncomeOrSpending: SQL = sql`not (${transactions.isAdjustment} = 1 and ${transactions.categoryId} is null)`;

/**
 * Rows in accounts kept in the budget's currency. Accounts in another currency
 * (`accounts.currency` set) can't be added to them without exchange rates, so totals across
 * accounts (net worth, income and spending reports) leave them out.
 */
export const inBudgetCurrency: SQL = inArray(
  transactions.accountId,
  db.select({ id: accounts.id }).from(accounts).where(isNull(accounts.currency)),
);

/** Sum of an account's transactions, as added to its starting balance. */
export function accountTransactionSum(accountId: string): number {
  const row = db
    .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), inAccountBalance))
    .get();
  return row?.sum ?? 0;
}
