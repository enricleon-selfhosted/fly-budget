import { useState } from 'react';
import { Landmark, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useCanSave } from '../../hooks/useConnection';
import {
  useEnableBankingConnections,
  useEnableBankingStatus,
  useSyncAllEnableBanking,
} from '../../hooks/useEnableBanking';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { docsUrl } from '../../utils/project';
import type { EnableBankingConnection, EnableBankingStatus } from '../../types';
import { EnableBankingConfigForm, EnableBankingConfigSummary } from './EnableBankingConfigForm';
import { EnableBankingConnectionCard } from './EnableBankingConnectionCard';
import { EnableBankingConnectModal } from './EnableBankingConnectModal';
import { plural } from './model';

const NO_CONNECTIONS: EnableBankingConnection[] = [];

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 size={24} className="animate-spin text-text-tertiary" aria-label="Loading" />
    </div>
  );
}

/** The Enable Banking part of Settings → Connected Banks */
export function EnableBankingPanel() {
  const { data: status, isPending, isError, refetch } = useEnableBankingStatus();

  if (isPending) return <Spinner />;
  if (!status) {
    return (
      <div className="bg-surface-alt rounded-lg px-5 py-8 text-center space-y-3">
        <p className="text-xs text-text-secondary">
          {isError ? "Couldn't load the Enable Banking settings." : 'Nothing to show yet.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!status.configured) return <EnableBankingConfigForm status={status} />;
  return <ConfiguredPanel status={status} />;
}

function ConfiguredPanel({ status }: { status: EnableBankingStatus }) {
  const connections = useEnableBankingConnections();
  const syncAll = useSyncAllEnableBanking();
  const canSave = useCanSave();
  const [connectOpen, setConnectOpen] = useState(false);

  if (connections.isPending) return <Spinner />;
  if (connections.isError && !connections.data) {
    return (
      <div className="bg-surface-alt rounded-lg px-5 py-8 text-center space-y-3">
        <p className="text-xs text-text-secondary">{connections.error.message}</p>
        <Button variant="secondary" size="sm" onClick={() => connections.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const list = connections.data ?? NO_CONNECTIONS;

  const syncedResults = syncAll.data?.results ?? [];
  const syncedTotal = syncedResults.reduce((sum, r) => sum + r.added, 0);
  const syncedErrors = syncedResults.flatMap((r) => r.errors.map((e) => `${r.aspspName}: ${e}`));

  return (
    <div className="space-y-5">
      {syncAll.isSuccess && (
        <div className="bg-positive-subtle border border-positive/10 rounded-md px-4 py-2 space-y-1">
          <p className="text-xs text-positive">
            Enable Banking sync complete: {plural(syncedTotal, 'new transaction')} imported.
          </p>
          {syncedErrors.map((error) => (
            <p key={error} className="text-xs text-negative">
              {error}
            </p>
          ))}
        </div>
      )}
      {syncAll.isError && (
        <p role="alert" className="text-xs text-negative">
          {syncAll.error.message}
        </p>
      )}

      {list.length > 0 ? (
        <div className="space-y-3">
          {list.map((connection) => (
            <EnableBankingConnectionCard key={connection.id} connection={connection} />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConnectOpen(true)}
              disabled={!canSave}
            >
              <Plus size={14} /> Connect a bank
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => syncAll.mutate()}
              disabled={syncAll.isPending || !canSave}
            >
              {syncAll.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Syncing...
                </>
              ) : (
                <>
                  <RefreshCw size={12} /> Sync all
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="bg-surface-alt rounded-lg">
          <EmptyState
            icon={<Landmark size={22} />}
            title="Connect your first European bank"
            description="Choose your country and bank, approve access there, then pick the accounts to import. Only accounts you linked in Enable Banking can be read."
            actions={
              <Button onClick={() => setConnectOpen(true)} disabled={!canSave}>
                <Plus size={14} /> Connect a bank
              </Button>
            }
            learnMoreHref={docsUrl('bank-sync')}
          />
        </div>
      )}
      <SavingPausedHint />

      <div className="bg-surface-alt rounded-lg p-5">
        <EnableBankingConfigSummary status={status} />
      </div>

      <EnableBankingConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}
