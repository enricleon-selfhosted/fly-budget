import { Router } from 'express';
import { format } from 'date-fns';
import { isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { currencyCode } from '../utils/currency.js';
import { isoDate } from '../utils/validation.js';
import { rateId } from '../services/fx/conversion.js';
import {
  changeBudgetCurrency,
  latestRate,
  refreshFx,
  waitingForRates,
} from '../services/fx/fxService.js';
import { deleteManualRate, recentRates, saveManualRate } from '../services/fx/ratesStore.js';
import { getBudgetSettings, saveBudgetSettings } from '../services/fx/settings.js';
import type { DownloadResult } from '../services/fx/download.js';

// The budget's currency and the exchange rates of accounts in other currencies
// (docs/multi-currency). `download` is the rates download; the demo passes null (M10).

export type CurrenciesDeps = {
  download: (() => Promise<DownloadResult>) | null;
  /** Starts a download in the background, when downloading is on */
  scheduleDownload: () => void;
};

const NOT_HERE = "Downloading rates isn't available in the demo. Enter them by hand.";

const settingsSchema = z
  .object({ currency: currencyCode, downloadRates: z.boolean() })
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
  const waiting = new Map(waitingForRates().map((w) => [w.currency, w.count]));
  return {
    budgetCurrency: settings.currency,
    downloadRates: settings.downloadRates,
    ratesUpdatedAt: settings.ratesUpdatedAt,
    ratesError: settings.ratesError,
    currencies: inUse.map((c) => ({
      code: c.code,
      accounts: c.accounts,
      latest: latestRate(c.code, today),
      waiting: waiting.get(c.code) ?? 0,
    })),
  };
}

export function createCurrenciesRouter(deps: CurrenciesDeps) {
  const router = Router();

  router.get('/', (_req, res) => res.json(overview()));

  router.put('/', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { currency, downloadRates } = parsed.data;
    if (downloadRates && !deps.download) return res.status(403).json({ error: NOT_HERE });
    if (currency) changeBudgetCurrency(currency);
    if (downloadRates !== undefined) {
      saveBudgetSettings({ downloadRates, ...(downloadRates ? {} : { ratesError: null }) });
    }
    if (currency || downloadRates) deps.scheduleDownload();
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
    const budget = getBudgetSettings().currency;
    if (!budget) return res.status(409).json({ error: 'Choose the budget’s currency first' });
    if (code.data === budget) {
      return res.status(400).json({ error: 'That’s the budget’s own currency' });
    }
    const row = saveManualRate(code.data, budget, date.data, body.data.rate);
    refreshFx({ currency: code.data });
    res.json(row);
  });

  router.delete('/:code/rates/:date', (req, res) => {
    const code = currencyCode.safeParse(req.params.code);
    const date = isoDate.safeParse(req.params.date);
    const budget = getBudgetSettings().currency;
    if (!code.success || !date.success || !budget) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const removed = deleteManualRate(rateId(code.data, budget, date.data));
    if (!removed) return res.status(404).json({ error: 'No rate typed in for that date' });
    refreshFx({ currency: code.data });
    res.status(204).send();
  });

  // Download missing rates now
  router.post('/download', async (_req, res, next) => {
    if (!deps.download) return res.status(403).json({ error: NOT_HERE });
    if (!getBudgetSettings().downloadRates) {
      return res.status(409).json({ error: 'Turn on downloading rates first' });
    }
    try {
      const result = await deps.download();
      res.json({ ...result, ...overview() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
