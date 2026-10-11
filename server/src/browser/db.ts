// In-browser demo stand-in for db/index.ts (see README.md here): the same exports, backed
// by sql.js (SQLite compiled to WebAssembly) in memory instead of better-sqlite3 on disk.
// Drizzle's sql.js driver is synchronous like better-sqlite3's, so every query in the
// routes and services runs unchanged.
import type { Database } from 'sql.js';
import { drizzle, type SQLJsDatabase } from 'drizzle-orm/sql-js';
import { PreparedQuery } from 'drizzle-orm/sql-js/session';
import * as schema from '../db/schema.js';

// better-sqlite3's .run() reports how many rows changed (the reconcile route returns it);
// sql.js's doesn't, so add it
const originalRun = PreparedQuery.prototype.run;
PreparedQuery.prototype.run = function (this: { client: Database }, ...args) {
  originalRun.apply(this, args);
  return { changes: this.client.getRowsModified(), lastInsertRowid: 0 };
} as typeof originalRun;

export const databasePath = ':memory:';

// Some routes build queries when they load (budget.ts's on-budget subquery), before the
// worker has opened a database. Building a query doesn't touch the connection, so start
// with one that has none; running a query before useDatabase() is a bug and fails loudly.
let current = drizzle(null as unknown as Database, { schema });

type Db = SQLJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The transactions running now, innermost last */
const open: Tx[] = [];

/** Points every module's `db` at a new database (the demo resets by opening a fresh one). */
export function useDatabase(database: Database) {
  current = drizzle(database, { schema });
  open.length = 0;
}

/**
 * `db.transaction` inside another one becomes a savepoint, as with better-sqlite3. Drizzle's
 * sql.js driver would send a second BEGIN, which SQLite refuses, so a service that opens its own
 * transaction (refreshFx, uncategorizing transfers) couldn't run inside a route's.
 */
const transaction: Db['transaction'] = (run, config) => {
  const tracked = (tx: Tx) => {
    open.push(tx);
    try {
      return run(tx);
    } finally {
      open.pop();
    }
  };
  const outer = open.at(-1);
  return outer ? outer.transaction(tracked) : current.transaction(tracked, config);
};

export const db = new Proxy({} as Db, {
  get(_target, prop) {
    if (prop === 'transaction') return transaction;
    const value = Reflect.get(current, prop, current);
    return typeof value === 'function' ? value.bind(current) : value;
  },
});

/** Only backups use the raw connection, to save a safety copy, which the demo skips. */
export const sqlite = {
  backup: async () => {},
};
