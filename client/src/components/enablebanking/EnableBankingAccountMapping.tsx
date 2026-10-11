import { useId, useState } from 'react';
import { useAccounts } from '../../hooks/useAccounts';
import { useCanSave } from '../../hooks/useConnection';
import { useMapEnableBankingAccounts } from '../../hooks/useEnableBanking';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { AccountTypeSelect } from '../accounts/AccountTypeSelect';
import { Button } from '../ui/Button';
import { useBudgetCurrency } from '../../hooks/useBudgetCurrency';
import { formatCurrency } from '../../utils/currency';
import { startsOffBudget } from '../../utils/accountTypes';
import { ForeignBudgetHint } from '../accounts/ForeignBudgetHint';
import type {
  Account,
  EnableBankingAccount,
  EnableBankingMappingAction,
  EnableBankingMappingResult,
} from '../../types';
import {
  DEFAULT_IMPORT_DAYS,
  bankCurrency,
  initialMappingRow,
  isoDate,
  linkOptions,
  mappingAction,
  withAction,
  withLinkedAccount,
  type MappingRow,
} from './model';
import { choiceClass, fieldClass, hintClass, labelClass } from './styles';

const NO_ACCOUNTS: Account[] = [];

interface Props {
  connectionId: string;
  accounts: EnableBankingAccount[];
  submitLabel?: string;
  /** Called once every account is saved (with the counts and any per-account errors) */
  onDone: (result: EnableBankingMappingResult) => void;
}

/**
 * Chooses, for each bank account, a new FlyBudget account, an existing one, or nothing.
 * The choices are made when this mounts; its dialog unmounts it when closed, so each opening
 * starts fresh and a refetch of `accounts` never overwrites what the user picked.
 */
export function EnableBankingAccountMapping({
  connectionId,
  accounts,
  submitLabel = 'Save',
  onDone,
}: Props) {
  const groupId = useId();
  const budget = useBudgetCurrency();
  const { data: existing = NO_ACCOUNTS, isLoading: accountsLoading } = useAccounts();
  const map = useMapEnableBankingAccounts();
  const canSave = useCanSave();
  const [rows, setRows] = useState<Record<string, MappingRow>>(() => {
    const now = new Date();
    return Object.fromEntries(accounts.map((a) => [a.id, initialMappingRow(a, budget, now)]));
  });
  // Set when some accounts failed: the user sees them, then continues (never submits twice)
  const [result, setResult] = useState<EnableBankingMappingResult | null>(null);

  // Accounts the latest consent leaves out are shown, but can't be imported until a renewal
  // includes them again, so nothing is sent for them
  const mappable = accounts.filter((a) => a.inConsent !== false);
  const actions = mappable.map((a) => mappingAction(a, rows[a.id]));
  const complete = actions.every((action) => action !== null);
  const requested = actions.filter(
    (action): action is EnableBankingMappingAction => action !== null,
  );

  function setRow(account: EnableBankingAccount, row: MappingRow) {
    setRows((prev) => ({ ...prev, [account.id]: row }));
  }

  /** Existing accounts another bank account of this connection has chosen can't be picked again */
  function takenBy(account: EnableBankingAccount): Set<string> {
    const taken = new Set<string>();
    for (const other of mappable) {
      const row = rows[other.id];
      if (other.id !== account.id && row.action === 'link' && row.accountId) {
        taken.add(row.accountId);
      }
    }
    return taken;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete || !canSave || map.isPending || result) return;
    try {
      const mapped = await map.mutateAsync({ connectionId, accounts: requested });
      if (mapped.errors.length === 0) onDone(mapped);
      else setResult(mapped);
    } catch {
      // Shown below (map.error)
    }
  }

  const today = isoDate(new Date());

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Disabled while saving, and once saved with errors, so nothing is sent twice */}
      <fieldset disabled={map.isPending || result !== null} className="min-w-0 space-y-4">
        <legend className="sr-only">Accounts to import</legend>
        {accounts.length === 0 && (
          <p className="text-xs text-text-secondary">No accounts were shared by this bank.</p>
        )}

        {accounts.map((account) => {
          if (account.inConsent === false) {
            return (
              <div
                key={account.id}
                className="bg-surface-alt border border-border rounded-lg p-4 space-y-1"
              >
                <p className="text-sm font-medium text-text break-words">{account.name}</p>
                <p className="text-xs text-text-secondary">
                  Your bank no longer shares this account with FlyBudget. To import it again, renew
                  access and include it. Transactions already imported stay in FlyBudget.
                </p>
              </div>
            );
          }
          const row = rows[account.id];
          const id = `${groupId}-${account.id}`;
          const currency = bankCurrency(account, budget);
          const foreign = currency !== budget;
          const options = linkOptions(existing, currency, budget, takenBy(account), row.accountId);
          const failed = result?.errors.find((e) => e.id === account.id);
          const linkDisabled = options.length === 0 && row.action !== 'link';

          return (
            <fieldset
              key={account.id}
              className="min-w-0 bg-surface border border-border rounded-lg p-4 space-y-3"
            >
              <legend className="sr-only">{account.name}</legend>

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text break-words">{account.name}</p>
                  <p className="text-xs text-text-tertiary font-mono">
                    {account.ibanMask ?? 'No IBAN'} · {currency}
                  </p>
                </div>
                {account.bankBalance !== null && (
                  <p className="text-xs text-text-secondary whitespace-nowrap">
                    Bank balance{' '}
                    <span className="text-sm font-medium text-text">
                      {formatCurrency(account.bankBalance, foreign ? currency : null)}
                    </span>
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className={choiceClass}>
                  <input
                    type="radio"
                    name={`${id}-action`}
                    checked={row.action === 'create'}
                    onChange={() => setRow(account, withAction(row, account, 'create', new Date()))}
                    className="mt-1 accent-brand-600"
                  />
                  <span>Import as a new account</span>
                </label>
                <label className={`${choiceClass} ${linkDisabled ? 'opacity-50' : ''}`}>
                  <input
                    type="radio"
                    name={`${id}-action`}
                    checked={row.action === 'link'}
                    disabled={linkDisabled}
                    onChange={() => setRow(account, withAction(row, account, 'link', new Date()))}
                    className="mt-1 accent-brand-600"
                  />
                  <span>
                    Add to an existing account
                    {linkDisabled && (
                      <span className="block text-xs text-text-tertiary">
                        {accountsLoading
                          ? 'Loading accounts...'
                          : `No open accounts in ${currency} to add it to.`}
                      </span>
                    )}
                  </span>
                </label>
                <label className={choiceClass}>
                  <input
                    type="radio"
                    name={`${id}-action`}
                    checked={row.action === 'skip'}
                    onChange={() => setRow(account, withAction(row, account, 'skip', new Date()))}
                    className="mt-1 accent-brand-600"
                  />
                  <span>
                    Don&apos;t import
                    {row.action === 'skip' && account.accountId && (
                      <span className="block text-xs text-text-tertiary">
                        Transactions already imported stay in FlyBudget.
                      </span>
                    )}
                  </span>
                </label>
              </div>

              {row.action === 'create' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <label htmlFor={`${id}-name`} className={labelClass}>
                      Account name
                    </label>
                    <input
                      id={`${id}-name`}
                      type="text"
                      value={row.name}
                      onChange={(e) => setRow(account, { ...row, name: e.target.value })}
                      className={fieldClass}
                    />
                    {row.name.trim() === '' && (
                      <p className="text-xs text-negative mt-1">Enter a name for the account.</p>
                    )}
                  </div>

                  <AccountTypeSelect
                    value={row.type}
                    onChange={(type) =>
                      setRow(account, {
                        ...row,
                        type,
                        offBudget: startsOffBudget(type, foreign),
                      })
                    }
                  />

                  <label className={choiceClass}>
                    <input
                      type="checkbox"
                      checked={row.offBudget}
                      onChange={(e) => setRow(account, { ...row, offBudget: e.target.checked })}
                      className="mt-1 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
                    />
                    <span>
                      Off budget
                      {foreign ? (
                        <ForeignBudgetHint currency={currency} offBudget={row.offBudget} />
                      ) : (
                        <span className="block text-xs text-text-tertiary">
                          Counts toward net worth but not your budget.
                        </span>
                      )}
                    </span>
                  </label>

                  <div>
                    <label htmlFor={`${id}-from`} className={labelClass}>
                      Import from
                    </label>
                    <input
                      id={`${id}-from`}
                      type="date"
                      value={row.syncFrom}
                      max={today}
                      onChange={(e) => setRow(account, { ...row, syncFrom: e.target.value })}
                      className={fieldClass}
                    />
                    <p className={hintClass}>
                      Starts {DEFAULT_IMPORT_DAYS} days back. Right after connecting, banks may
                      share more history, so you can pick an earlier date.
                    </p>
                  </div>
                </div>
              )}

              {row.action === 'link' && (
                <div className="space-y-3 pt-1">
                  <div>
                    <label htmlFor={`${id}-account`} className={labelClass}>
                      FlyBudget account
                    </label>
                    <select
                      id={`${id}-account`}
                      value={row.accountId}
                      onChange={(e) =>
                        setRow(account, withLinkedAccount(row, account, e.target.value))
                      }
                      className={fieldClass}
                    >
                      <option value="">Choose an account</option>
                      {options.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({formatCurrency(a.balance, a.currency)})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor={`${id}-from`} className={labelClass}>
                      Import from
                    </label>
                    <input
                      id={`${id}-from`}
                      type="date"
                      value={row.syncFrom}
                      max={today}
                      onChange={(e) => setRow(account, { ...row, syncFrom: e.target.value })}
                      className={fieldClass}
                    />
                    <p className={hintClass}>
                      Empty: right after the newest imported transaction in that account.
                    </p>
                  </div>
                </div>
              )}

              {failed && (
                <p role="alert" className="text-xs text-negative">
                  Not saved: {failed.error}
                </p>
              )}
            </fieldset>
          );
        })}
      </fieldset>

      {result && (
        <p className="text-xs text-text-secondary">
          Saved {result.created} new and {result.linked} existing{' '}
          {result.linked === 1 ? 'account' : 'accounts'}. The accounts marked above weren&apos;t
          saved; you can set them up later under Manage accounts.
        </p>
      )}

      <SavingPausedHint className="text-right" />
      <div className="flex justify-end gap-3 pt-1">
        {result ? (
          <Button onClick={() => onDone(result)}>Continue</Button>
        ) : (
          <Button type="submit" disabled={!complete || !canSave || map.isPending}>
            {map.isPending ? 'Saving...' : submitLabel}
          </Button>
        )}
      </div>
      {map.isError && (
        <p role="alert" className="text-xs text-negative text-right">
          {map.error.message}
        </p>
      )}
    </form>
  );
}
