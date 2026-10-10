import { useId, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useCanSave } from '../../hooks/useConnection';
import { useFormReset } from '../../hooks/useFormReset';
import {
  useConfigureEnableBanking,
  useRemoveEnableBankingConfig,
} from '../../hooks/useEnableBanking';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { ExternalLink } from '../ui/ExternalLink';
import { docsUrl } from '../../utils/project';
import type { EnableBankingStatus } from '../../types';
import { isHttpsUrl } from './model';
import { fieldClass, hintClass, labelClass } from './styles';

const APPLICATIONS_URL = 'https://enablebanking.com/cp/applications';

/** The address to suggest when the server's own callback isn't https (Enable Banking needs https) */
const EXAMPLE_REDIRECT_URL = 'https://localhost/flybudget-callback';

interface Props {
  status: EnableBankingStatus;
  /** Changing an existing setup: called after a successful save */
  onDone?: () => void;
  onCancel?: () => void;
}

/**
 * The Enable Banking application details. Not configured: the setup steps and the form.
 * Configured: the form to change them (see EnableBankingConfigSummary).
 */
export function EnableBankingConfigForm({ status, onDone, onCancel }: Props) {
  const ids = useId();
  const [applicationId, setApplicationId] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const configure = useConfigureEnableBanking();
  const canSave = useCanSave();

  // Filled once when the form opens. A refetched status (the save itself changes it) must
  // not overwrite what the user is typing.
  useFormReset('open', () => {
    setApplicationId(status.applicationId ?? '');
    setRedirectUrl(
      status.redirectUrl ??
        (isHttpsUrl(status.suggestedRedirectUrl) ? status.suggestedRedirectUrl : ''),
    );
    setPrivateKey('');
    setKeyFileName(null);
    setKeyError(null);
  });

  const configured = status.configured;
  // Changing the setup keeps the stored key unless a new one is given
  const canSubmit =
    applicationId.trim() !== '' &&
    redirectUrl.trim() !== '' &&
    (configured || privateKey.trim() !== '');

  async function handleKeyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setPrivateKey((await file.text()).trim());
      setKeyFileName(file.name);
      setKeyError(null);
    } catch {
      setKeyError("FlyBudget couldn't read that file. Paste the key's text below instead.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !canSave || configure.isPending) return;
    try {
      await configure.mutateAsync({
        applicationId: applicationId.trim(),
        privateKey: privateKey.trim() || undefined,
        redirectUrl: redirectUrl.trim(),
      });
      onDone?.();
    } catch {
      // Shown below the form
    }
  }

  const appIdId = `${ids}-app-id`;
  const keyFileId = `${ids}-key-file`;
  const keyId = `${ids}-key`;
  const redirectId = `${ids}-redirect`;
  const suggestedIsHttps = isHttpsUrl(status.suggestedRedirectUrl);

  return (
    <div className="space-y-6">
      {!configured && (
        <div className="bg-brand-50 border border-brand-100 rounded-lg p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
              <KeyRound size={20} className="text-white" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text">Set up Enable Banking</h3>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                Enable Banking connects FlyBudget to banks across Europe (PSD2). You register a free
                application for personal use, link the accounts you want to read, and FlyBudget does
                the rest. Setup takes about 15 minutes.
              </p>
            </div>
          </div>

          <ol className="space-y-4 text-xs text-text-secondary leading-relaxed list-decimal pl-5 marker:font-medium marker:text-text">
            <li className="pl-1">
              Create an account at enablebanking.com and register an application. Choose{' '}
              <strong className="font-medium text-text">Production</strong>.{' '}
              <ExternalLink
                href={APPLICATIONS_URL}
                className="font-medium text-brand-600 hover:text-brand-700"
              >
                Open the application page
              </ExternalLink>
            </li>
            <li className="pl-1 space-y-2">
              <span>Add a redirect URL to the application.</span>
              {suggestedIsHttps ? (
                <>
                  <span className="block">Add this address:</span>
                  <CopyAddress address={status.suggestedRedirectUrl} />
                  <span className="block">
                    After you approve access at your bank, your browser returns here and FlyBudget
                    picks it up on its own.
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    FlyBudget isn&apos;t reachable over https here, and Enable Banking only accepts
                    https redirect URLs. Add any https address, for example:
                  </span>
                  <CopyAddress address={EXAMPLE_REDIRECT_URL} />
                  <span className="block">
                    After you approve access at your bank, your browser opens that address. It may
                    show an error page; that&apos;s expected. Copy the full address from the
                    browser&apos;s address bar and paste it into FlyBudget when asked.
                  </span>
                </>
              )}
            </li>
            <li className="pl-1">
              Download the private key (a <code className="font-mono">.pem</code> file) and keep it
              safe. You&apos;ll add it below.
            </li>
            <li className="pl-1">
              In the Enable Banking control panel, choose{' '}
              <strong className="font-medium text-text">Activate by linking accounts</strong> and
              link the accounts you want FlyBudget to read. Only linked accounts can be read. This
              restricted mode is free for personal use.
            </li>
          </ol>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-surface-alt rounded-lg p-5 space-y-4"
        aria-label="Enable Banking application"
      >
        <div>
          <label htmlFor={appIdId} className={labelClass}>
            Application ID
          </label>
          <input
            id={appIdId}
            type="text"
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Shown on the application's page"
            className={`${fieldClass} font-mono`}
          />
        </div>

        <div>
          <label htmlFor={keyFileId} className={labelClass}>
            Private key file (.pem)
          </label>
          <input
            id={keyFileId}
            type="file"
            accept=".pem,application/x-pem-file,text/plain"
            onChange={handleKeyFile}
            className="block w-full text-xs text-text-secondary file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-2 file:text-xs file:font-medium file:text-text-secondary hover:file:bg-hover max-md:file:min-h-11"
          />
          {keyFileName && <p className={hintClass}>Loaded {keyFileName}.</p>}
          {keyError && <p className="text-xs text-negative mt-1">{keyError}</p>}
        </div>

        <div>
          <label htmlFor={keyId} className={labelClass}>
            Private key
          </label>
          <textarea
            id={keyId}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder="-----BEGIN PRIVATE KEY-----"
            className={`${fieldClass} font-mono text-xs leading-relaxed`}
          />
          <p className={hintClass}>
            {configured
              ? 'Leave empty to keep the key FlyBudget already has.'
              : 'Paste the text of the .pem file, including its BEGIN and END lines, or choose the file above.'}
          </p>
        </div>

        <div>
          <label htmlFor={redirectId} className={labelClass}>
            Redirect URL
          </label>
          <input
            id={redirectId}
            type="url"
            inputMode="url"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={EXAMPLE_REDIRECT_URL}
            className={`${fieldClass} font-mono`}
          />
          <p className={hintClass}>
            Must be one of the redirect URLs registered in your application. Enable Banking needs an
            https address.
          </p>
        </div>

        <p className={hintClass}>FlyBudget checks the key with Enable Banking before it saves.</p>

        <SavingPausedHint />
        <div className="flex justify-end gap-2 pt-1">
          {onCancel && (
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={!canSubmit || !canSave || configure.isPending}>
            {configure.isPending ? 'Checking...' : 'Save'}
          </Button>
        </div>
        {configure.isError && (
          <p role="alert" className="text-xs text-negative">
            {configure.error.message}
          </p>
        )}
      </form>

      <p className="text-xs text-text-tertiary">
        <ExternalLink
          href={docsUrl('bank-sync')}
          className="font-medium text-brand-600 hover:text-brand-700"
        >
          Learn more about bank sync
        </ExternalLink>
      </p>
    </div>
  );
}

/** The redirect address and a copy button for it. Copying fails on plain http pages. */
function CopyAddress({ address }: { address: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="text-xs font-mono break-all bg-surface border border-border-light rounded px-2 py-1 text-text">
        {address}
      </code>
      <Button variant="secondary" size="sm" onClick={copy}>
        {state === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        {state === 'copied' ? 'Copied' : 'Copy'}
      </Button>
      {state === 'failed' && (
        <span className="text-xs text-negative">Select the address and copy it by hand.</span>
      )}
    </span>
  );
}

/** The saved setup: its details, Change (the same form) and Remove */
export function EnableBankingConfigSummary({ status }: { status: EnableBankingStatus }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = useRemoveEnableBankingConfig();
  const canSave = useCanSave();

  if (editing) {
    return (
      <EnableBankingConfigForm
        status={status}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text">Enable Banking Configuration</h3>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={!canSave}>
          Change
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-text-tertiary">Application ID</dt>
        <dd className="font-mono text-text-secondary break-all">{status.applicationId}</dd>
        <dt className="text-text-tertiary">Environment</dt>
        <dd className="text-text-secondary">
          {status.environment === 'SANDBOX' ? 'Sandbox' : 'Production'}
        </dd>
        <dt className="text-text-tertiary">Redirect URL</dt>
        <dd className="font-mono text-text-secondary break-all">{status.redirectUrl}</dd>
      </dl>

      {status.connectionCount > 0 && (
        <p className="text-xs text-text-tertiary">
          {status.connectionCount === 1
            ? '1 bank connection uses this setup.'
            : `${status.connectionCount} bank connections use this setup.`}{' '}
          Disconnect them before removing it.
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="text-xs text-negative">
          {remove.error.message}
        </p>
      )}
      <SavingPausedHint />

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-negative hover:bg-negative-subtle"
          onClick={() => setConfirmRemove(true)}
          disabled={!canSave}
        >
          Remove setup
        </Button>
      </div>

      <ConfirmModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
        title="Remove Enable Banking setup"
        message="Delete the application ID, private key and redirect URL from FlyBudget? Disconnect your banks first. Imported accounts and transactions stay."
        confirmLabel="Remove"
        danger
      />
    </div>
  );
}
