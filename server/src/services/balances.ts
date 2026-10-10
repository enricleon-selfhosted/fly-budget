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
 * Everything except transfers that only move money between two accounts. A transfer with a
 * category moves money into or out of the budget (it has an off-budget account on the other
 * side, decision D26), so income and spending reports count it like any other.
 */
export const isNotPlainTransfer: SQL = sql`(${transactions.transferTransactionId} is null or ${transactions.categoryId} is not null)`;

/** Rows in accounts kept in the budget's currency (`accounts.currency` null) */
const inBudgetCurrencyAccount = sql`${transactions.accountId} in (select id from accounts where currency is null)`;

/**
 * A transaction's value in the budget's currency (docs/multi-currency M5): its amount in an
 * account in the budget's currency; in another currency, its amount at its rate
 * (`round(amount × fx_rate)`, half away from zero like `convertCents`); null while it has no rate.
 * The budget and every total across accounts add this up, never `amount`.
 */
export const budgetValue = sql<number>`(case when ${inBudgetCurrencyAccount} then ${transactions.amount} when ${transactions.fxRate} is not null then cast(round(${transactions.amount} * ${transactions.fxRate}) as integer) end)`;

/** The sum of `budgetValue`, 0 when there's nothing */
export const sumBudgetValue = sql<number>`coalesce(sum(${budgetValue}), 0)`;

/**
 * Rows that have a value in the budget's currency: everything in accounts in the budget's
 * currency, and converted rows in others. Totals across accounts leave out the rest.
 */
export const hasBudgetValue: SQL = sql`${budgetValue} is not null`;

/** Superseded by hasBudgetValue; kept until the routes move over */
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
