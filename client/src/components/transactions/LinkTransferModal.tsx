import { format, parseISO } from 'date-fns';
import { ArrowLeftRight } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { EmptyState } from '../ui/EmptyState';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { useCanSave } from '../../hooks/useConnection';
import { useFormReset } from '../../hooks/useFormReset';
import { useLinkTransfer, useTransferCandidates } from '../../hooks/useTransactions';
import { formatCurrency } from '../../utils/currency';
import { isExchange } from '../../utils/transfers';
import type { Transaction } from '../../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The plain transaction to pair with the matching one in another account */
  transaction: Transaction;
  /** The transaction's own account currency (null = the budget's) */
  currency: string | null;
}

/** Makes a plain transaction and the matching one in another account a single transfer */
export function LinkTransferModal({ isOpen, onClose, transaction, currency }: Props) {
  const candidates = useTransferCandidates(transaction.id, isOpen);
  const linkTx = useLinkTransfer();
  const canSave = useCanSave();
  // An error from an earlier link doesn't belong to the next dialog
  useFormReset(isOpen ? transaction.id : null, () => linkTx.reset());

  const choices = candidates.data ?? [];

  function choose(otherId: string) {
    linkTx.mutate({ id: transaction.id, otherId }, { onSuccess: onClose });
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Link as transfer" size="md">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Pick the other side of this money, from one of your other accounts. Both transactions
          become one transfer.
        </p>

        {candidates.isLoading ? (
          <p className="text-sm text-text-tertiary">Looking for matches...</p>
        ) : candidates.isError ? (
          <p role="alert" className="text-sm text-negative">
            {candidates.error.message}
          </p>
        ) : choices.length === 0 ? (
          <EmptyState
            compact
            icon={<ArrowLeftRight size={20} />}
            title="No match found"
            description="No transaction in your other accounts within a week looks like the other side."
          />
        ) : (
          <ul className="space-y-1" aria-label="Matching transactions">
            {choices.map((c) => {
              const exchange = isExchange({ currency }, { currency: c.currency });
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => choose(c.id)}
                    disabled={!canSave || linkTx.isPending}
                    className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-hover cursor-pointer max-md:min-h-11 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-text truncate">
                        {c.payeeName || 'No payee'}
                      </span>
                      <span className="block text-xs text-text-tertiary truncate">
                        {c.accountName} · {format(parseISO(c.date), 'MMM d, yyyy')}
                      </span>
                    </span>
                    {exchange && (
                      <span className="shrink-0 text-xs font-medium text-brand-700 bg-brand-50 rounded px-1.5 py-0.5">
                        Exchange
                      </span>
                    )}
                    <span
                      className={`shrink-0 text-sm tabular-nums ${c.amount > 0 ? 'text-positive' : 'text-text'}`}
                    >
                      {formatCurrency(c.amount, c.currency)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {linkTx.error && (
          <p role="alert" className="text-sm text-negative">
            {linkTx.error.message}
          </p>
        )}
        <SavingPausedHint />
      </div>
    </Modal>
  );
}
