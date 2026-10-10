import { useState, useRef } from 'react';
import { useFormReset } from '../../hooks/useFormReset';
import { Modal } from '../ui/Modal';
import { useCanSave } from '../../hooks/useConnection';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { ConfirmModal } from '../ui/ConfirmModal';
import { CurrencyInput } from '../ui/CurrencyInput';
import { useUpdateAccount, useCloseAccount } from '../../hooks/useAccounts';
import type { Account, AccountType } from '../../types';
import { AccountIcon } from './AccountIcon';
import { AccountTypeSelect } from './AccountTypeSelect';
import { fileToSquareDataUrl } from '../../utils/imageResize';
import { usePreferencesStore } from '../../store/preferencesStore';
import { otherCurrencyCodes, useBudgetCurrency } from '../../utils/budgetCurrency';
import { ForeignBudgetHint } from './ForeignBudgetHint';

interface Props {
  account: Account | null;
  onClose: () => void;
}

export function EditAccountModal({ account, onClose }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [startingBalance, setStartingBalance] = useState(0);
  const [isOffBudget, setIsOffBudget] = useState(false);
  // The account's own currency; null = the budget's
  const [currency, setCurrency] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Transfers the last save uncategorized (M8); set, the dialog stays open to say so
  const [uncategorized, setUncategorized] = useState<number | null>(null);
  const canSave = useCanSave();
  const budget = useBudgetCurrency();
  const foreign = currency !== null;
  // Moving the account on or off budget makes some transfers stop crossing the budget (M8)
  const budgetStatusChanges = account !== null && isOffBudget !== (account.isOffBudget === 1);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const showAccountIcons = usePreferencesStore((s) => s.showAccountIcons);

  const updateAccount = useUpdateAccount();
  const closeAccount = useCloseAccount();

  // Filled once per opening, not on every refetch of the account (that would undo edits)
  useFormReset(account?.id ?? null, () => {
    if (!account) return;
    setName(account.name);
    setType(account.type);
    setStartingBalance(account.startingBalance);
    setIsOffBudget(account.isOffBudget === 1);
    setCurrency(account.currency ?? null);
    setLogo(account.logo ?? null);
    setLogoError(null);
    setUncategorized(null);
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !name.trim()) return;
    // After a save that reported uncategorized transfers, the form only offers Done
    if (uncategorized !== null) return onClose();
    const saved = await updateAccount.mutateAsync({
      id: account.id,
      data: {
        name: name.trim(),
        type,
        startingBalance,
        isOffBudget: isOffBudget ? 1 : 0,
        currency,
        ...(logo !== (account.logo ?? null) ? { logo } : {}),
      },
    });
    const moved = saved.transfersUncategorized ?? 0;
    if (moved > 0) return setUncategorized(moved);
    onClose();
  }

  async function handleLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    try {
      setLogo(await fileToSquareDataUrl(file));
      setLogoError(null);
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not use that image.');
    }
  }

  async function handleCloseAccount() {
    if (!account) return;
    await closeAccount.mutateAsync(account.id);
    onClose();
  }

  return (
    <>
      <Modal isOpen={!!account} onClose={onClose} title="Edit Account" size="sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Logo</label>
            <div className="flex items-center gap-3">
              <AccountIcon name={name} type={type} logo={logo} size="lg" force />
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-medium text-text-secondary bg-surface border border-border rounded-md hover:bg-hover transition-colors cursor-pointer"
                  >
                    {logo ? 'Change image' : 'Upload image'}
                  </button>
                  {logo && (
                    <button
                      type="button"
                      onClick={() => setLogo(null)}
                      className="px-3 py-1.5 text-xs font-medium text-text-tertiary hover:text-negative transition-colors cursor-pointer"
                    >
                      Use initials
                    </button>
                  )}
                </div>
                <p className={`text-xs ${logoError ? 'text-negative' : 'text-text-tertiary'}`}>
                  {logoError ??
                    (logo
                      ? 'Cropped to a square.'
                      : 'Showing initials. Upload a bank logo or any image.')}
                </p>
                {!showAccountIcons && (
                  <p className="text-xs text-caution">
                    Account icons are turned off in Settings → Preferences.
                  </p>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={handleLogoFile}
                className="hidden"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Account Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Account name"
              autoFocus
              className="block w-full rounded-lg border border-border px-3 py-2 text-sm bg-surface text-text focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <AccountTypeSelect value={type} onChange={setType} />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Currency</label>
            <select
              aria-label="Currency"
              value={currency ?? ''}
              onChange={(e) => setCurrency(e.target.value || null)}
              className="block w-full rounded-lg border border-border px-3 py-2 text-sm bg-surface text-text focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 max-md:min-h-11"
            >
              <option value="">{`Budget currency (${budget})`}</option>
              {otherCurrencyCodes(budget, currency).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Starting Balance
            </label>
            <CurrencyInput
              value={startingBalance}
              onChange={setStartingBalance}
              allowNegative
              aria-label="Starting balance"
            />
          </div>

          <div>
            <label className="flex items-center gap-3 max-md:min-h-11 cursor-pointer">
              <input
                type="checkbox"
                checked={isOffBudget}
                onChange={(e) => setIsOffBudget(e.target.checked)}
                className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-text-secondary">
                Off budget (excluded from budgeting)
                {currency !== null && (
                  <ForeignBudgetHint currency={currency} offBudget={isOffBudget} />
                )}
              </span>
            </label>
            {budgetStatusChanges && (
              <p className="mt-1.5 text-xs text-caution">
                Transfers between this account and others that no longer cross the budget lose their
                category when you save.
              </p>
            )}
          </div>

          {uncategorized !== null && (
            <p role="status" className="text-sm text-text-secondary">
              {uncategorized === 1
                ? '1 transfer lost its category because it no longer crosses the budget.'
                : `${uncategorized} transfers lost their category because they no longer cross the budget.`}
            </p>
          )}

          <SavingPausedHint className="text-right" />
          <div className="flex items-center justify-between pt-2 border-t border-border-light">
            <button
              type="button"
              onClick={() => setConfirmClose(true)}
              className="text-sm text-negative hover:underline font-medium transition-colors"
            >
              Close Account
            </button>
            {uncategorized !== null ? (
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
              >
                Done
              </button>
            ) : (
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface border border-border rounded-lg hover:bg-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || updateAccount.isPending || !canSave}
                  className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {updateAccount.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={handleCloseAccount}
        title="Close Account"
        message={`Are you sure you want to close "${account?.name}"? It will be hidden from your accounts list.`}
        confirmLabel="Close Account"
        danger
      />
    </>
  );
}
