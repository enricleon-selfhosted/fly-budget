// Values in the budget's currency for transactions in accounts in another currency (docs/multi-currency).
// Pure: the screens use these. The server converts the same way (services/balances.ts `budgetValue`).
import type { FxSource, Transaction } from '../types';
import { rateText } from './currencyRates';

type ValueFields = Pick<Transaction, 'amount' | 'budgetAmount'>;

/**
 * What a transaction is worth in the budget's currency, in cents and signed. Rows in the budget's
 * own currency have no `budgetAmount` and count as their amount. Null while an account in another
 * currency has no rate yet.
 */
export function valueInBudget(tx: ValueFields): number | null {
  return tx.budgetAmount === undefined ? tx.amount : tx.budgetAmount;
}

/**
 * A list's absolute total in the budget's currency, as a day's header adds up across accounts.
 * Rows still waiting for a rate are left out of `total` and counted in `waiting`.
 */
export function budgetTotal(txs: readonly ValueFields[]): { total: number; waiting: number } {
  let total = 0;
  let waiting = 0;
  for (const tx of txs) {
    const value = valueInBudget(tx);
    if (value === null) waiting += 1;
    else total += Math.abs(value);
  }
  return { total, waiting };
}

/**
 * Whether a transaction's value in the budget's currency can be typed in: not when it's
 * reconciled, a split part (it follows its whole transaction's rate) or one side of an exchange
 * (the value is what arrived on the other side). The server checks the same
 * (budgetAmountProblem in server/src/services/fx/conversion.ts, through fxService's
 * setBudgetAmount); this only decides whether the field is offered.
 */
export function budgetValueEditable(
  tx: Pick<Transaction, 'reconciled' | 'parentTransactionId' | 'fxSource'>,
): boolean {
  return tx.reconciled !== 1 && !tx.parentTransactionId && tx.fxSource !== 'exchange';
}

const SOURCE_LABELS: Record<FxSource, string> = {
  manual: 'Typed in',
  exchange: 'From an exchange',
  rate: "At the day's rate",
};

/** Where a transaction's value in the budget's currency came from */
export function fxSourceLabel(source: FxSource | null | undefined): string {
  return source ? SOURCE_LABELS[source] : 'No exchange rate yet';
}

/**
 * "At the day's rate · 1 GBP = 1.1700 EUR": the source, then the rate it was converted at (one
 * unit of the account's currency `from` in the budget's `to`), left out while there is none
 */
export function fxNote(
  source: FxSource | null | undefined,
  rate: number | null | undefined,
  from: string,
  to: string,
): string {
  const usable = rate !== null && rate !== undefined && Number.isFinite(rate) && rate > 0;
  return usable ? `${fxSourceLabel(source)} · ${rateText(from, to, rate)}` : fxSourceLabel(source);
}
