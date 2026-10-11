import { format } from 'date-fns';
import { eq, isNotNull, min, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, transactions } from '../../db/schema.js';
import { downloadRanges } from './conversion.js';
import { RatesUnavailableError, fetchDailyRates, type RatesErrorCode } from './frankfurter.js';
import { downloadedRange, saveDownloadedRates } from './ratesStore.js';
import { refreshFx } from './fxService.js';
import { getBudgetSettings, saveBudgetSettings } from './settings.js';

// Downloads the daily rates each account in another currency needs (docs/multi-currency M4),
// only when the user turned downloading on and the installation may download at all (the demo
// can't, M10). One download runs at a time: callers asking while one runs share the next one.

export type DownloadResult = {
  /** Rates stored or changed */
  downloaded: number;
  error: RatesErrorCode | null;
  /** Currencies the ECB doesn't publish */
  unsupported: string[];
};

type Options = {
  /** null where rates are never downloaded, whatever the budget's settings say */
  fetch: typeof fetch | null;
  today: () => string;
  now: () => Date;
};

let options: Options = {
  fetch: (...args) => globalThis.fetch(...args),
  today: () => format(new Date(), 'yyyy-MM-dd'),
  now: () => new Date(),
};

/**
 * Tests swap in a fake service and a fixed day. The demo passes `fetch: null`: a restored backup
 * can turn the setting on, but nothing then downloads (M10).
 */
export function configureRatesDownload(next: Partial<Options>) {
  options = { ...options, ...next };
}

/** Whether this installation may download rates at all */
export const ratesDownloadAvailable = () => options.fetch !== null;

/** Each currency accounts are kept in, with the date of its first transaction */
function currenciesInUse(today: string): { currency: string; from: string }[] {
  const rows = db
    .select({ currency: sql<string>`${accounts.currency}`, first: min(transactions.date) })
    .from(accounts)
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .where(isNotNull(accounts.currency))
    .groupBy(accounts.currency)
    .all();
  return rows.map((r) => ({
    currency: r.currency,
    from: r.first && r.first < today ? r.first : today,
  }));
}

async function run(): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: 0, error: null, unsupported: [] };
  const fetchImpl = options.fetch;
  if (!fetchImpl) return result;
  const settings = getBudgetSettings();
  const budget = settings.currency;
  if (!settings.downloadRates || !budget) return result;
  const today = options.today();

  for (const { currency, from } of currenciesInUse(today)) {
    let changed = 0;
    try {
      for (const range of downloadRanges(downloadedRange(currency, budget), from, today)) {
        const rates = await fetchDailyRates(fetchImpl, {
          base: currency,
          quote: budget,
          ...range,
        });
        changed += saveDownloadedRates(currency, budget, rates);
      }
    } catch (err) {
      if (!(err instanceof RatesUnavailableError)) throw err;
      if (err.code === 'unsupported') result.unsupported.push(currency);
      else result.error = 'unreachable';
    }
    if (changed) refreshFx({ currency });
    result.downloaded += changed;
    if (result.error) break;
  }

  saveBudgetSettings({
    ratesUpdatedAt: result.error ? settings.ratesUpdatedAt : options.now().toISOString(),
    ratesError:
      result.error ??
      (result.unsupported.length ? `unsupported:${result.unsupported.join(',')}` : null),
  });
  return result;
}

let running: Promise<DownloadResult> | null = null;
let rerun: Promise<DownloadResult> | null = null;

/**
 * Downloads missing rates now (no-op while downloading is off, or where it isn't available).
 * Asked while a run is under way, it runs once more after it: that run already read which
 * currencies and dates it needs, so a new account or transaction would wait for the next trigger.
 */
export function downloadRates(): Promise<DownloadResult> {
  if (running) {
    rerun ??= running
      .catch(() => undefined)
      .then(() => {
        rerun = null;
        return downloadRates();
      });
    return rerun;
  }
  running = run().finally(() => {
    running = null;
  });
  return running;
}

/** Starts a download in the background, if downloading is on; failures are recorded, not thrown */
export function scheduleRatesDownload() {
  if (!ratesDownloadAvailable() || !getBudgetSettings().downloadRates) return;
  downloadRates().catch((err) => console.error('Exchange rate download failed:', err));
}
