// Values in the budget's currency for transactions in accounts in another currency (docs/multi-currency).
// Pure: the screens use these. The server converts the same way (services/balances.ts `budgetValue`).
import type { FxSource, Transaction } from '../types';

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

const rateFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** "1 GBP = 1.1700 EUR": one unit of the account's currency in the budget's. Null without a rate. */
export function rateText(rate: number | null | undefined, from: string, to: string): string | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return `1 ${from} = ${rateFormat.format(rate)} ${to}`;
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

/** "At the day's rate · 1 GBP = 1.1700 EUR": the source, then the rate it was converted at */
export function fxNote(
  source: FxSource | null | undefined,
  rate: number | null | undefined,
  from: string,
  to: string,
): string {
  const ratePart = rateText(rate, from, to);
  return ratePart ? `${fxSourceLabel(source)} · ${ratePart}` : fxSourceLabel(source);
}
