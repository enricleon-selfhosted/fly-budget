import { logError } from '../../utils/log.js';
import { cleanText } from '../../utils/text.js';
import { openAccount, setBalanceTo } from '../accountService.js';
import { importTransactions } from '../bankSync/importTransactions.js';
import type { ImportResult } from '../bankSync/types.js';
import type { EnableBankingApi, PsuHeaders } from './client.js';
import { createEnableBankingDataSource } from './dataSource.js';
import { ReauthRequiredError, enableBankingErrorMessage } from './errors.js';
import { consentEnded, localDay, shouldSkipBackgroundSync, syncWindowStart } from './rules.js';
import { enableBankingStore } from './store.js';

// Syncing a connection: read each imported account from where it left off, import through
// the bank-sync core, record the bank's balance (decisions D7–D10). The rules are in rules.ts.

/** The import counts a sync reports, summed over the connection's accounts */
const COUNTS = ['added', 'matched', 'transfers'] as const;
type ImportCounts = Pick<ImportResult, (typeof COUNTS)[number]>;

export type SyncResult = ImportCounts & {
  connectionId: string;
  aspspName: string;
  status: 'good' | 'error' | 'reauth_required';
  errors: string[];
  /** A background sync that didn't run because the connection synced recently */
  skipped?: boolean;
};

/** A sync of this connection that imported nothing (yet) */
export function emptySyncResult(
  connection: { id: string; aspspName: string },
  status: SyncResult['status'] = 'good',
): SyncResult {
  const counts = Object.fromEntries(COUNTS.map((k) => [k, 0])) as ImportCounts;
  return {
    connectionId: connection.id,
    aspspName: connection.aspspName,
    ...counts,
    status,
    errors: [],
  };
}

/** The result with one account's import added in */
export function addCounts(result: SyncResult, imported: ImportCounts): SyncResult {
  const sum = { ...result };
  for (const k of COUNTS) sum[k] += imported[k];
  return sum;
}

export type SyncDeps = { api: EnableBankingApi; now: () => number };
export type SyncOptions = { psu?: PsuHeaders; background?: boolean };

const running = new Map<string, Promise<SyncResult>>();

/** Syncs one connection. A sync already running for it is shared, not started twice. */
export function syncConnection(
  connectionId: string,
  deps: SyncDeps,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const current = running.get(connectionId);
  if (current) return current;
  const run = runSync(connectionId, deps, options).finally(() => running.delete(connectionId));
  running.set(connectionId, run);
  return run;
}

async function runSync(
  connectionId: string,
  { api, now }: SyncDeps,
  { psu, background }: SyncOptions,
): Promise<SyncResult> {
  const connection = enableBankingStore.getConnection(connectionId);
  if (!connection) throw new Error('Enable Banking connection not found');
  let result = emptySyncResult(connection);

  const startedAt = now();
  const lastAttempt = connection.lastAttemptAt ?? connection.lastSyncedAt;
  if (background && shouldSkipBackgroundSync(lastAttempt, startedAt)) {
    const status = connection.syncStatus === 'syncing' ? 'good' : connection.syncStatus;
    return { ...result, skipped: true, status: status as SyncResult['status'] };
  }
  if (consentEnded(connection.validUntil, startedAt)) {
    const message = enableBankingErrorMessage(new ReauthRequiredError('consent ended'), '');
    enableBankingStore.setStatus(connectionId, 'reauth_required', { syncError: message });
    return { ...result, status: 'reauth_required', errors: [message] };
  }

  const startedIso = new Date(startedAt).toISOString();
  enableBankingStore.setStatus(connectionId, 'syncing', { lastAttemptAt: startedIso });
  const today = localDay(startedAt);
  const ownAccountsByIbanHash = enableBankingStore.ownAccountsByIbanHash();

  for (const bank of enableBankingStore.listAccounts(connectionId)) {
    if (!bank.accountId || !bank.isEnabled || !bank.inConsent || !bank.currency) continue;
    const local = openAccount(bank.accountId);
    if (!local) continue;

    const source = createEnableBankingDataSource(api, bank.accountUid, {
      psu,
      onUnreadable: (n) =>
        logError('Enable Banking sync', `${n} unreadable transaction(s) skipped in ${bank.id}`),
    });
    try {
      const remote = await source.fetchTransactions(
        syncWindowStart(bank.syncFrom, bank.lastSyncedAt, today),
      );
      const imported = importTransactions(
        {
          accountId: local.id,
          importedIdPrefix: `enablebanking:${bank.identificationHash}:`,
          currency: bank.currency,
        },
        remote,
        { ownAccountsByIbanHash },
      );
      result = addCounts(result, imported);
      // The next sync of this account reads from a little before now
      enableBankingStore.updateAccount(bank.id, { lastSyncedAt: startedIso });
      if (imported.otherCurrency > 0)
        logError(
          'Enable Banking sync',
          `${imported.otherCurrency} transaction(s) in another currency skipped in ${bank.id}`,
        );

      const balance = await source.fetchBalance();
      if (balance && balance.currency === bank.currency) {
        // Accounts created from the bank start where the bank says they are (D7)
        if (bank.openingBalancePending) setBalanceTo(local.id, balance.amount, balance.date);
        enableBankingStore.updateAccount(bank.id, {
          bankBalance: balance.amount,
          bankBalanceAt: new Date(now()).toISOString(),
          openingBalancePending: 0,
        });
      }
    } catch (err) {
      logError(`Enable Banking sync of ${cleanText(connection.aspspName, 200)}`, err);
      const message = enableBankingErrorMessage(err, `Could not sync ${bank.name}.`);
      if (err instanceof ReauthRequiredError) {
        enableBankingStore.setStatus(connectionId, 'reauth_required', { syncError: message });
        return { ...result, status: 'reauth_required', errors: [message] };
      }
      result.errors.push(message);
    }
  }

  if (result.errors.length) {
    // Each account keeps its own last sync, so the ones that failed are read from there next time
    result.status = 'error';
    enableBankingStore.setStatus(connectionId, 'error', { syncError: result.errors[0] });
  } else {
    enableBankingStore.setStatus(connectionId, 'good', { lastSyncedAt: startedIso });
  }
  return result;
}
