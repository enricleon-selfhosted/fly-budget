import { Router } from 'express';
import { format } from 'date-fns';
import { isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { currencyCode } from '../utils/currency.js';
import { isoDate } from '../utils/validation.js';
import {
  changeBudgetCurrency,
  latestRates,
  removeManualRate,
  setManualRate,
  waitingForRates,
} from '../services/fx/fxService.js';
import { recentRates } from '../services/fx/ratesStore.js';
import { getBudgetSettings, saveBudgetSettings } from '../services/fx/settings.js';
import {
  downloadRates,
  ratesDownloadAvailable,
  scheduleRatesDownload,
} from '../services/fx/download.js';

// The budget's currency and the exchange rates of accounts in other currencies
// (docs/multi-currency). Where rates can't be downloaded (the demo, M10), turning it on is refused.

const NOT_HERE = "Downloading rates isn't available in the demo. Enter them by hand.";

const settingsSchema = z
  .object({
    currency: currencyCode,
    /** What the accounts in the budget's currency do when it changes (default: keep theirs) */
    budgetAccounts: z.enum(['keep', 'follow']),
    /** Only when the budget has no currency yet: a device sending its own (M2) */
    ifUnset: z.boolean(),
    downloadRates: z.boolean(),
  })
  .partial()
  .strict();
const rateSchema = z.object({ rate: z.number().positive().finite().max(1e9) }).strict();

/** Settings plus, for each currency an account is kept in, its latest rate and what's waiting */
function overview() {
  const settings = getBudgetSettings();
  const today = format(new Date(), 'yyyy-MM-dd');
  const inUse = db
    .select({ code: sql<string>`${accounts.currency}`, accounts: sql<number>`count(*)` })
    .from(accounts)
    .where(isNotNull(accounts.currency))
    .groupBy(accounts.currency)
    .all();
  // Open or closed: a change of the budget's currency re-labels them all (M2)
  const accountsInBudgetCurrency =
    db
      .select({ n: sql<number>`count(*)` })
      .from(accounts)
      .where(isNull(accounts.currency))
      .get()?.n ?? 0;
  const waiting = new Map(waitingForRates().map((w) => [w.currency, w.count]));
  const latest = latestRates();
  return {
    budgetCurrency: settings.currency,
    downloadRates: settings.downloadRates,
    ratesUpdatedAt: settings.ratesUpdatedAt,
    ratesError: settings.ratesError,
    accountsInBudgetCurrency,
    currencies: inUse.map((c) => ({
      code: c.code,
      accounts: c.accounts,
      latest: latest(c.code, today),
      waiting: waiting.get(c.code) ?? 0,
    })),
  };
}

export function createCurrenciesRouter() {
  const router = Router();

  router.get('/', (_req, res) => res.json(overview()));

  router.put('/', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { currency: asked, budgetAccounts, ifUnset, downloadRates: downloading } = parsed.data;
    if (downloading && !ratesDownloadAvailable()) return res.status(403).json({ error: NOT_HERE });
    // Two devices finding no currency at once: the first one's stays, the second changes nothing
    const currency = ifUnset && getBudgetSettings().currency ? undefined : asked;
    if (currency) changeBudgetCurrency(currency, budgetAccounts);
    if (downloading !== undefined) {
      saveBudgetSettings({
        downloadRates: downloading,
        ...(downloading ? {} : { ratesError: null }),
      });
    }
    if (currency || downloading) scheduleRatesDownload();
    res.json(overview());
  });

  // A currency's rates to the budget's, newest first
  router.get('/:code/rates', (req, res) => {
    const code = currencyCode.safeParse(req.params.code);
    const limit = z.coerce.number().int().min(1).max(1000).default(60).safeParse(req.query.limit);
    if (!code.success || !limit.success) return res.status(400).json({ error: 'Invalid request' });
    const budget = getBudgetSettings().currency;
    res.json(budget ? recentRates(code.data, budget, limit.data) : []);
  });

  // A rate typed in for a date: it applies until the next rate (M4)
  router.put('/:code/rates/:date', (req, res) => {
    const code = currencyCode.safeParse(req.params.code);
    const date = isoDate.safeParse(req.params.date);
    const body = rateSchema.safeParse(req.body);
    if (!code.success || !date.success || !body.success) {
      return res.status(400).json({ error: 'Expected a currency, a date and a positive rate' });
    }
    const saved = setManualRate(code.data, date.data, body.data.rate);
    if (!saved.ok) return res.status(saved.status).json({ error: saved.error });
    res.json(saved.rate);
  });

  router.delete('/:code/rates/:date', (req, res) => {
    const code = currencyCode.safeParse(req.params.code);
    const date = isoDate.safeParse(req.params.date);
    if (!code.success || !date.success) return res.status(400).json({ error: 'Invalid request' });
    const removed = removeManualRate(code.data, date.data);
    if (!removed.ok) return res.status(removed.status).json({ error: removed.error });
    res.status(204).send();
  });

  // Download missing rates now
  router.post('/download', async (_req, res, next) => {
    if (!ratesDownloadAvailable()) return res.status(403).json({ error: NOT_HERE });
    if (!getBudgetSettings().downloadRates) {
      return res.status(409).json({ error: 'Turn on downloading rates first' });
    }
    try {
      const result = await downloadRates();
      res.json({ ...result, ...overview() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
