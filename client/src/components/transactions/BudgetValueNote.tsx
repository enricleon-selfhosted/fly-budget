import { formatCurrency } from '../../utils/currency';
import { fxSourceLabel } from '../../utils/fxDisplay';
import type { Transaction } from '../../types';

/**
 * Under a transaction's amount in an account in another currency: its value in the budget's
 * currency, or that it has no rate yet. Rows in the budget's own currency show nothing.
 */
export function BudgetValueNote({
  tx,
  className = '',
}: {
  tx: Pick<Transaction, 'budgetAmount' | 'fxSource'>;
  className?: string;
}) {
  if (tx.budgetAmount === undefined) return null;
  if (tx.budgetAmount === null) {
    return (
      <span
        title="Not in your budget or reports until it has an exchange rate"
        className={`text-xs text-text-tertiary whitespace-nowrap ${className}`}
      >
        No rate yet
      </span>
    );
  }
  return (
    <span
      title={fxSourceLabel(tx.fxSource)}
      className={`text-xs tabular-nums text-text-tertiary whitespace-nowrap ${className}`}
    >
      ≈ {formatCurrency(Math.abs(tx.budgetAmount))}
    </span>
  );
}
