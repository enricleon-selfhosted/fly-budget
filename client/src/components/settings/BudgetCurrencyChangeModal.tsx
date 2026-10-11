import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import type { CurrencySettingsChange } from '../../api/currencies';
import { budgetAccountsChoice, budgetCurrencyChangeText } from '../../utils/currencyRates';

export type BudgetAccountsOnChange = NonNullable<CurrencySettingsChange['budgetAccounts']>;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  from: string;
  to: string;
  /** Accounts in the budget's currency now: they're asked about (docs/multi-currency M2) */
  budgetAccounts: number;
  onChange: (budgetAccounts: BudgetAccountsOnChange) => void;
}

/**
 * Confirms a change of the budget's currency. With accounts in the budget's currency it asks
 * what their amounts are in: the new currency all along (the first one was a wrong guess, so only
 * the name changes) or the old one (they become accounts in another currency).
 */
export function BudgetCurrencyChangeModal({
  isOpen,
  onClose,
  from,
  to,
  budgetAccounts,
  onChange,
}: Props) {
  const choose = (choice: BudgetAccountsOnChange) => {
    onChange(choice);
    onClose();
  };
  const title = `Change the budget currency to ${to}`;

  if (budgetAccounts === 0) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
        <p className="text-sm text-text-secondary">{budgetCurrencyChangeText(from, to)}</p>
        <div className="flex justify-end gap-3 mt-6">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => choose('keep')}>Change currency</Button>
        </div>
      </Modal>
    );
  }

  const choice = budgetAccountsChoice(from, to, budgetAccounts);
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-text-secondary">{choice.question}</p>
      <div className="mt-4 space-y-2">
        {(['follow', 'keep'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => choose(key)}
            className="w-full text-left rounded-lg border border-border bg-surface px-4 py-3 hover:border-brand-500 hover:bg-hover transition-colors cursor-pointer"
          >
            <span className="block text-sm font-medium text-text">{choice[key].label}</span>
            <span className="block text-xs text-text-secondary mt-0.5">{choice[key].detail}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end mt-6">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
