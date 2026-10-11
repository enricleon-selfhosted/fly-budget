import { createHash } from 'crypto';
import { logError } from '../../utils/log.js';
import { accountSummary } from '../accountService.js';
import { applyMappings } from './accountMapping.js';
import { createEnableBankingClient, type EnableBankingApi, type PsuHeaders } from './client.js';
import {
  disconnect,
  finishConsent,
  parseRedirect,
  startConsent,
  type ConsentInfo,
  type ConsentResult,
  type StartConsentInput,
} from './connectService.js';
import { createConsentRegistry, type ConsentStatus } from './consent.js';
import {
  ConfigurationError,
  ConflictError,
  NotFoundError,
  enableBankingErrorMessage,
} from './errors.js';
import { parsePrivateKey } from './jwt.js';
import { suggestAccountType } from './mapping.js';
import { localDay, type MappingRequest } from './rules.js';
import type { EbAspsp } from './schemas.js';
import { enableBankingStore, type BankAccountRow, type StoredConfig } from './store.js';
import { emptySyncResult, syncConnection, type SyncResult } from './syncService.js';

// Everything the routes can do with Enable Banking, wired from the single-purpose modules.
// The API client and the clock are injected, so routes and services are tested against a
// fake Enable Banking without mocking modules.

const BANK_LIST_TTL_MS = 60 * 60 * 1000;

export type EnableBankingServiceDeps = {
  makeApi?: (config: Pick<StoredConfig, 'applicationId' | 'privateKey'>) => EnableBankingApi;
  now?: () => number;
};

export type AccountView = {
  id: string;
  name: string;
  ibanMask: string | null;
  currency: string | null;
  cashAccountType: string | null;
  suggestedType: string;
  accountId: string | null;
  accountName: string | null;
  isEnabled: boolean;
  /** False when the latest consent leaves it out (D18): it can't be imported until one covers it */
  inConsent: boolean;
  syncFrom: string | null;
  bankBalance: number | null;
  bankBalanceAt: string | null;
  balance: number | null;
};

export type ConsentView = ConsentStatus<ConsentResult & { accounts: AccountView[] }>;

function accountView(row: BankAccountRow): AccountView {
  const local = row.accountId ? accountSummary(row.accountId) : null;
  return {
    id: row.id,
    name: row.name,
    ibanMask: row.ibanMask,
    currency: row.currency,
    cashAccountType: row.cashAccountType,
    suggestedType: suggestAccountType(row.cashAccountType),
    accountId: local ? row.accountId : null,
    accountName: local?.name ?? null,
    isEnabled: row.isEnabled === 1,
    inConsent: row.inConsent === 1,
    syncFrom: row.syncFrom,
    bankBalance: row.bankBalance,
    bankBalanceAt: row.bankBalanceAt,
    balance: local?.balance ?? null,
  };
}

export function createEnableBankingService(deps: EnableBankingServiceDeps = {}) {
  const now = deps.now ?? Date.now;
  const makeApi =
    deps.makeApi ??
    ((config: Pick<StoredConfig, 'applicationId' | 'privateKey'>) =>
      createEnableBankingClient({ ...config, now }));
  const consents = createConsentRegistry<ConsentInfo, ConsentResult>(now);
  const bankLists = new Map<string, { at: number; banks: EbAspsp[] }>();
  let cached: { key: string; api: EnableBankingApi } | undefined;

  function config(): StoredConfig {
    const stored = enableBankingStore.getConfig();
    if (!stored) throw new NotFoundError('Set up Enable Banking first.');
    return stored;
  }

  /** The client for the stored application, rebuilt when the setup changes */
  function api(): EnableBankingApi {
    const stored = config();
    const key = createHash('sha256')
      .update(`${stored.applicationId}\n${stored.privateKey}`)
      .digest('hex');
    if (cached?.key !== key) cached = { key, api: makeApi(stored) };
    return cached.api;
  }

  async function listBanks(country: string): Promise<EbAspsp[]> {
    const hit = bankLists.get(country);
    if (hit && now() - hit.at < BANK_LIST_TTL_MS) return hit.banks;
    const banks = await api().listAspsps(country);
    bankLists.set(country, { at: now(), banks });
    return banks;
  }

  function consentView(status: ConsentStatus<ConsentResult>): ConsentView {
    if (status.status !== 'complete') return status;
    return {
      status: 'complete',
      result: {
        ...status.result,
        accounts: enableBankingStore.listAccounts(status.result.connectionId).map(accountView),
      },
    };
  }

  const finish = (info: ConsentInfo, code: string) => finishConsent(info, code, api(), now);
  const consentError = (err: unknown) => {
    logError('Enable Banking consent', err);
    return enableBankingErrorMessage(err, 'Connecting to your bank failed. Try again.');
  };

  return {
    status(suggestedRedirectUrl: string) {
      const stored = enableBankingStore.getPublicConfig();
      return {
        configured: !!stored,
        applicationId: stored?.applicationId ?? null,
        environment: (stored?.environment ?? null) as 'PRODUCTION' | 'SANDBOX' | null,
        redirectUrl: stored?.redirectUrl ?? null,
        suggestedRedirectUrl,
        connectionCount: enableBankingStore.listConnections().length,
      };
    },

    /**
     * Checks the application works before storing it: the key parses, Enable Banking accepts
     * a JWT signed with it, the application is active and the redirect URL is registered.
     */
    async configure(input: { applicationId: string; privateKey?: string; redirectUrl: string }) {
      const privateKey = input.privateKey ?? enableBankingStore.getConfig()?.privateKey;
      if (!privateKey) throw new ConfigurationError('Add the private key (.pem file).');
      parsePrivateKey(privateKey);
      const app = await makeApi({
        applicationId: input.applicationId,
        privateKey,
      }).getApplication();
      if (!app.active)
        throw new ConfigurationError(
          'This application isn’t active yet. In Enable Banking’s control panel, use “Activate by linking accounts”.',
        );
      if (!app.redirect_urls.includes(input.redirectUrl))
        throw new ConfigurationError(
          'This redirect URL isn’t registered in your Enable Banking application. Add it there, or use one that is.',
        );
      enableBankingStore.saveConfig(
        {
          applicationId: input.applicationId,
          privateKey,
          redirectUrl: input.redirectUrl,
          environment: app.environment,
        },
        new Date(now()).toISOString(),
      );
      bankLists.clear();
      cached = undefined;
    },

    removeConfig() {
      if (enableBankingStore.listConnections().length)
        throw new ConflictError('Disconnect your banks first.');
      enableBankingStore.deleteConfig();
      bankLists.clear();
      cached = undefined;
    },

    async listBanks(country: string) {
      return (await listBanks(country)).map((b) => ({
        name: b.name,
        country: b.country,
        maximumConsentDays: b.maximum_consent_validity
          ? Math.floor(b.maximum_consent_validity / 86_400)
          : null,
        beta: !!b.beta,
        psuTypes: b.psu_types ?? ['personal'],
      }));
    },

    startConsent(input: StartConsentInput) {
      return startConsent(input, {
        api: api(),
        now,
        consents,
        redirectUrl: config().redirectUrl,
        listBanks,
      });
    },

    consentStatus(id: string): ConsentView {
      return consentView(consents.status(id));
    },

    /** The bank's redirect reached FlyBudget's callback. Undefined: unknown or expired state. */
    async completeFromCallback(query: { code?: string; state?: string; error?: string }) {
      if (!query.state) return undefined;
      if (query.error || !query.code) {
        return consents.fail(query.state, 'The bank didn’t give access. Try connecting again.')
          ? ({ status: 'error' } as const)
          : undefined;
      }
      return consents.complete(query.state, (info) => finish(info, query.code!), consentError);
    },

    /** The user pasted the address the bank sent them to */
    async completeFromAddress(id: string, address: string): Promise<ConsentView> {
      const { code, state, error } = parseRedirect(address);
      if (!state) throw new ConfigurationError('That isn’t the address your bank sent you to.');
      const otherAttempt = () =>
        new ConfigurationError(
          'That address is from another or an expired attempt. Start connecting again.',
        );
      if (error || !code) {
        const failed = consents.fail(
          state,
          'The bank didn’t give access. Try connecting again.',
          id,
        );
        // Not failed but finished already (the same address twice): that outcome stands
        if (!failed && consents.status(id).status === 'pending') throw otherAttempt();
        return consentView(consents.status(id));
      }
      const outcome = consents.complete(state, (info) => finish(info, code), consentError, id);
      if (!outcome) throw otherAttempt();
      await outcome;
      return consentView(consents.status(id));
    },

    cancelConsent(id: string) {
      consents.cancel(id);
    },

    listConnections() {
      const accountsByConnection = new Map<string, BankAccountRow[]>();
      for (const a of enableBankingStore.listAccounts()) {
        accountsByConnection.set(a.connectionId, [
          ...(accountsByConnection.get(a.connectionId) ?? []),
          a,
        ]);
      }
      return enableBankingStore.listConnections().map((c) => ({
        id: c.id,
        aspspName: c.aspspName,
        aspspCountry: c.aspspCountry,
        validUntil: c.validUntil,
        syncStatus: c.syncStatus,
        syncError: c.syncError,
        lastSyncedAt: c.lastSyncedAt,
        accounts: (accountsByConnection.get(c.id) ?? []).map(accountView),
      }));
    },

    mapAccounts(connectionId: string, budgetCurrency: string, requests: MappingRequest[]) {
      if (!enableBankingStore.getConnection(connectionId))
        throw new NotFoundError('That connection doesn’t exist anymore.');
      return applyMappings(connectionId, requests, budgetCurrency, localDay(now()));
    },

    sync(connectionId: string, psu?: PsuHeaders): Promise<SyncResult> {
      if (!enableBankingStore.getConnection(connectionId))
        throw new NotFoundError('That connection doesn’t exist anymore.');
      return syncConnection(connectionId, { api: api(), now }, { psu });
    },

    /** Every connection, one after another. Background syncs respect the 6-hour rule. */
    async syncAll(options: { background?: boolean; psu?: PsuHeaders } = {}) {
      if (!enableBankingStore.getPublicConfig()) return [];
      const results: SyncResult[] = [];
      for (const c of enableBankingStore.listConnections()) {
        try {
          results.push(await syncConnection(c.id, { api: api(), now }, options));
        } catch (err) {
          logError('Enable Banking sync', err);
          results.push({
            ...emptySyncResult(c, 'error'),
            errors: [enableBankingErrorMessage(err, 'Sync failed.')],
          });
        }
      }
      return results;
    },

    async disconnect(connectionId: string) {
      await disconnect(connectionId, api());
    },
  };
}

export type EnableBankingService = ReturnType<typeof createEnableBankingService>;
