import { eq } from 'drizzle-orm';
import { format, parseISO, subDays } from 'date-fns';
import { db } from '../../db/index.js';
import { accounts } from '../../db/schema.js';
import { logError } from '../../utils/log.js';
import { accountTransactionSum } from '../balances.js';
import { importTransactions } from '../bankSync/importTransactions.js';
import type { EnableBankingApi, PsuHeaders } from './client.js';
import { createEnableBankingDataSource } from './dataSource.js';
import { ReauthRequiredError, enableBankingErrorMessage } from './errors.js';
import { enableBankingStore } from './store.js';

// Syncing a connection: read each imported account from where it left off, import through
// the bank-sync core, record the bank's balance (decisions D7–D10).

/** Background syncs (server start) skip connections synced more recently than this (D10) */
export const BACKGROUND_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Later syncs read again this many days before the last one, for late bookings (D9) */
export const RESYNC_OVERLAP_DAYS = 10;

export type SyncResult = {
  connectionId: string;
  aspspName: string;
  added: number;
  matched: number;
  transfers: number;
  status: 'good' | 'error' | 'reauth_required';
  errors: string[];
  /** A background sync that didn't run because the connection synced recently */
  skipped?: boolean;
};

/** The first day to read: `syncFrom` on the first sync, else a little before the last one */
export function syncWindowStart(
  syncFrom: string | null,
  lastSyncedAt: string | null,
  today: string,
): string {
  const floor = syncFrom ?? format(subDays(parseISO(today), 90), 'yyyy-MM-dd');
  if (!lastSyncedAt) return floor;
  const overlap = format(subDays(parseISO(lastSyncedAt), RESYNC_OVERLAP_DAYS), 'yyyy-MM-dd');
  return overlap > floor ? overlap : floor;
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
  const result: SyncResult = {
    connectionId,
    aspspName: connection.aspspName,
    added: 0,
    matched: 0,
    transfers: 0,
    status: 'good',
    errors: [],
  };

  const startedAt = now();
  if (
    background &&
    connection.lastSyncedAt &&
    startedAt - Date.parse(connection.lastSyncedAt) < BACKGROUND_SYNC_INTERVAL_MS
  ) {
    const status = connection.syncStatus === 'syncing' ? 'good' : connection.syncStatus;
    return { ...result, skipped: true, status: status as SyncResult['status'] };
  }
  if (Date.parse(connection.validUntil) <= startedAt) {
    const message = enableBankingErrorMessage(new ReauthRequiredError('consent ended'), '');
    enableBankingStore.setStatus(connectionId, 'reauth_required', { syncError: message });
    return { ...result, status: 'reauth_required', errors: [message] };
  }

  enableBankingStore.setStatus(connectionId, 'syncing');
  const today = format(startedAt, 'yyyy-MM-dd');
  const ownAccountsByIbanHash = enableBankingStore.ownAccountsByIbanHash();

  for (const bank of enableBankingStore.listAccounts(connectionId)) {
    if (!bank.accountId || !bank.isEnabled || !bank.currency) continue;
    const local = db
      .select({ id: accounts.id, closedAt: accounts.closedAt })
      .from(accounts)
      .where(eq(accounts.id, bank.accountId))
      .get();
    if (!local || local.closedAt) continue;

    const source = createEnableBankingDataSource(api, bank.accountUid, {
      psu,
      onUnreadable: (n) =>
        logError('Enable Banking sync', `${n} unreadable transaction(s) skipped in ${bank.id}`),
    });
    try {
      const remote = await source.fetchTransactions(
        syncWindowStart(bank.syncFrom, connection.lastSyncedAt, today),
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
      result.added += imported.added;
      result.matched += imported.matched;
      result.transfers += imported.transfers;

      const balance = await source.fetchBalance();
      if (balance && balance.currency === bank.currency) {
        if (bank.openingBalancePending) {
          // Accounts created from the bank start where the bank says they are (D7)
          db.update(accounts)
            .set({ startingBalance: balance.amount - accountTransactionSum(local.id) })
            .where(eq(accounts.id, local.id))
            .run();
        }
        enableBankingStore.updateAccount(bank.id, {
          bankBalance: balance.amount,
          bankBalanceAt: new Date(now()).toISOString(),
          openingBalancePending: 0,
        });
      }
    } catch (err) {
      logError(`Enable Banking sync of ${connection.aspspName}`, err);
      const message = enableBankingErrorMessage(err, `Could not sync ${bank.name}.`);
      if (err instanceof ReauthRequiredError) {
        enableBankingStore.setStatus(connectionId, 'reauth_required', { syncError: message });
        return { ...result, status: 'reauth_required', errors: [message] };
      }
      result.errors.push(message);
    }
  }

  if (result.errors.length) {
    // The last sync date stays put, so the accounts that failed are read from there next time
    result.status = 'error';
    enableBankingStore.setStatus(connectionId, 'error', { syncError: result.errors[0] });
  } else {
    enableBankingStore.setStatus(connectionId, 'good', {
      lastSyncedAt: new Date(startedAt).toISOString(),
    });
  }
  return result;
}
