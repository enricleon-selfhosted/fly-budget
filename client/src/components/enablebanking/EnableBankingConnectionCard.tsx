import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { format, formatDistanceToNow, isValid } from 'date-fns';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import RowMenu, { type RowMenuItem } from '../ui/RowMenu';
import { EnableBankingAccountMapping } from './EnableBankingAccountMapping';
import { EnableBankingConnectModal } from './EnableBankingConnectModal';
import { useCanSave } from '../../hooks/useConnection';
import { useIsPhone } from '../../hooks/useIsPhone';
import {
  useDisconnectEnableBanking,
  useSyncEnableBankingConnection,
} from '../../hooks/useEnableBanking';
import { useBudgetCurrency } from '../../utils/budgetCurrency';
import { formatCurrency } from '../../utils/currency';
import type {
  EnableBankingAccount,
  EnableBankingConnection,
  EnableBankingMappingResult,
  EnableBankingSyncStatus,
} from '../../types';
import {
  RENEW_WARNING_DAYS,
  accessLeft,
  bankCurrency,
  countryName,
  describeSync,
  plural,
} from './model';

const STATUS_LABEL: Record<EnableBankingSyncStatus, { label: string; dot: string }> = {
  good: { label: 'Synced', dot: 'bg-positive' },
  syncing: { label: 'Syncing...', dot: '' },
  error: { label: 'Error', dot: 'bg-negative' },
  reauth_required: { label: 'Renewal needed', dot: 'bg-caution' },
};

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return isValid(date) ? format(date, 'MMM d, yyyy') : '';
};

interface Props {
  connection: EnableBankingConnection;
}

/** One bank connection: its status, when access ends, its accounts, and what to do with it */
export function EnableBankingConnectionCard({ connection }: Props) {
  const budget = useBudgetCurrency();
  const canSave = useCanSave();
  const isPhone = useIsPhone();
  const sync = useSyncEnableBankingConnection();
  const disconnect = useDisconnectEnableBanking();
  const [manageOpen, setManageOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [mapped, setMapped] = useState<EnableBankingMappingResult | null>(null);

  const access = accessLeft(connection.validUntil, new Date());
  const expired = access?.expired === true;
  const expiresSoon = access !== null && !expired && access.days < RENEW_WARNING_DAYS;
  const renewNeeded = connection.syncStatus === 'reauth_required' || expired || expiresSoon;
  const isSyncing = sync.isPending || connection.syncStatus === 'syncing';
  const initial = connection.aspspName.charAt(0).toUpperCase();
  const status = STATUS_LABEL[connection.syncStatus];

  const syncedText = connection.lastSyncedAt
    ? `Last synced ${formatDistanceToNow(new Date(connection.lastSyncedAt), { addSuffix: true })}`
    : 'Not synced yet';

  let accessText: string | null = null;
  if (access) {
    const until = formatDate(connection.validUntil);
    if (expired) accessText = `Access ended ${until}`;
    else if (expiresSoon) {
      accessText = `Access until ${until} (${access.days >= 1 ? `${plural(access.days, 'day')} left` : 'ends today'})`;
    } else accessText = `Access until ${until}`;
  }

  const nameOf = (accountId: string) =>
    connection.accounts.find((a) => a.id === accountId)?.name ?? 'Account';

  const menuItems: RowMenuItem[] = [
    { label: 'Sync now', onClick: () => sync.mutate(connection.id), hidden: isSyncing || !canSave },
    { label: 'Manage accounts', onClick: () => setManageOpen(true), hidden: !canSave },
    {
      label: 'Disconnect',
      onClick: () => setConfirmDisconnect(true),
      danger: true,
      hidden: !canSave,
    },
  ];

  return (
    <>
      <div className="bg-surface border border-border-light rounded-lg p-5 space-y-4 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              aria-hidden
              className="w-10 h-10 rounded-lg bg-brand-600 flex items-center justify-center text-white font-semibold text-sm shrink-0"
            >
              {initial}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text break-words">
                {connection.aspspName}
              </h3>
              <p className="text-xs text-text-tertiary">{countryName(connection.aspspCountry)}</p>
              <span className="mt-0.5 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                {isSyncing ? (
                  <Loader2 size={12} className="animate-spin text-brand-500" aria-hidden />
                ) : (
                  <span className={`w-2 h-2 rounded-full ${status.dot}`} aria-hidden />
                )}
                {isSyncing ? 'Syncing...' : status.label}
              </span>
            </div>
          </div>
          <span className="text-xs text-text-tertiary text-right shrink-0">{syncedText}</span>
        </div>

        {accessText && (
          <p className={`text-xs ${renewNeeded ? 'text-caution' : 'text-text-secondary'}`}>
            {accessText}
          </p>
        )}

        {connection.syncStatus === 'error' && (
          <div className="flex items-start gap-2 bg-negative-subtle border border-negative/10 rounded-md px-3 py-2">
            <AlertTriangle size={14} className="text-negative mt-0.5 shrink-0" aria-hidden />
            <p className="text-xs text-negative">
              {connection.syncError ?? 'The last sync failed.'}
            </p>
          </div>
        )}
        {connection.syncStatus === 'reauth_required' && (
          <div className="flex items-start gap-2 bg-caution-subtle border border-caution/10 rounded-md px-3 py-2">
            <AlertTriangle size={14} className="text-caution mt-0.5 shrink-0" aria-hidden />
            <p className="text-xs text-caution">
              {connection.syncError ??
                'Access to this bank has ended. Renew it to keep importing transactions.'}
            </p>
          </div>
        )}

        {connection.accounts.length > 0 && (
          <ul className="space-y-2.5 border-t border-border-light pt-3">
            {connection.accounts.map((account) => (
              <AccountLine key={account.id} account={account} budget={budget} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!isPhone && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => sync.mutate(connection.id)}
                disabled={isSyncing || !canSave}
              >
                {isSyncing ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw size={12} /> Sync now
                  </>
                )}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setManageOpen(true)}
                disabled={!canSave}
              >
                Manage accounts
              </Button>
            </>
          )}
          <Button
            variant={renewNeeded ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRenewOpen(true)}
            disabled={!canSave}
          >
            Renew access
          </Button>

          {isPhone ? (
            <span className="ml-auto">
              <RowMenu label={`Actions for ${connection.aspspName}`} items={menuItems} />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
              disabled={!canSave}
              className="ml-auto text-negative hover:bg-negative-subtle"
            >
              <Unlink size={12} /> Disconnect
            </Button>
          )}
        </div>

        {sync.isSuccess && sync.data && (
          <div className="space-y-1">
            <p className="text-xs text-positive">Synced: {describeSync(sync.data).join(', ')}.</p>
            {sync.data.errors.map((error) => (
              <p key={error} className="text-xs text-negative">
                {error}
              </p>
            ))}
          </div>
        )}
        {sync.isError && (
          <p role="alert" className="text-xs text-negative">
            {sync.error.message}
          </p>
        )}
        {mapped && (
          <div className="space-y-1">
            <p className="text-xs text-text-secondary">
              Saved: {plural(mapped.created, 'account')} created, {mapped.linked} linked.
            </p>
            {mapped.errors.map((e) => (
              <p key={e.id} className="text-xs text-negative">
                {nameOf(e.id)}: {e.error}
              </p>
            ))}
          </div>
        )}
        {disconnect.isError && (
          <p role="alert" className="text-xs text-negative">
            {disconnect.error.message}
          </p>
        )}
      </div>

      <Modal
        isOpen={manageOpen}
        onClose={() => setManageOpen(false)}
        title={`Manage accounts at ${connection.aspspName}`}
        size="lg"
      >
        <EnableBankingAccountMapping
          connectionId={connection.id}
          accounts={connection.accounts}
          onDone={(result) => {
            setMapped(result);
            setManageOpen(false);
          }}
        />
      </Modal>

      <EnableBankingConnectModal
        open={renewOpen}
        onClose={() => setRenewOpen(false)}
        renewConnection={connection}
      />

      <ConfirmModal
        isOpen={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => disconnect.mutate(connection.id)}
        title="Disconnect bank"
        message={`Disconnect ${connection.aspspName}? FlyBudget ends its access at Enable Banking and removes this connection here. Imported accounts and transactions stay. If Enable Banking can't be reached, nothing is removed.`}
        confirmLabel="Disconnect"
        danger
      />
    </>
  );
}

/** One bank account of the connection, with its FlyBudget account and any balance gap */
function AccountLine({ account, budget }: { account: EnableBankingAccount; budget: string }) {
  const currency = bankCurrency(account, budget);
  const money = (cents: number) => formatCurrency(cents, currency !== budget ? currency : null);

  const imported =
    account.accountId !== null && account.bankBalance !== null && account.balance !== null
      ? {
          accountId: account.accountId,
          bank: account.bankBalance,
          flyBudget: account.balance,
        }
      : null;
  const differs = imported !== null && imported.bank !== imported.flyBudget;

  let where: string;
  if (!account.isEnabled) where = 'Ignored';
  else if (account.accountId === null) where = 'Not imported yet';
  else where = `→ ${account.accountName ?? 'Account'}`;

  return (
    <li className="space-y-1 text-xs">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words text-text-secondary">
          {account.name}
          {account.ibanMask && (
            <span className="ml-1.5 font-mono text-text-tertiary">{account.ibanMask}</span>
          )}
        </span>
        <span className="shrink-0 text-text-tertiary">{where}</span>
      </div>
      {differs && imported && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-caution">
            Bank: {money(imported.bank)} · FlyBudget: {money(imported.flyBudget)}
          </span>
          <Link
            to={`/accounts/${encodeURIComponent(imported.accountId)}/reconcile`}
            className="font-medium text-brand-600 hover:text-brand-700 max-md:inline-flex max-md:min-h-11 max-md:items-center"
          >
            Reconcile
          </Link>
        </div>
      )}
    </li>
  );
}
