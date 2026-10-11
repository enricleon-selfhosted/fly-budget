import path from 'path';
import { getTableColumns, isNotNull, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { databasePath, db, sqlite } from '../db/index.js';
import {
  accounts,
  budgetMonths,
  budgetSettings,
  categories,
  categoryGroups,
  customReports,
  dashboardPages,
  dashboardWidgets,
  goals,
  payees,
  plaidAccountMappings,
  rules,
  scheduleMatchDismissals,
  scheduleOccurrences,
  schedules,
  simplefinAccountMappings,
  enableBankingAccounts,
  exchangeRates,
  transactions,
} from '../db/schema.js';
import { refreshFx } from './fx/fxService.js';
import { scheduleRatesDownload } from './fx/download.js';
import { currencyCode } from '../utils/currency.js';

// Full JSON backup of the user's data, and restoring one.
//
// Bank credentials (Plaid, SimpleFIN, Enable Banking), the server password and login sessions are
// never included: a backup file is easy to leave lying around, and credentials are
// encrypted with a key that only this installation has anyway. After a restore,
// connected banks keep syncing into the same accounts when the backup came from
// this installation.

export const BACKUP_FORMAT = 'flybudget-backup';
export const BACKUP_VERSION = 2;

/** Every table in a backup, parents before the tables that reference them. */
const TABLES = {
  accounts,
  categoryGroups,
  categories,
  payees,
  schedules,
  transactions,
  scheduleOccurrences,
  scheduleMatchDismissals,
  budgetMonths,
  rules,
  customReports,
  dashboardPages,
  dashboardWidgets,
  goals,
  budgetSettings,
  exchangeRates,
} satisfies Record<string, SQLiteTable>;

export type BackupTable = keyof typeof TABLES;
export const BACKUP_TABLES = Object.keys(TABLES) as BackupTable[];

const MAX_ROWS_PER_TABLE = 2_000_000;

const isCurrency = (v: unknown) => currencyCode.safeParse(v).success;
const isPositive = (v: unknown) => typeof v === 'number' && v > 0;
/** Values the column types allow but conversions can't use: a damaged backup is refused */
const VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  'accounts.currency': isCurrency,
  'budgetSettings.currency': isCurrency,
  'exchangeRates.base': isCurrency,
  'exchangeRates.quote': isCurrency,
  'exchangeRates.rate': isPositive,
  'transactions.fxRate': isPositive,
};

export function createBackup() {
  const data: Record<string, unknown> = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
  };
  db.transaction((tx) => {
    for (const name of BACKUP_TABLES) data[name] = tx.select().from(TABLES[name]).all();
  });
  return data;
}

export class InvalidBackupError extends Error {}

type Row = Record<string, unknown>;

/** Tables a backup made before budgeting across currencies doesn't have at all */
const ADDED_FOR_CURRENCIES = ['budgetSettings', 'exchangeRates'] as const;

/** A checked backup, ready to restore */
export type ParsedBackup = {
  tables: Record<BackupTable, Row[]>;
  /**
   * Tables to keep as they are: those a backup made before budgeting across currencies doesn't
   * have (the budget currency would otherwise be forgotten). A newer backup always lists them,
   * even empty.
   */
  keep: BackupTable[];
};

/**
 * Checks a backup's shape against the schema: every table is a list of rows, and every
 * column has the right type (SQLite would otherwise happily store "abc" as an amount).
 * Tables missing from older backups are restored as empty, except the ones in `keep`.
 * Unknown fields are dropped.
 */
export function parseBackup(input: unknown): ParsedBackup {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidBackupError('This is not a FlyBudget backup file');
  }
  const body = input as Record<string, unknown>;
  const isV1 = body.format === undefined && Array.isArray(body.accounts);
  if (!isV1 && body.format !== BACKUP_FORMAT) {
    throw new InvalidBackupError('This is not a FlyBudget backup file');
  }
  if (typeof body.version === 'number' && body.version > BACKUP_VERSION) {
    throw new InvalidBackupError('This backup was made by a newer version of FlyBudget');
  }

  const tables = {} as Record<BackupTable, Row[]>;
  for (const name of BACKUP_TABLES) {
    const rows = body[name] ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE) {
      throw new InvalidBackupError(`"${name}" in the backup is not a list of rows`);
    }
    const columns = Object.entries(getTableColumns(TABLES[name]));
    tables[name] = rows.map((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new InvalidBackupError(`Row ${i + 1} of "${name}" is not valid`);
      }
      const row: Row = {};
      for (const [key, column] of columns) {
        const value = (raw as Row)[key];
        if (value === undefined || value === null) {
          if (column.notNull && !column.hasDefault) {
            throw new InvalidBackupError(`Row ${i + 1} of "${name}" is missing "${key}"`);
          }
          if (value === null && !column.notNull) row[key] = null;
          continue;
        }
        const ok =
          column.columnType === 'SQLiteInteger'
            ? Number.isSafeInteger(value)
            : column.columnType === 'SQLiteReal'
              ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === 'string' && value.length <= 1_000_000;
        const check = VALUE_CHECKS[`${name}.${key}`];
        if (!ok || (check && !check(value)))
          throw new InvalidBackupError(`Row ${i + 1} of "${name}" has an invalid "${key}"`);
        row[key] = value;
      }
      return row;
    });
  }
  return { tables, keep: ADDED_FOR_CURRENCIES.filter((name) => body[name] === undefined) };
}

/** Copies the current database next to it before a restore replaces everything. */
export async function saveSafetyCopy(): Promise<string | null> {
  if (databasePath === ':memory:') return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(path.dirname(databasePath), `budget-before-restore-${stamp}.db`);
  await sqlite.backup(file);
  return path.basename(file);
}

/**
 * Replaces all budget data with the backup's, in one transaction: all or nothing. Then works out
 * the conversions again, with this installation's rates and budget currency when they were kept.
 */
export function restoreBackup({ tables: data, keep }: ParsedBackup) {
  // Bank connections aren't in backups; remember which accounts they sync into
  const plaidLinks = db
    .select({ id: plaidAccountMappings.id, accountId: plaidAccountMappings.accountId })
    .from(plaidAccountMappings)
    .where(isNotNull(plaidAccountMappings.accountId))
    .all();
  const simplefinLinks = db
    .select({ id: simplefinAccountMappings.id, accountId: simplefinAccountMappings.accountId })
    .from(simplefinAccountMappings)
    .where(isNotNull(simplefinAccountMappings.accountId))
    .all();
  const enableBankingLinks = db
    .select({ id: enableBankingAccounts.id, accountId: enableBankingAccounts.accountId })
    .from(enableBankingAccounts)
    .where(isNotNull(enableBankingAccounts.accountId))
    .all();
  const restoredAccounts = new Set(data.accounts.map((a) => a.id as string));
  const kept: Partial<Record<BackupTable, Row[]>> = {};
  for (const name of keep) kept[name] = db.select().from(TABLES[name]).all();

  db.transaction((tx) => {
    // Foreign keys are checked once, at commit, so rows can go in table by table
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const name of [...BACKUP_TABLES].reverse()) tx.delete(TABLES[name]).run();
    for (const name of BACKUP_TABLES) {
      const rows = kept[name] ?? data[name];
      // Chunked: SQLite limits how many values one statement may bind
      for (let i = 0; i < rows.length; i += 200) {
        tx.insert(TABLES[name])
          .values(rows.slice(i, i + 200) as never)
          .run();
      }
    }
    for (const [table, links] of [
      [plaidAccountMappings, plaidLinks],
      [simplefinAccountMappings, simplefinLinks],
      [enableBankingAccounts, enableBankingLinks],
    ] as const) {
      for (const link of links) {
        if (!link.accountId || !restoredAccounts.has(link.accountId)) continue;
        tx.update(table)
          .set({ accountId: link.accountId })
          .where(sql`${table.id} = ${link.id}`)
          .run();
      }
    }
  });
  refreshFx('all');
  // The backup's accounts may need rates this installation doesn't have (if downloading is on)
  scheduleRatesDownload();

  return Object.fromEntries(BACKUP_TABLES.map((name) => [name, data[name].length]));
}
