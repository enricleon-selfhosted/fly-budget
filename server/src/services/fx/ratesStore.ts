import { and, asc, desc, eq, max, min } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { exchangeRates } from '../../db/schema.js';
import { rateId, type DailyRate } from './conversion.js';

// Daily exchange rates (docs/multi-currency M4): downloaded ones (`ecb`) and ones the user typed
// in (`manual`). A rate typed in wins for its date, and downloads never overwrite it.

const pair = (base: string, quote: string) =>
  and(eq(exchangeRates.base, base), eq(exchangeRates.quote, quote));

/** Every rate of a pair, oldest first */
export function pairRates(base: string, quote: string): DailyRate[] {
  return db
    .select({ date: exchangeRates.date, rate: exchangeRates.rate, source: exchangeRates.source })
    .from(exchangeRates)
    .where(pair(base, quote))
    .orderBy(asc(exchangeRates.date))
    .all() as DailyRate[];
}

/** The first and last downloaded dates of a pair, null when nothing was downloaded */
export function downloadedRange(base: string, quote: string) {
  const row = db
    .select({ first: min(exchangeRates.date), last: max(exchangeRates.date) })
    .from(exchangeRates)
    .where(and(pair(base, quote), eq(exchangeRates.source, 'ecb')))
    .get();
  return row?.first && row.last ? { first: row.first, last: row.last } : null;
}

/** Stores downloaded rates, leaving dates the user set alone. Returns how many changed. */
export function saveDownloadedRates(
  base: string,
  quote: string,
  rates: readonly { date: string; rate: number }[],
): number {
  let changed = 0;
  db.transaction((tx) => {
    for (const r of rates) {
      const id = rateId(base, quote, r.date);
      const existing = tx
        .select({ rate: exchangeRates.rate, source: exchangeRates.source })
        .from(exchangeRates)
        .where(eq(exchangeRates.id, id))
        .get();
      if (existing?.source === 'manual' || existing?.rate === r.rate) continue;
      tx.insert(exchangeRates)
        .values({ id, date: r.date, base, quote, rate: r.rate, source: 'ecb' })
        .onConflictDoUpdate({ target: exchangeRates.id, set: { rate: r.rate, source: 'ecb' } })
        .run();
      changed++;
    }
  });
  return changed;
}

/** Sets the rate for a date by hand */
export function saveManualRate(base: string, quote: string, date: string, rate: number) {
  const id = rateId(base, quote, date);
  db.insert(exchangeRates)
    .values({ id, date, base, quote, rate, source: 'manual' })
    .onConflictDoUpdate({ target: exchangeRates.id, set: { rate, source: 'manual' } })
    .run();
  return { id, date, base, quote, rate, source: 'manual' as const };
}

/** Removes the rate typed in for a date; downloaded rates can't be removed. Whether one was. */
export function deleteManualRate(base: string, quote: string, date: string): boolean {
  const id = rateId(base, quote, date);
  return (
    db
      .delete(exchangeRates)
      .where(and(eq(exchangeRates.id, id), eq(exchangeRates.source, 'manual')))
      .run().changes > 0
  );
}

/** A pair's most recent rates, newest first */
export function recentRates(base: string, quote: string, limit: number) {
  return db
    .select()
    .from(exchangeRates)
    .where(pair(base, quote))
    .orderBy(desc(exchangeRates.date))
    .limit(limit)
    .all();
}
