import { useState } from 'react';
import {
  usePreferencesStore,
  type Theme,
  type DateFormatOption,
  type SidebarMode,
} from '../../store/preferencesStore';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useModalValue } from '../ui/Modal';
import { IS_DEMO } from '../../demo/isDemo';
import { CURRENCY_CODES } from '../../utils/budgetCurrency';
import { useBudgetCurrency } from '../../hooks/useBudgetCurrency';
import { budgetCurrencyChangeText } from '../../utils/currencyRates';
import { useCanSave } from '../../hooks/useConnection';
import { useCurrencies, useUpdateCurrencySettings } from '../../hooks/useCurrencies';
import { SavingPausedHint } from '../connection/SavingPausedHint';

const themeOptions: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const sidebarModes: { value: SidebarMode; label: string; description: string }[] = [
  { value: 'persistent', label: 'Pinned', description: 'Always open' },
  { value: 'auto-hide', label: 'Auto-hide', description: 'Collapsed, opens on hover' },
];

const dateFormats: { value: DateFormatOption; label: string; example: string }[] = [
  { value: 'MMM d, yyyy', label: 'MMM d, yyyy', example: 'Jan 5, 2026' },
  { value: 'MM/dd/yyyy', label: 'MM/dd/yyyy', example: '01/05/2026' },
  { value: 'dd/MM/yyyy', label: 'dd/MM/yyyy', example: '05/01/2026' },
  { value: 'yyyy-MM-dd', label: 'yyyy-MM-dd', example: '2026-01-05' },
];

export function PreferencesPanel() {
  const {
    theme,
    currencySymbol,
    setCurrencyCode,
    dateFormat,
    sidebarMode,
    showMerchantIcons,
    showCategoryIcons,
    showAccountIcons,
    setTheme,
    setCurrencySymbol,
    setDateFormat,
    setSidebarMode,
    setShowMerchantIcons,
    setShowCategoryIcons,
    setShowAccountIcons,
  } = usePreferencesStore();
  // The budget's currency: the server's, or this device's until the server has one
  const budget = useBudgetCurrency();
  const { data: currencyOverview } = useCurrencies();
  const canSave = useCanSave();
  const saveCurrency = useUpdateCurrencySettings();
  // A change waiting for the user to confirm it (accounts in other currencies would be re-labelled)
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  const confirming = useModalValue(pendingCurrency);
  // While the server answers, the select keeps showing the choice instead of snapping back
  const shownBudget = saveCurrency.isPending
    ? (saveCurrency.variables?.currency ?? budget)
    : budget;
  const budgetCodeOptions: readonly string[] = (CURRENCY_CODES as readonly string[]).includes(
    shownBudget,
  )
    ? CURRENCY_CODES
    : [...CURRENCY_CODES, shownBudget];
  const [resetOpen, setResetOpen] = useState(false);

  // Sent to the server first; this device follows once it has accepted the change (M2)
  function applyCurrency(code: string) {
    saveCurrency.mutate({ currency: code }, { onSuccess: () => setCurrencyCode(code) });
  }

  function chooseCurrency(code: string) {
    if (code === budget) return;
    // Accounts in other currencies are re-labelled, so say so first
    if (currencyOverview && currencyOverview.currencies.length > 0) setPendingCurrency(code);
    else applyCurrency(code);
  }

  function handleReset() {
    setTheme('light');
    setSidebarMode('persistent');
    setCurrencySymbol('$');
    setDateFormat('MMM d, yyyy');
    setShowMerchantIcons(true);
    setShowCategoryIcons(true);
    setShowAccountIcons(true);
    setResetOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text">Preferences</h2>
          <p className="text-xs text-text-tertiary mt-0.5">
            {IS_DEMO
              ? 'Settings are kept in this tab while you try the demo.'
              : 'Settings are saved automatically to your browser.'}
          </p>
        </div>
        <button
          onClick={() => setResetOpen(true)}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          Reset to defaults
        </button>
      </div>

      <ConfirmModal
        isOpen={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={handleReset}
        title="Reset preferences"
        message="Are you sure you want to reset all preferences to their default values?"
        confirmLabel="Reset"
        danger
      />

      {confirming.value && (
        <ConfirmModal
          isOpen={confirming.isOpen}
          onClose={() => setPendingCurrency(null)}
          onConfirm={() => {
            if (confirming.value) applyCurrency(confirming.value);
          }}
          title="Change the budget currency"
          message={budgetCurrencyChangeText(budget, confirming.value)}
          confirmLabel="Change currency"
        />
      )}

      <div className="bg-surface-alt rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-medium text-text">Theme</h3>
        <div className="flex gap-3">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={`px-4 py-2 text-sm rounded-md border transition-colors ${
                theme === opt.value
                  ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                  : 'border-border bg-surface text-text-secondary hover:border-border'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-surface-alt rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-medium text-text">Sidebar</h3>
        <div className="flex gap-3">
          {sidebarModes.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSidebarMode(opt.value)}
              className={`flex flex-col px-4 py-2 text-sm rounded-md border transition-colors ${
                sidebarMode === opt.value
                  ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                  : 'border-border bg-surface text-text-secondary hover:border-border'
              }`}
            >
              <span>{opt.label}</span>
              <span className="text-xs text-text-tertiary font-normal mt-0.5">
                {opt.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-surface-alt rounded-lg p-5 space-y-5">
        <h3 className="text-sm font-medium text-text">Icons</h3>
        {(
          [
            {
              label: 'Merchant',
              description: 'Merchant logos (or colored initials) next to merchant names',
              value: showMerchantIcons,
              setter: setShowMerchantIcons,
            },
            {
              label: 'Category',
              description: 'Emoji icons next to category names',
              value: showCategoryIcons,
              setter: setShowCategoryIcons,
            },
            {
              label: 'Account',
              description: 'Account logos (or colored initials) next to account names',
              value: showAccountIcons,
              setter: setShowAccountIcons,
            },
          ] as const
        ).map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm text-text">{row.label}</div>
              <div className="text-xs text-text-tertiary mt-0.5">{row.description}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              {[
                { v: true, l: 'Show' },
                { v: false, l: 'Hide' },
              ].map((opt) => (
                <button
                  key={String(opt.v)}
                  onClick={() => row.setter(opt.v)}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors cursor-pointer ${
                    row.value === opt.v
                      ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                      : 'border-border bg-surface text-text-secondary hover:border-border'
                  }`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-surface-alt rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-medium text-text">Budget Currency</h3>
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Budget currency"
            value={shownBudget}
            disabled={!canSave || saveCurrency.isPending}
            onChange={(e) => chooseCurrency(e.target.value)}
            className="min-w-24 text-sm border border-border rounded-md px-3 py-1.5 bg-surface text-text focus:outline-none focus:ring-1 focus:ring-brand-600 focus:border-brand-600 max-md:min-h-11 disabled:opacity-50"
          >
            {budgetCodeOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <span className="text-xs text-text-tertiary">
            Accounts in another currency are converted with the rates in Settings → Currencies.
          </span>
        </div>
        <SavingPausedHint />
        {saveCurrency.error && (
          <p role="alert" className="text-xs text-negative">
            {saveCurrency.error.message}
          </p>
        )}
      </div>

      <div className="bg-surface-alt rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-medium text-text">Currency Symbol</h3>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={currencySymbol}
            onChange={(e) => setCurrencySymbol(e.target.value.slice(0, 3))}
            maxLength={3}
            className="w-20 text-center text-sm border border-border rounded-md px-3 py-1.5 bg-surface text-text focus:outline-none focus:ring-1 focus:ring-brand-600 focus:border-brand-600"
          />
          <span className="text-xs text-text-tertiary">Max 3 characters (e.g. $, EUR, &#163;)</span>
        </div>
      </div>

      <div className="bg-surface-alt rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-medium text-text">Date Format</h3>
        <div className="grid grid-cols-2 gap-2">
          {dateFormats.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDateFormat(opt.value)}
              className={`flex items-center justify-between px-4 py-2.5 text-sm rounded-md border transition-colors ${
                dateFormat === opt.value
                  ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                  : 'border-border bg-surface text-text-secondary hover:border-border'
              }`}
            >
              <span>{opt.label}</span>
              <span className="text-xs text-text-tertiary">{opt.example}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
