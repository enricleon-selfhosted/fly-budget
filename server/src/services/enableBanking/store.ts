import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db/index.js';
import {
  enableBankingAccounts,
  enableBankingConfig,
  enableBankingConnections,
} from '../../db/schema.js';

// The enable_banking_* tables. Secrets (private key, session id) are decrypted only by the
// functions that return them; everything else selects plain columns. Writes that record when
// they happened take the time from the caller (`at`, ISO), so the service's clock decides it.

const CONFIG_ID = 'default';

export type StoredConfig = {
  applicationId: string;
  privateKey: string;
  redirectUrl: string;
  environment: string;
};

export type PublicConfig = Omit<StoredConfig, 'privateKey'> & { updatedAt: string };

export type ConnectionRow = Omit<typeof enableBankingConnections.$inferSelect, 'sessionId'>;
export type BankAccountRow = typeof enableBankingAccounts.$inferSelect;

/** What a consent says about one account */
export type BankAccountInfo = {
  accountUid: string;
  identificationHash: string;
  name: string;
  ibanMask: string | null;
  ibanHash: string | null;
  currency: string;
  cashAccountType: string | null;
};

const connectionColumns = {
  id: enableBankingConnections.id,
  aspspName: enableBankingConnections.aspspName,
  aspspCountry: enableBankingConnections.aspspCountry,
  validUntil: enableBankingConnections.validUntil,
  syncStatus: enableBankingConnections.syncStatus,
  syncError: enableBankingConnections.syncError,
  lastSyncedAt: enableBankingConnections.lastSyncedAt,
  lastAttemptAt: enableBankingConnections.lastAttemptAt,
  createdAt: enableBankingConnections.createdAt,
};

export const enableBankingStore = {
  getConfig(): StoredConfig | null {
    return (
      db.select().from(enableBankingConfig).where(eq(enableBankingConfig.id, CONFIG_ID)).get() ??
      null
    );
  },

  getPublicConfig(): PublicConfig | null {
    return (
      db
        .select({
          applicationId: enableBankingConfig.applicationId,
          redirectUrl: enableBankingConfig.redirectUrl,
          environment: enableBankingConfig.environment,
          updatedAt: enableBankingConfig.updatedAt,
        })
        .from(enableBankingConfig)
        .where(eq(enableBankingConfig.id, CONFIG_ID))
        .get() ?? null
    );
  },

  saveConfig(config: StoredConfig, at = new Date().toISOString()) {
    db.insert(enableBankingConfig)
      .values({ id: CONFIG_ID, ...config, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: enableBankingConfig.id, set: { ...config, updatedAt: at } })
      .run();
  },

  deleteConfig() {
    db.delete(enableBankingConfig).run();
  },

  listConnections(): ConnectionRow[] {
    return db.select(connectionColumns).from(enableBankingConnections).all();
  },

  getConnection(id: string): ConnectionRow | null {
    return (
      db
        .select(connectionColumns)
        .from(enableBankingConnections)
        .where(eq(enableBankingConnections.id, id))
        .get() ?? null
    );
  },

  getSessionId(connectionId: string): string | null {
    return (
      db
        .select({ sessionId: enableBankingConnections.sessionId })
        .from(enableBankingConnections)
        .where(eq(enableBankingConnections.id, connectionId))
        .get()?.sessionId ?? null
    );
  },

  findConnectionByBank(aspspName: string, aspspCountry: string): ConnectionRow | null {
    return (
      db
        .select(connectionColumns)
        .from(enableBankingConnections)
        .where(
          and(
            eq(enableBankingConnections.aspspName, aspspName),
            eq(enableBankingConnections.aspspCountry, aspspCountry),
          ),
        )
        .get() ?? null
    );
  },

  insertConnection(
    values: {
      sessionId: string;
      aspspName: string;
      aspspCountry: string;
      validUntil: string;
    },
    at = new Date().toISOString(),
  ): string {
    const id = nanoid();
    db.insert(enableBankingConnections)
      .values({ id, ...values, syncStatus: 'good', createdAt: at })
      .run();
    return id;
  },

  /** A renewed consent: new session, access until a new date, errors cleared */
  renewConnection(id: string, values: { sessionId: string; validUntil: string }) {
    db.update(enableBankingConnections)
      .set({ ...values, syncStatus: 'good', syncError: null })
      .where(eq(enableBankingConnections.id, id))
      .run();
  },

  setStatus(
    id: string,
    status: 'good' | 'syncing' | 'error' | 'reauth_required',
    extra: { syncError?: string | null; lastSyncedAt?: string; lastAttemptAt?: string } = {},
  ) {
    db.update(enableBankingConnections)
      .set({ syncStatus: status, syncError: extra.syncError ?? null, ...extra })
      .where(eq(enableBankingConnections.id, id))
      .run();
  },

  deleteConnection(id: string) {
    db.delete(enableBankingConnections).where(eq(enableBankingConnections.id, id)).run();
  },

  listAccounts(connectionId?: string): BankAccountRow[] {
    const query = db.select().from(enableBankingAccounts);
    return connectionId
      ? query.where(eq(enableBankingAccounts.connectionId, connectionId)).all()
      : query.all();
  },

  getAccount(id: string): BankAccountRow | null {
    return (
      db.select().from(enableBankingAccounts).where(eq(enableBankingAccounts.id, id)).get() ?? null
    );
  },

  /**
   * Records the accounts a consent covers. Accounts already known (same identification_hash)
   * get the new session's uid and details and keep their mapping (decision D18); new ones are
   * added, not imported until the user decides.
   */
  bindAccounts(
    connectionId: string,
    accounts: readonly BankAccountInfo[],
    at = new Date().toISOString(),
  ) {
    db.transaction((tx) => {
      for (const account of accounts) {
        tx.insert(enableBankingAccounts)
          .values({ id: nanoid(), connectionId, ...account, createdAt: at })
          .onConflictDoUpdate({
            target: [enableBankingAccounts.connectionId, enableBankingAccounts.identificationHash],
            set: {
              accountUid: account.accountUid,
              inConsent: 1,
              name: account.name,
              ibanMask: account.ibanMask,
              ibanHash: account.ibanHash,
              currency: account.currency,
              cashAccountType: account.cashAccountType,
            },
          })
          .run();
      }
    });
  },

  /**
   * A renewed consent that no longer covers some accounts (the user left them out at the bank):
   * they stop being imported, and can't be until a later consent covers them again. Their
   * FlyBudget accounts and transactions stay.
   */
  stopAccountsNotIn(connectionId: string, identificationHashes: readonly string[]) {
    db.update(enableBankingAccounts)
      .set({ isEnabled: 0, inConsent: 0 })
      .where(
        and(
          eq(enableBankingAccounts.connectionId, connectionId),
          notInArray(enableBankingAccounts.identificationHash, [...identificationHashes]),
        ),
      )
      .run();
  },

  updateAccount(
    id: string,
    values: Partial<
      Pick<
        BankAccountRow,
        | 'accountId'
        | 'isEnabled'
        | 'syncFrom'
        | 'lastSyncedAt'
        | 'openingBalancePending'
        | 'bankBalance'
        | 'bankBalanceAt'
      >
    >,
  ) {
    db.update(enableBankingAccounts).set(values).where(eq(enableBankingAccounts.id, id)).run();
  },

  /** IBAN hash → the FlyBudget account it imports into, across every connection */
  ownAccountsByIbanHash(): Map<string, string> {
    const rows = db
      .select({ hash: enableBankingAccounts.ibanHash, accountId: enableBankingAccounts.accountId })
      .from(enableBankingAccounts)
      .where(
        and(isNotNull(enableBankingAccounts.ibanHash), isNotNull(enableBankingAccounts.accountId)),
      )
      .all();
    return new Map(rows.map((r) => [r.hash!, r.accountId!]));
  },
};

export type EnableBankingStore = typeof enableBankingStore;
