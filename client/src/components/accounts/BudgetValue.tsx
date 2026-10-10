import { format, parseISO } from 'date-fns';
import { formatCurrency } from '../../utils/currency';
import type { Account } from '../../types';

interface Props {
  account: Pick<Account, 'currency' | 'budgetBalance' | 'budgetBalanceAsOf'>;
  /** Where it sits: a light page, or the dark sidebar */
  tone?: 'surface' | 'sidebar';
  className?: string;
}

const TONE = {
  surface: { value: 'text-text-secondary', missing: 'text-text-tertiary' },
  sidebar: { value: 'text-sidebar-text/60', missing: 'text-sidebar-text/50' },
};

/**
 * An account in another currency, worth this much in the budget's currency: "≈ €1,180.00" at the
 * latest rate (docs/multi-currency M6), or "No exchange rate". Nothing for an account in the
 * budget's own currency, whose balance is already in it.
 */
export function BudgetValue({ account, tone = 'surface', className = '' }: Props) {
  if (!account.currency) return null;
  const colors = TONE[tone];
  if (typeof account.budgetBalance !== 'number') {
    return (
      <span
        title="Add exchange rates in Settings → Currencies"
        className={`${colors.missing} ${className}`}
      >
        No exchange rate
      </span>
    );
  }
  const asOf = account.budgetBalanceAsOf
    ? `At the rate of ${format(parseISO(account.budgetBalanceAsOf), 'd MMM yyyy')}`
    : 'At the latest rate';
  return (
    <span title={asOf} className={`${colors.value} ${className}`}>
      ≈ {formatCurrency(account.budgetBalance)}
    </span>
  );
}
