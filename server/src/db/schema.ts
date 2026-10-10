import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { secretCipher } from './secretCrypto.js';

/** TEXT column encrypted at rest when a key is configured (see secretCrypto.ts). Can't be queried by value. */
const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => secretCipher.encrypt(value),
  fromDriver: (value) => secretCipher.decrypt(value),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  startingBalance: integer('starting_balance').notNull().default(0),
  isOffBudget: integer('is_off_budget').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  closedAt: text('closed_at'),
  /** Custom logo as a small image data URL; null = colored initials */
  logo: text('logo'),
  /**
   * ISO 4217 code, set only when the account's currency differs from the budget's (null = the
   * budget currency). Their transactions are converted at a rate (docs/multi-currency).
   */
  currency: text('currency'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const categoryGroups = sqliteTable('category_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isIncome: integer('is_income').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  groupId: text('group_id')
    .notNull()
    .references(() => categoryGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  budgetType: text('budget_type'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const payees = sqliteTable('payees', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  defaultCategoryId: text('default_category_id').references(() => categories.id, {
    onDelete: 'set null',
  }),
  /** Custom logo as a small image data URL; null = colored initials */
  logo: text('logo'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    amount: integer('amount').notNull(),
    payeeId: text('payee_id').references(() => payees.id, { onDelete: 'set null' }),
    payeeName: text('payee_name'),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    notes: text('notes'),
    reconciled: integer('reconciled').notNull().default(0),
    transferTransactionId: text('transfer_transaction_id'),
    isParent: integer('is_parent').notNull().default(0),
    parentTransactionId: text('parent_transaction_id'),
    importedId: text('imported_id'),
    /** Raw payee text from the bank or CSV, kept so rules can match it after a rename */
    importedPayee: text('imported_payee'),
    /**
     * 1 for a balance correction (reconciliation, "Update value"): it changes the balance, but
     * while it has no category, income and spending reports leave it out
     */
    isAdjustment: integer('is_adjustment').notNull().default(0),
    scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    /**
     * Accounts in another currency only: the rate from the account's currency to the budget's
     * that this transaction is converted at (null = no rate yet). See services/fx/.
     */
    fxRate: real('fx_rate'),
    /** Where `fx_rate` came from: `manual`, `exchange` or `rate` (FX_SOURCES) */
    fxSource: text('fx_source'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('transactions_account_date_idx').on(table.accountId, table.date),
    index('transactions_category_idx').on(table.categoryId),
    index('transactions_date_idx').on(table.date),
    index('transactions_imported_id_idx').on(table.importedId),
    index('idx_transactions_schedule').on(table.scheduleId),
  ],
);

export const budgetMonths = sqliteTable(
  'budget_months',
  {
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    budgeted: integer('budgeted').notNull().default(0),
    notes: text('notes'),
  },
  (table) => [uniqueIndex('budget_months_month_category_idx').on(table.month, table.categoryId)],
);

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  conditions: text('conditions').notNull(),
  actions: text('actions').notNull(),
  /** 'and' = every condition must match, 'or' = any one */
  conditionsOp: text('conditions_op').notNull().default('and'),
  enabled: integer('enabled').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    amount: integer('amount').notNull(),
    amountType: text('amount_type').notNull().default('exact'),
    recurrenceType: text('recurrence_type').notNull(),
    recurrenceRule: text('recurrence_rule').notNull().default('{}'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    weekendAdjust: text('weekend_adjust').notNull().default('none'),
    dateFlexibility: integer('date_flexibility').notNull().default(3),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    transferAccountId: text('transfer_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    payeeId: text('payee_id').references(() => payees.id, { onDelete: 'set null' }),
    notes: text('notes'),
    /** Recognizes this item's transactions by the bank's text (case-insensitive "contains") */
    matchText: text('match_text'),
    status: text('status').notNull().default('active'),
    autoCreate: integer('auto_create').notNull().default(0),
    autoCreateFrom: text('auto_create_from'),
    source: text('source').notNull().default('manual'),
    occurrenceHorizon: text('occurrence_horizon'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_schedules_status').on(table.status),
    index('idx_schedules_payee').on(table.payeeId),
    index('idx_schedules_account').on(table.accountId),
  ],
);

export const scheduleOccurrences = sqliteTable(
  'schedule_occurrences',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    scheduledDate: text('scheduled_date').notNull(),
    expectedDate: text('expected_date').notNull(),
    expectedAmount: integer('expected_amount').notNull(),
    status: text('status').notNull().default('pending'),
    matchedTransactionId: text('matched_transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    matchType: text('match_type'),
    matchConfidence: integer('match_confidence'),
    skippedAt: text('skipped_at'),
    paidAt: text('paid_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('idx_occ_schedule_date_unique').on(table.scheduleId, table.scheduledDate),
    index('idx_occ_expected_date').on(table.expectedDate),
    index('idx_occ_status').on(table.status),
    uniqueIndex('idx_occ_matched_tx_unique').on(table.matchedTransactionId),
  ],
);

export const scheduleMatchDismissals = sqliteTable(
  'schedule_match_dismissals',
  {
    id: text('id').primaryKey(),
    occurrenceId: text('occurrence_id')
      .notNull()
      .references(() => scheduleOccurrences.id, { onDelete: 'cascade' }),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    dismissedAt: text('dismissed_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex('idx_dismissal_unique').on(table.occurrenceId, table.transactionId)],
);

export const customReports = sqliteTable('custom_reports', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const dashboardPages = sqliteTable('dashboard_pages', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  // JSON date range the dashboard's widgets follow by default; null means the last 6 months
  dateRange: text('date_range'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// A report widget on a dashboard page. `meta` is a JSON string whose shape depends on
// `type`; custom report widgets point at their report so deleting it removes the widget.
export const dashboardWidgets = sqliteTable('dashboard_widgets', {
  id: text('id').primaryKey(),
  pageId: text('page_id')
    .notNull()
    .references(() => dashboardPages.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  customReportId: text('custom_report_id').references(() => customReports.id, {
    onDelete: 'cascade',
  }),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  width: integer('width').notNull().default(6),
  height: integer('height').notNull().default(4),
  meta: text('meta').notNull().default('{}'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  targetAmount: integer('target_amount').notNull(),
  currentAmount: integer('current_amount').notNull().default(0),
  targetDate: text('target_date'),
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  icon: text('icon').notNull().default('🎯'),
  color: text('color').notNull().default('#2563EB'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const simplefinConnections = sqliteTable('simplefin_connections', {
  id: text('id').primaryKey(),
  accessUrl: encryptedText('access_url').notNull(),
  connectionName: text('connection_name').notNull(),
  syncStatus: text('sync_status').notNull().default('good'),
  syncError: text('sync_error'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const simplefinAccountMappings = sqliteTable(
  'simplefin_account_mappings',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => simplefinConnections.id, { onDelete: 'cascade' }),
    simplefinAccountId: text('simplefin_account_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    simplefinAccountName: text('simplefin_account_name').notNull(),
    isEnabled: integer('is_enabled').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('simplefin_account_mapping_unique').on(
      table.connectionId,
      table.simplefinAccountId,
    ),
  ],
);

export const plaidConfig = sqliteTable('plaid_config', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  secret: encryptedText('secret').notNull(),
  environment: text('environment').notNull().default('development'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const plaidItems = sqliteTable('plaid_items', {
  id: text('id').primaryKey(),
  plaidItemId: text('plaid_item_id').notNull(),
  institutionId: text('institution_id').notNull(),
  institutionName: text('institution_name').notNull(),
  accessToken: encryptedText('access_token').notNull(),
  cursor: text('cursor'),
  lastSyncedAt: text('last_synced_at'),
  syncStatus: text('sync_status').notNull().default('good'),
  syncError: text('sync_error'),
  consentExpiresAt: text('consent_expires_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const plaidAccountMappings = sqliteTable(
  'plaid_account_mappings',
  {
    id: text('id').primaryKey(),
    plaidItemId: text('plaid_item_id')
      .notNull()
      .references(() => plaidItems.id, { onDelete: 'cascade' }),
    plaidAccountId: text('plaid_account_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    plaidAccountName: text('plaid_account_name').notNull(),
    plaidAccountType: text('plaid_account_type').notNull(),
    plaidAccountMask: text('plaid_account_mask'),
    isEnabled: integer('is_enabled').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('plaid_account_mapping_unique').on(table.plaidItemId, table.plaidAccountId),
  ],
);

// --- Enable Banking (European banks, PSD2) — docs/enable-banking/architecture.md ---

/** The user's own Enable Banking application. Single row, id 'default'. */
export const enableBankingConfig = sqliteTable('enable_banking_config', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull(),
  /** PEM private key of the application; signs the API's JWTs */
  privateKey: encryptedText('private_key').notNull(),
  /** One of the redirect URLs registered in the application */
  redirectUrl: text('redirect_url').notNull(),
  /** PRODUCTION or SANDBOX, as Enable Banking reports it */
  environment: text('environment').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** One consent at one bank. Renewing it replaces the session in place. */
export const enableBankingConnections = sqliteTable('enable_banking_connections', {
  id: text('id').primaryKey(),
  /** Grants access to the accounts together with the private key */
  sessionId: encryptedText('session_id').notNull(),
  aspspName: text('aspsp_name').notNull(),
  aspspCountry: text('aspsp_country').notNull(),
  /** When the consent ends (RFC 3339) */
  validUntil: text('valid_until').notNull(),
  /** good | syncing | error | reauth_required */
  syncStatus: text('sync_status').notNull().default('good'),
  syncError: text('sync_error'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** A bank account in a connection, and the FlyBudget account it imports into (if any). */
export const enableBankingAccounts = sqliteTable(
  'enable_banking_accounts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id, { onDelete: 'cascade' }),
    /** Per-session id used in API paths; changes when the consent is renewed */
    accountUid: text('account_uid').notNull(),
    /** Enable Banking's id for the account itself, stable across sessions */
    identificationHash: text('identification_hash').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** e.g. "ES12 •••• 3456"; the IBAN itself is never stored */
    ibanMask: text('iban_mask'),
    /** SHA-256 of the IBAN, to recognize transfers from the user's other accounts */
    ibanHash: text('iban_hash'),
    currency: text('currency'),
    /** CACC | CARD | SVGS | LOAN | CASH | OTHR */
    cashAccountType: text('cash_account_type'),
    /** 0 = the user chose not to import it */
    isEnabled: integer('is_enabled').notNull().default(1),
    /** First day to import (YYYY-MM-DD) */
    syncFrom: text('sync_from'),
    /** 1 for an account created from the bank until its first sync sets the opening balance */
    openingBalancePending: integer('opening_balance_pending').notNull().default(0),
    /** The latest balance the bank reported, shown next to FlyBudget's */
    bankBalance: integer('bank_balance'),
    bankBalanceAt: text('bank_balance_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('enable_banking_account_unique').on(table.connectionId, table.identificationHash),
  ],
);

// --- Currencies ---

/** Settings of the budget as a whole. A single row, `id = 'budget'`. */
export const budgetSettings = sqliteTable('budget_settings', {
  id: text('id').primaryKey(),
  /** ISO 4217 code of the budget's currency; null until a client first sends it */
  currency: text('currency'),
  /** 1 = download daily rates from the European Central Bank (through Frankfurter) */
  downloadRates: integer('download_rates').notNull().default(0),
  /** When rates were last downloaded successfully */
  ratesUpdatedAt: text('rates_updated_at'),
  /** Why the last download failed (a code, see services/fx/), null when it worked */
  ratesError: text('rates_error'),
});

/**
 * Daily exchange rates: 1 `base` = `rate` `quote`. The id is `<base><quote>:<date>`, so two
 * devices storing the same rate store the same row. `source` is `ecb` (downloaded) or `manual`.
 */
export const exchangeRates = sqliteTable(
  'exchange_rates',
  {
    id: text('id').primaryKey(),
    date: text('date').notNull(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    rate: real('rate').notNull(),
    source: text('source').notNull(),
  },
  (table) => [index('exchange_rates_pair_date_idx').on(table.base, table.quote, table.date)],
);

// --- Server mode (self-hosted / Docker) login ---

/** The single login password, as an scrypt hash. Only used in server mode. */
export const authConfig = sqliteTable('auth_config', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Login sessions. `id` is the SHA-256 of the session token, never the token itself. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  expiresAt: text('expires_at').notNull(),
  /** The browser that signed in (listed in Settings → Server → Signed-in devices) */
  userAgent: text('user_agent'),
  /** Roughly when the session was last used (updated at most every few minutes) */
  lastUsedAt: text('last_used_at'),
});
