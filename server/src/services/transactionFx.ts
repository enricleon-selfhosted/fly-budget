import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, transactions } from '../db/schema.js';
import { convertTransactions, waitsForRate } from './fx/fxService.js';
import { scheduleRatesDownload } from './fx/download.js';

// What follows every write that adds transactions: those in accounts in another currency get their
// rate to the budget's (docs/multi-currency M3), and when a day has no rate yet, rates are
// downloaded if the user allows it and the installation can (M4, M10). One entry point, so
// whether a transaction gets its rate doesn't depend on which screen or sync created it.

/** SQLite allows a limited number of variables per statement */
const CHUNK = 500;

/** Whether any of these transactions is in an account in another currency and has no rate yet */
function anyWaitsForRate(ids: readonly string[]): boolean {
  if (ids.length === 1) return waitsForRate(ids[0]);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const waiting = db
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          isNotNull(accounts.currency),
          isNull(transactions.fxRate),
          inArray(transactions.id, ids.slice(i, i + CHUNK)),
        ),
      )
      .limit(1)
      .get();
    if (waiting) return true;
  }
  return false;
}

/**
 * Call after inserting transactions (with their split parts and transfer sides): converts them,
 * and starts a rate download in the background when one of them still waits for a rate. Batch
 * callers pass every id they inserted at once.
 */
export function afterTransactionsWritten(ids: readonly string[]): void {
  if (!ids.length) return;
  convertTransactions(ids);
  if (anyWaitsForRate(ids)) scheduleRatesDownload();
}
