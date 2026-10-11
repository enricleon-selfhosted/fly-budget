import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, Plus, Loader2 } from 'lucide-react';
import { usePlaidStatus, usePlaidItems, useSyncAll } from '../../hooks/usePlaid';
import { useSimplefinConnections, useSyncAllSimplefin } from '../../hooks/useSimplefin';
import { useEnableBankingConnections } from '../../hooks/useEnableBanking';
import { PlaidConfigForm } from '../plaid/PlaidConfigForm';
import { ConnectBankModal } from '../plaid/ConnectBankModal';
import { ConnectedInstitutionCard } from '../plaid/ConnectedInstitutionCard';
import { SimplefinConnectModal } from '../simplefin/SimplefinConnectModal';
import { SimplefinConnectionCard } from '../simplefin/SimplefinConnectionCard';
import { SimplefinConfigForm } from '../simplefin/SimplefinConfigForm';
import { EnableBankingPanel } from '../enablebanking/EnableBankingPanel';
import { Button } from '../ui/Button';
import type { EnableBankingConnection, SimplefinSetupResult } from '../../types';
import { IS_DEMO } from '../../demo/demoApi';
import { NotInDemo } from '../demo/NotInDemo';

type Provider = 'plaid' | 'simplefin' | 'enablebanking';

const NO_ENABLE_BANKING: EnableBankingConnection[] = [];

export function ConnectedAccounts() {
  return IS_DEMO ? <ConnectedAccountsDemo /> : <ConnectedAccountsSettings />;
}

/** The demo can't connect banks: say so where the setup would be */
function ConnectedAccountsDemo() {
  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h2 className="text-sm font-semibold text-text">Connected Banks</h2>
        <p className="text-xs text-text-tertiary mt-0.5">
          Automatically import transactions from your financial institutions.
        </p>
      </div>
      <NotInDemo />
    </div>
  );
}

function ConnectedAccountsSettings() {
  const { data: status, isLoading: statusLoading } = usePlaidStatus();
  const { data: items = [], isLoading: itemsLoading } = usePlaidItems();
  const { data: sfConnections = [], isLoading: sfLoading } = useSimplefinConnections();
  const { data: ebConnections = NO_ENABLE_BANKING } = useEnableBankingConnections();
  const syncAll = useSyncAll();
  const syncAllSf = useSyncAllSimplefin();
  // ?provider=enablebanking (a link straight to Enable Banking) opens that tab, until the user picks another
  const [searchParams] = useSearchParams();
  const [chosenProvider, setChosenProvider] = useState<Provider | null>(null);
  const provider: Provider =
    chosenProvider ??
    (searchParams.get('provider') === 'enablebanking' ? 'enablebanking' : 'plaid');
  const [showConnect, setShowConnect] = useState(false);
  const [showSimplefin, setShowSimplefin] = useState(false);
  const [sfSetupResult, setSfSetupResult] = useState<SimplefinSetupResult | undefined>();

  const plaidConfigured = status?.configured ?? false;
  const isLoading = statusLoading || itemsLoading || sfLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-text">Connected Banks</h2>
        <p className="text-xs text-text-tertiary mt-0.5">
          Automatically import transactions from your financial institutions.
        </p>
      </div>

      {/* Provider toggle */}
      <div className="flex max-w-full overflow-x-auto rounded-lg bg-surface-alt p-1 w-fit">
        <button
          onClick={() => setChosenProvider('plaid')}
          className={`whitespace-nowrap shrink-0 px-4 py-1.5 text-sm font-medium rounded-md transition-all duration-200 ease-in-out ${
            provider === 'plaid'
              ? 'bg-surface text-text shadow-sm ring-2 ring-brand-600'
              : 'text-text-tertiary hover:text-text-secondary ring-0 ring-transparent'
          }`}
        >
          Plaid
          {items.length > 0 && (
            <span className="ml-1.5 text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded-full">
              {items.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setChosenProvider('simplefin')}
          className={`whitespace-nowrap shrink-0 px-4 py-1.5 text-sm font-medium rounded-md transition-all duration-200 ease-in-out ${
            provider === 'simplefin'
              ? 'bg-surface text-text shadow-sm ring-2 ring-brand-600'
              : 'text-text-tertiary hover:text-text-secondary ring-0 ring-transparent'
          }`}
        >
          SimpleFIN
          {sfConnections.length > 0 && (
            <span className="ml-1.5 text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded-full">
              {sfConnections.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setChosenProvider('enablebanking')}
          className={`whitespace-nowrap shrink-0 px-4 py-1.5 text-sm font-medium rounded-md transition-all duration-200 ease-in-out ${
            provider === 'enablebanking'
              ? 'bg-surface text-text shadow-sm ring-2 ring-brand-600'
              : 'text-text-tertiary hover:text-text-secondary ring-0 ring-transparent'
          }`}
        >
          Enable Banking<span className="max-md:hidden">&nbsp;(Europe)</span>
          {ebConnections.length > 0 && (
            <span className="ml-1.5 text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded-full">
              {ebConnections.length}
            </span>
          )}
        </button>
      </div>

      {/* Plaid content */}
      {provider === 'plaid' && (
        <div className="space-y-4">
          {syncAll.isSuccess && syncAll.data && (
            <div className="bg-positive-subtle border border-positive/10 rounded-md px-4 py-2">
              <p className="text-xs text-positive">
                Plaid sync complete: {syncAll.data.results.reduce((s, r) => s + r.added, 0)} new
                transactions imported.
              </p>
            </div>
          )}

          {items.length > 0 ? (
            <div className="space-y-3">
              {items.map((item) => (
                <ConnectedInstitutionCard key={item.id} item={item} />
              ))}
              <div className="flex items-center gap-2">
                {plaidConfigured && (
                  <Button variant="secondary" size="sm" onClick={() => setShowConnect(true)}>
                    <Plus size={14} /> Add Another Bank
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => syncAll.mutate()}
                  disabled={syncAll.isPending}
                >
                  {syncAll.isPending ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw size={12} /> Sync All
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : plaidConfigured ? (
            <div className="bg-surface-alt rounded-lg px-5 py-8 text-center">
              <p className="text-xs text-text-tertiary mb-3">No banks connected via Plaid yet.</p>
              <Button onClick={() => setShowConnect(true)}>
                <Plus size={14} /> Connect Bank
              </Button>
            </div>
          ) : null}

          <div className="bg-surface-alt rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-medium text-text">Plaid Configuration</h3>
            {!plaidConfigured && (
              <p className="text-xs text-text-tertiary">
                Enter your Plaid API credentials to enable bank connections.
              </p>
            )}
            <PlaidConfigForm />
          </div>
        </div>
      )}

      {/* SimpleFIN content */}
      {provider === 'simplefin' && (
        <div className="space-y-4">
          {syncAllSf.isSuccess && syncAllSf.data && (
            <div className="bg-positive-subtle border border-positive/10 rounded-md px-4 py-2">
              <p className="text-xs text-positive">
                SimpleFIN sync complete: {syncAllSf.data.results.reduce((s, r) => s + r.added, 0)}{' '}
                new transactions imported.
              </p>
            </div>
          )}

          {sfConnections.length > 0 ? (
            <div className="space-y-3">
              {sfConnections.map((conn) => (
                <SimplefinConnectionCard key={conn.id} connection={conn} />
              ))}
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setShowSimplefin(true)}>
                  <Plus size={14} /> Add Another Connection
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => syncAllSf.mutate()}
                  disabled={syncAllSf.isPending}
                >
                  {syncAllSf.isPending ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> Syncing...
                    </>
                  ) : (
                    <>
                      <RefreshCw size={12} /> Sync All
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="bg-surface-alt rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-medium text-text">SimpleFIN Configuration</h3>
            {sfConnections.length === 0 && (
              <p className="text-xs text-text-tertiary">
                Enter your SimpleFIN setup token to enable bank connections.
              </p>
            )}
            <SimplefinConfigForm
              onSetupComplete={(result) => {
                setSfSetupResult(result);
                setShowSimplefin(true);
              }}
            />
          </div>
        </div>
      )}

      {provider === 'enablebanking' && <EnableBankingPanel />}

      <ConnectBankModal isOpen={showConnect} onClose={() => setShowConnect(false)} />
      <SimplefinConnectModal
        isOpen={showSimplefin}
        onClose={() => {
          setShowSimplefin(false);
          setSfSetupResult(undefined);
        }}
        initialSetupResult={sfSetupResult}
      />
    </div>
  );
}
