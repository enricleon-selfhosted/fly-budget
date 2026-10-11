import { and, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
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
 * Everything except transfers that only move money between two accounts. A transfer with a
 * category moves money into or out of the budget (it has an off-budget account on the other
 * side, decision D26), so income and spending reports count it like any other.
 */
export const isNotPlainTransfer: SQL = sql`(${transactions.transferTransactionId} is null or ${transactions.categoryId} is not null)`;

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
export function accountTransactionSum(accountId: string, upTo?: string): number {
  const row = db
    .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        inAccountBalance,
        upTo ? lte(transactions.date, upTo) : undefined,
      ),
    )
    .get();
  return row?.sum ?? 0;
}
