import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { NotInDemoModal } from '../demo/NotInDemo';
import { IS_DEMO } from '../../demo/isDemo';
import { useCanSave } from '../../hooks/useConnection';
import { useFormReset } from '../../hooks/useFormReset';
import {
  useEnableBankingAspsps,
  useSyncEnableBankingConnection,
} from '../../hooks/useEnableBanking';
import { useEnableBankingConsent } from '../../hooks/useEnableBankingConsent';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { EnableBankingAccountMapping } from './EnableBankingAccountMapping';
import {
  EEA_COUNTRIES,
  accountsToMapAfterConsent,
  defaultCountry,
  describeSync,
  plural,
  psuOptions,
  stepAfterConsent,
  stepAfterMapping,
} from './model';
import { choiceClass, fieldClass, labelClass } from './styles';
import type { StartConsentInput } from '../../api/enableBanking';
import type {
  EnableBankingAccount,
  EnableBankingAspsp,
  EnableBankingConnection,
  EnableBankingConsentResult,
  EnableBankingMappingResult,
  EnableBankingSyncResult,
} from '../../types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Renew this connection's access instead of connecting a bank */
  renewConnection?: EnableBankingConnection;
}

type Step = 'bank' | 'consent' | 'accounts' | 'syncing' | 'done';

const NO_BANKS: EnableBankingAspsp[] = [];

/** Connect a bank through Enable Banking: bank → consent at the bank → accounts → sync */
export function EnableBankingConnectModal(props: Props) {
  // The demo has no server to talk to the bank, so it explains that instead
  return IS_DEMO ? (
    <NotInDemoModal isOpen={props.open} onClose={props.onClose} />
  ) : (
    <ConnectDialog {...props} />
  );
}

function ConnectDialog({ open, onClose, renewConnection }: Props) {
  const renewing = renewConnection !== undefined;
  const ids = useId();
  const canSave = useCanSave();
  const [step, setStep] = useState<Step>('bank');
  const [country, setCountry] = useState(() => defaultCountry(navigator.language));
  const [bankName, setBankName] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [psuChoice, setPsuChoice] = useState<'personal' | 'business'>('personal');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [accountsToMap, setAccountsToMap] = useState<EnableBankingAccount[]>([]);
  const [mapping, setMapping] = useState<EnableBankingMappingResult | null>(null);
  const [sync, setSync] = useState<EnableBankingSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const banksQuery = useEnableBankingAspsps(renewing ? null : country);
  const banks = banksQuery.data ?? NO_BANKS;
  const syncConnection = useSyncEnableBankingConnection();

  const shownBanks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...banks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((b) => q === '' || b.name.toLowerCase().includes(q));
  }, [banks, search]);

  const selected = banks.find((b) => b.name === bankName) ?? null;
  const psuTypes = selected ? psuOptions(selected.psuTypes) : [];
  const psu = psuTypes.includes(psuChoice) ? psuChoice : (psuTypes[0] ?? 'personal');
  const bankLabel = renewConnection?.aspspName ?? selected?.name ?? 'your bank';

  const bankInput: StartConsentInput | null = selected
    ? { aspspName: selected.name, country, psuType: psu }
    : null;
  // The same request each time this connection is renewed (on opening, and from Try again)
  const renewInput = useMemo<StartConsentInput | null>(
    () =>
      renewConnection
        ? {
            aspspName: renewConnection.aspspName,
            country: renewConnection.aspspCountry,
            connectionId: renewConnection.id,
          }
        : null,
    [renewConnection],
  );
  const consentInput = renewing ? renewInput : bankInput;

  const consent = useEnableBankingConsent(handleConsented);
  const { state: consentState, start, submitAddress, reopen, cancel } = consent;

  // Each opening starts at the first step (renewing: straight at the bank's consent)
  useFormReset(open ? 'open' : null, () => {
    setStep(renewing ? 'consent' : 'bank');
    setCountry(defaultCountry(navigator.language));
    setBankName(null);
    setSearch('');
    setPsuChoice('personal');
    setConnectionId(null);
    setAccountsToMap([]);
    setMapping(null);
    setSync(null);
    setSyncError(null);
  });

  // Renewing starts the consent as soon as the dialog opens, once per opening
  const renewStarted = useRef(false);
  useEffect(() => {
    if (!open) {
      renewStarted.current = false;
      return;
    }
    if (!renewInput || renewStarted.current) return;
    renewStarted.current = true;
    void start(renewInput);
  }, [open, renewInput, start]);

  function handleConsented(result: EnableBankingConsentResult) {
    setConnectionId(result.connectionId);
    const toMap = accountsToMapAfterConsent(result.accounts, renewing);
    setAccountsToMap(toMap);
    const next = stepAfterConsent(toMap.length, renewing);
    if (next === 'sync') void runSync(result.connectionId);
    else setStep(next);
  }

  async function runSync(id: string) {
    setStep('syncing');
    try {
      setSync(await syncConnection.mutateAsync(id));
    } catch (err) {
      setSyncError((err as Error).message);
    }
    setStep('done');
  }

  function handleMapped(result: EnableBankingMappingResult) {
    setMapping(result);
    if (stepAfterMapping(result, renewing) === 'done') setStep('done');
    else if (connectionId) void runSync(connectionId);
  }

  function beginConsent(input: StartConsentInput) {
    setStep('consent');
    void start(input);
  }

  function cancelConsent() {
    cancel();
    if (renewing) onClose();
    else setStep('bank');
  }

  function handleClose() {
    cancel();
    onClose();
  }

  const nameOf = (accountId: string) =>
    accountsToMap.find((a) => a.id === accountId)?.name ?? 'Account';

  const title = renewConnection
    ? `Renew access to ${renewConnection.aspspName}`
    : 'Connect a European bank';

  return (
    <Modal isOpen={open} onClose={handleClose} title={title} size="lg">
      {step === 'bank' && (
        <div className="space-y-4">
          <p className="text-xs text-text-secondary leading-relaxed">
            Choose your bank. You log in and approve access on the bank&apos;s own page, in your
            browser. FlyBudget never sees your bank login.
          </p>

          <div>
            <label htmlFor={`${ids}-country`} className={labelClass}>
              Country
            </label>
            <select
              id={`${ids}-country`}
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setBankName(null);
              }}
              className={fieldClass}
            >
              {EEA_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={`${ids}-search`} className={labelClass}>
              Bank
            </label>
            <input
              id={`${ids}-search`}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search banks"
              autoComplete="off"
              className={fieldClass}
            />
          </div>

          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            {banksQuery.isPending ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={20} className="animate-spin text-text-tertiary" />
                <span className="sr-only">Loading banks</span>
              </div>
            ) : banksQuery.isError ? (
              <p className="p-4 text-xs text-negative">{banksQuery.error.message}</p>
            ) : shownBanks.length === 0 ? (
              <p className="p-4 text-xs text-text-tertiary">
                {banks.length === 0
                  ? 'Enable Banking lists no banks for this country.'
                  : 'No banks match your search.'}
              </p>
            ) : (
              <ul className="divide-y divide-border-light">
                {shownBanks.map((bank) => {
                  const isSelected = bank.name === bankName;
                  return (
                    <li key={bank.name}>
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          setBankName(bank.name);
                          setPsuChoice('personal');
                        }}
                        className={`w-full text-left px-3 py-2.5 max-md:min-h-11 flex items-center justify-between gap-3 transition-colors ${
                          isSelected ? 'bg-brand-50' : 'hover:bg-hover'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="text-sm text-text">{bank.name}</span>
                          {bank.beta && (
                            <span className="ml-2 text-[10px] font-medium text-caution bg-caution-subtle px-1.5 py-0.5 rounded">
                              Beta
                            </span>
                          )}
                          {bank.maximumConsentDays !== null && (
                            <span className="block text-xs text-text-tertiary">
                              Access for up to {bank.maximumConsentDays} days
                            </span>
                          )}
                        </span>
                        {isSelected && (
                          <Check size={14} className="text-brand-600 shrink-0" aria-hidden />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected && psuTypes.length > 1 && (
            <fieldset className="space-y-1">
              <legend className={labelClass}>Account type</legend>
              {psuTypes.map((type) => (
                <label key={type} className={choiceClass}>
                  <input
                    type="radio"
                    name={`${ids}-psu`}
                    checked={psu === type}
                    onChange={() => setPsuChoice(type)}
                    className="mt-1 accent-brand-600"
                  />
                  <span>{type === 'personal' ? 'Personal account' : 'Business account'}</span>
                </label>
              ))}
            </fieldset>
          )}

          <SavingPausedHint className="text-right" />
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={() => bankInput && beginConsent(bankInput)}
              disabled={!bankInput || !canSave}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 'consent' &&
        (consentState.phase === 'waiting' ? (
          <ConsentWaiting
            bankName={bankLabel}
            submitting={consentState.submitting}
            pasteError={consentState.pasteError}
            onReopen={reopen}
            onCancel={cancelConsent}
            onSubmitAddress={submitAddress}
          />
        ) : consentState.phase === 'error' ? (
          <div className="text-center py-6 space-y-4">
            <p role="alert" className="text-sm text-negative">
              {consentState.message}
            </p>
            <div className="flex justify-center gap-2">
              <Button variant="secondary" onClick={cancelConsent}>
                {renewing ? 'Close' : 'Back to banks'}
              </Button>
              {consentInput && (
                <Button onClick={() => beginConsent(consentInput)}>Try again</Button>
              )}
            </div>
          </div>
        ) : (
          <div role="status" className="text-center py-10">
            <Loader2 size={32} className="animate-spin text-brand-500 mx-auto mb-4" aria-hidden />
            <p className="text-sm text-text">Opening {bankLabel}...</p>
          </div>
        ))}

      {step === 'accounts' && connectionId && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-text">
              {renewing ? 'New accounts' : 'Choose accounts to import'}
            </h3>
            <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              {renewing
                ? `${bankLabel} shares accounts you haven't imported yet. Choose how to import them.`
                : 'Import each account as a new account, add it to one you already have, or skip it. You can change this later under Manage accounts.'}
            </p>
          </div>
          <EnableBankingAccountMapping
            connectionId={connectionId}
            accounts={accountsToMap}
            submitLabel="Save and sync"
            onDone={handleMapped}
          />
        </div>
      )}

      {step === 'syncing' && (
        <div role="status" className="text-center py-10">
          <Loader2 size={40} className="animate-spin text-brand-500 mx-auto mb-4" aria-hidden />
          <h3 className="text-sm font-semibold text-text">Importing transactions</h3>
          <p className="text-xs text-text-secondary mt-1">This can take a minute.</p>
        </div>
      )}

      {step === 'done' && (
        <DoneSummary
          title={renewing ? 'Access renewed' : 'Bank connected'}
          lines={[
            ...(mapping && mapping.created > 0
              ? [`${plural(mapping.created, 'account')} created`]
              : []),
            ...(mapping && mapping.linked > 0
              ? [`${plural(mapping.linked, 'account')} linked to existing accounts`]
              : []),
            ...(sync ? describeSync(sync) : []),
          ]}
          emptyMessage={
            !renewing && accountsToMap.length === 0
              ? 'The bank didn’t share any accounts.'
              : 'No accounts were imported yet. Use Manage accounts on the connection to import them.'
          }
          errors={[
            ...(mapping?.errors.map((e) => `${nameOf(e.id)}: ${e.error}`) ?? []),
            ...(sync?.errors ?? []),
            ...(syncError ? [`Transactions weren't imported: ${syncError}`] : []),
          ]}
          onDone={handleClose}
        />
      )}
    </Modal>
  );
}

interface WaitingProps {
  bankName: string;
  submitting: boolean;
  pasteError?: string;
  onReopen: () => void;
  onCancel: () => void;
  onSubmitAddress: (address: string) => void;
}

/**
 * Shown while the user approves access in their browser. The bank sends the browser to the
 * redirect address; when that isn't FlyBudget's own, the user pastes the address here.
 */
function ConsentWaiting({
  bankName,
  submitting,
  pasteError,
  onReopen,
  onCancel,
  onSubmitAddress,
}: WaitingProps) {
  const ids = useId();
  const [address, setAddress] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (address.trim() && !submitting) onSubmitAddress(address);
  }

  return (
    <div className="space-y-5">
      <div role="status" className="text-center space-y-3">
        <Loader2 size={28} className="animate-spin text-brand-600 mx-auto" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-text">
            Finish at your bank in the browser window that opened
          </h3>
          <p className="text-xs text-text-secondary mt-1 max-w-sm mx-auto leading-relaxed">
            Log in to {bankName} and approve access. FlyBudget continues automatically when
            you&apos;re done.
          </p>
        </div>
        <p className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <ShieldCheck size={12} aria-hidden /> Your bank login happens on the bank&apos;s own page,
          never in FlyBudget.
        </p>
        <div className="flex justify-center gap-2">
          <Button variant="secondary" onClick={onReopen}>
            <ExternalLinkIcon size={14} aria-hidden /> Open bank page again
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-surface-alt rounded-lg p-4 space-y-3">
        <p className="text-xs text-text-secondary leading-relaxed">
          If your browser didn&apos;t come back to FlyBudget, paste the address of the page it shows
          here.
        </p>
        <div>
          <label htmlFor={`${ids}-address`} className={labelClass}>
            Address of that page
          </label>
          <input
            id={`${ids}-address`}
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…?code=…&state=…"
            className={`${fieldClass} font-mono text-xs`}
          />
        </div>
        {pasteError && (
          <p role="alert" className="text-xs text-negative">
            {pasteError}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!address.trim() || submitting}
          >
            {submitting ? 'Checking...' : 'Continue'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function DoneSummary({
  title,
  lines,
  emptyMessage,
  errors,
  onDone,
}: {
  title: string;
  lines: string[];
  emptyMessage: string;
  errors: string[];
  onDone: () => void;
}) {
  return (
    <div className="py-4 space-y-5">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-positive-subtle flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 size={32} className="text-positive" aria-hidden />
        </div>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
      </div>

      {lines.length > 0 ? (
        <ul className="text-xs text-text-secondary space-y-1 list-disc pl-5 max-w-sm mx-auto">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        errors.length === 0 && (
          <p className="text-xs text-text-secondary text-center">{emptyMessage}</p>
        )
      )}

      {errors.length > 0 && (
        <ul
          role="alert"
          className="text-xs text-negative space-y-1 list-disc pl-5 max-w-sm mx-auto"
        >
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-center">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
