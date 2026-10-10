import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

/**
 * Categorized transactions in accounts in another currency that have no exchange rate yet, so
 * they aren't in the budget (docs/multi-currency M3). Shown above the budget, desktop and phone.
 */
export function WaitingForRateNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2.5 text-sm bg-caution-subtle text-text border-b border-caution/30 shrink-0">
      <AlertTriangle size={16} className="text-caution shrink-0" aria-hidden />
      <span className="min-w-0">
        {count === 1
          ? "1 transaction in another currency isn't in your budget yet: it has no exchange rate."
          : `${count} transactions in other currencies aren't in your budget yet: they have no exchange rate.`}
      </span>
      <Link
        to="/settings?tab=currencies"
        className="font-medium text-brand-600 hover:text-brand-700 max-md:min-h-11 inline-flex items-center"
      >
        Exchange rates
      </Link>
    </div>
  );
}
