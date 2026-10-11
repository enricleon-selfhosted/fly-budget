import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { categories, categoryGroups } from '../db/schema.js';
import { accountsRouter } from './accounts.js';
import { budgetRouter } from './budget.js';
import { exportRouter } from './export.js';
import { reportsRouter } from './reports.js';
import { transactionsRouter } from './transactions.js';
import { createCurrenciesRouter } from './currencies.js';
import { configureRatesDownload, downloadRates } from '../services/fx/download.js';

// Budgeting across currencies (docs/multi-currency): a budget in EUR with accounts in GBP on and
// off budget, through the HTTP API. Its own file, so the database holds only these tests. Each
// test uses its own month, so their totals don't mix.

let server: Server;
let base: string;

/** A fake Frankfurter: 1.15 EUR on every weekday asked for, for any currency but pesos */
const requests: string[] = [];
let frankfurterDown = false;
/** While set, answers wait for it */
let frankfurterGate: Promise<void> | null = null;
const fakeFrankfurter: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  requests.push(url.pathname + url.search);
  // The host is fixed: never follow a redirect elsewhere
  expect(init?.redirect).toBe('error');
  if (frankfurterGate) await frankfurterGate;
  if (frankfurterDown) throw new TypeError('fetch failed');
  const [from, to] = url.pathname.split('/').pop()!.split('..');
  const currency = url.searchParams.get('base');
  if (currency === 'ARS') return new Response('{"message":"not found"}', { status: 404 });
  const rates: Record<string, Record<string, number>> = {};
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      rates[d.toISOString().slice(0, 10)] = { EUR: 1.15 };
  }
  return Response.json({ amount: 1, base: currency, start_date: from, end_date: to, rates });
};

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  configureRatesDownload({ fetch: fakeFrankfurter, today: () => '2026-10-09' });
  const app = express();
  // Restores parse their own (bigger) body, like in index.ts
  app.use((req, res, next) =>
    req.path === '/api/export/restore' ? next() : express.json()(req, res, next),
  );
  app.use('/api/accounts', accountsRouter);
  app.use('/api/budget', budgetRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/currencies', createCurrenciesRouter());
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  db.insert(categoryGroups).values({ id: 'g-inc', name: 'Income', isIncome: 1 }).run();
  db.insert(categories).values({ id: 'c-salary', groupId: 'g-inc', name: 'Salary' }).run();
  db.insert(categoryGroups).values({ id: 'g-exp', name: 'Everyday', isIncome: 0 }).run();
  db.insert(categories).values({ id: 'c-food', groupId: 'g-exp', name: 'Groceries' }).run();
});
afterAll(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const send = async (method: string, path: string, body?: unknown) =>
  (await call(method, path, body)).body;

const spentIn = async (month: string, categoryId: string) => {
  const groups = await send('GET', `/budget/${month}`);
  for (const g of groups) for (const c of g.categories) if (c.id === categoryId) return c.spent;
  return null;
};
const txIn = async (accountId: string) => send('GET', `/transactions?account_id=${accountId}`);

describe('the budget currency', () => {
  it('is unknown until a client sends it; then it is the budget’s', async () => {
    expect((await send('GET', '/currencies')).budgetCurrency).toBeNull();
    const saved = await send('PUT', '/currencies', { currency: 'EUR', ifUnset: true });
    expect(saved).toMatchObject({ budgetCurrency: 'EUR', downloadRates: false });
  });

  it('sent by a device that found none, changes nothing once the budget has one', async () => {
    // Two devices loading at once: the second one's currency is not a change of currency
    const second = await send('PUT', '/currencies', { currency: 'USD', ifUnset: true });
    expect(second.budgetCurrency).toBe('EUR');
  });

  it('refuses anything but an ISO code', async () => {
    expect((await call('PUT', '/currencies', { currency: 'euro' })).status).toBe(400);
  });
});

describe('an account in another currency on budget', () => {
  it('counts its spending and income at the day’s rate typed in, and says what has no rate', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'GBP spending',
      type: 'checking',
      currency: 'GBP',
      isOffBudget: 0,
    });
    expect(gbp).toMatchObject({ currency: 'GBP', isOffBudget: 0 });

    // Before any rate: not in the budget yet, and the summary says so
    await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-03-05',
      amount: -2_000,
      payeeName: 'Tesco',
      categoryId: 'c-food',
    });
    expect(await spentIn('2026-03', 'c-food')).toBe(0);
    expect((await send('GET', '/budget/2026-03/summary')).waitingForRate).toBe(1);
    expect((await txIn(gbp.id))[0].budgetAmount).toBeNull();

    // A rate typed in for the 1st applies from then on
    const rate = await call('PUT', '/currencies/GBP/rates/2026-03-01', { rate: 1.17 });
    expect(rate.status).toBe(200);
    expect(await spentIn('2026-03', 'c-food')).toBe(2_340);
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -2_340, fxSource: 'rate' });

    await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-03-06',
      amount: 50_000,
      payeeName: 'ACME LTD',
      categoryId: 'c-salary',
    });
    const summary = await send('GET', '/budget/2026-03/summary');
    expect(summary).toMatchObject({ income: 58_500, waitingForRate: 0 });

    // Income and spending reports count the converted amounts too
    const months = await send('GET', '/reports/income-vs-expenses?from=2026-03&to=2026-03');
    expect(months[0]).toMatchObject({ income: 58_500, expenses: 2_340 });
  });

  it('a split’s parts share its rate', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'GBP card',
      type: 'credit',
      currency: 'GBP',
      isOffBudget: 0,
    });
    await send('PUT', '/currencies/GBP/rates/2026-04-01', { rate: 1.2 });
    await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-04-02',
      amount: -1_000,
      payeeName: 'Boots',
      splits: [
        { categoryId: 'c-food', amount: -600 },
        { categoryId: null, amount: -400 },
      ],
    });
    const [parent] = await txIn(gbp.id);
    expect(parent.budgetAmount).toBe(-1_200);
    expect(parent.children.map((c: { budgetAmount: number }) => c.budgetAmount).sort()).toEqual([
      -480, -720,
    ]);
    expect(await spentIn('2026-04', 'c-food')).toBe(720);
  });

  it('an amount typed in the budget currency wins, follows amount edits, and can go back', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'GBP cash',
      type: 'cash',
      currency: 'GBP',
      isOffBudget: 0,
    });
    await send('PUT', '/currencies/GBP/rates/2026-05-01', { rate: 1.1 });
    const tx = await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-05-03',
      amount: -1_000,
      payeeName: 'Market',
      categoryId: 'c-food',
    });
    expect(await spentIn('2026-05', 'c-food')).toBe(1_100);

    // The card statement said €11.80
    const wrongWay = await call('PUT', `/transactions/${tx.id}`, { budgetAmount: 1_180 });
    expect(wrongWay.status).toBe(400);
    expect((await call('PUT', `/transactions/${tx.id}`, { budgetAmount: -1_180 })).status).toBe(
      200,
    );
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -1_180, fxSource: 'manual' });
    expect(await spentIn('2026-05', 'c-food')).toBe(1_180);

    // Doubling the amount keeps the rate typed in
    await send('PUT', `/transactions/${tx.id}`, { amount: -2_000 });
    expect((await txIn(gbp.id))[0].budgetAmount).toBe(-2_360);

    await send('PUT', `/transactions/${tx.id}`, { budgetAmount: null });
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -2_200, fxSource: 'rate' });
  });

  it('an exchange into a budget account converts at exactly what arrived, and is no income', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'Revolut GBP',
      type: 'checking',
      currency: 'GBP',
      isOffBudget: 0,
    });
    const eur = await send('POST', '/accounts', { name: 'Revolut EUR', type: 'checking' });
    const [out] = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2026-06-10',
      amount: 50_000,
      toAmount: 57_512,
    });
    expect((await txIn(gbp.id)).find((t: { id: string }) => t.id === out.id)).toMatchObject({
      budgetAmount: -57_512,
      fxSource: 'exchange',
    });
    // Between two budget accounts it's an uncategorized transfer: the budget doesn't change (M7)
    expect((await send('GET', '/budget/2026-06/summary')).income).toBe(0);

    // A rate can't be typed in for it
    expect((await call('PUT', `/transactions/${out.id}`, { budgetAmount: -50_000 })).status).toBe(
      400,
    );

    // Unlinked, the GBP side falls back to the day's rate: the one typed in for May still applies
    await send('POST', `/transactions/${out.id}/unlink-transfer`);
    expect((await txIn(gbp.id)).find((t: { id: string }) => t.id === out.id)).toMatchObject({
      budgetAmount: -55_000,
      fxSource: 'rate',
    });
  });
});

describe('exchanges, linked and deleted', () => {
  const onBudget = (name: string) =>
    send('POST', '/accounts', { name, type: 'checking', currency: 'GBP', isOffBudget: 0 });

  it('deleting the budget side of an exchange gives the other side a rate of its own', async () => {
    const gbp = await onBudget('Exchanged then deleted');
    const eur = await send('POST', '/accounts', { name: 'Its euros', type: 'checking' });
    const [out, into] = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2026-06-11',
      amount: 50_000,
      toAmount: 57_512,
    });
    expect((await call('DELETE', `/transactions/${into.id}`)).status).toBe(204);
    expect((await txIn(gbp.id)).find((t: { id: string }) => t.id === out.id)).toMatchObject({
      budgetAmount: -55_000,
      fxSource: 'rate',
    });
  });

  it('linking a transaction with a value typed in into an exchange uses what arrived', async () => {
    const gbp = await onBudget('Typed in, then linked');
    const eur = await send('POST', '/accounts', { name: 'Arrived here', type: 'checking' });
    const out = await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-06-12',
      amount: -10_000,
      payeeName: 'Exchange',
    });
    await send('PUT', `/transactions/${out.id}`, { budgetAmount: -9_000 });
    const into = await send('POST', '/transactions', {
      accountId: eur.id,
      date: '2026-06-12',
      amount: 11_000,
      payeeName: 'Exchange',
    });
    expect(
      (await call('POST', `/transactions/${out.id}/link-transfer`, { otherId: into.id })).status,
    ).toBe(200);
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -11_000, fxSource: 'exchange' });
  });
});

describe('balances and net worth', () => {
  it('value an account in another currency at the rate of the day', async () => {
    const chf = await send('POST', '/accounts', {
      name: 'Swiss savings',
      type: 'savings',
      currency: 'CHF',
      startingBalance: 100_000,
    });
    await send('PUT', '/currencies/CHF/rates/2026-01-01', { rate: 1.05 });
    await send('PUT', '/currencies/CHF/rates/2026-02-01', { rate: 1.07 });
    const listed = (await send('GET', '/accounts')).find((a: { id: string }) => a.id === chf.id);
    expect(listed).toMatchObject({
      balance: 100_000,
      budgetBalance: 107_000,
      budgetBalanceAsOf: '2026-02-01',
    });

    // Nothing else held money in January and February
    const worth = await send('GET', '/reports/net-worth?from=2025-12&to=2026-02');
    expect(worth.map((p: { netWorth: number }) => p.netWorth)).toEqual([0, 105_000, 107_000]);
  });
});

describe('switching an account on or off budget', () => {
  it('uncategorizes transfers that stop crossing the budget boundary (M8)', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'Pay GBP',
      type: 'checking',
      currency: 'GBP',
    });
    const eur = await send('POST', '/accounts', { name: 'Main EUR', type: 'checking' });
    // Off budget, the EUR side of the exchange is the income (D24)
    const [, into] = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2026-08-07',
      amount: 50_000,
      toAmount: 58_000,
      categoryId: 'c-salary',
    });
    expect((await send('GET', '/budget/2026-08/summary')).income).toBe(58_000);

    const updated = await send('PUT', `/accounts/${gbp.id}`, { isOffBudget: 0 });
    expect(updated.transfersUncategorized).toBe(1);
    const row = (await txIn(eur.id)).find((t: { id: string }) => t.id === into.id);
    expect(row.categoryId).toBeNull();
    expect((await send('GET', '/budget/2026-08/summary')).income).toBe(0);
  });
});

/** Runs `body` as the demo does: where rates can't be downloaded at all (M10) */
async function asInDemo(body: () => Promise<void>) {
  configureRatesDownload({ fetch: null });
  try {
    await body();
  } finally {
    configureRatesDownload({ fetch: fakeFrankfurter });
  }
}

describe('downloading rates', () => {
  it('is off until turned on, and refused in the demo', async () => {
    expect((await call('POST', '/currencies/download')).status).toBe(409);
    await asInDemo(async () => {
      expect((await call('PUT', '/currencies', { downloadRates: true })).status).toBe(403);
      expect((await call('POST', '/currencies/download')).status).toBe(403);
    });
    expect((await send('GET', '/currencies')).downloadRates).toBe(false);
    expect(requests).toEqual([]);
  });

  it('fills the rates from each currency’s first transaction and converts what was waiting', async () => {
    const gbp = await send('POST', '/accounts', {
      name: 'Downloaded GBP',
      type: 'checking',
      currency: 'GBP',
      isOffBudget: 0,
    });
    // A Saturday in September, after the last rate typed in (July): waiting
    await send('POST', '/transactions', {
      accountId: gbp.id,
      date: '2026-09-12',
      amount: -1_000,
      payeeName: 'Pret',
      categoryId: 'c-food',
    });
    // Turning it on starts a download in the background; downloading now waits for what's missing
    await send('PUT', '/currencies', { downloadRates: true });
    const result = await send('POST', '/currencies/download');
    expect(result).toMatchObject({ error: null, unsupported: [], ratesError: null });
    // The Friday before applies to Saturday's coffee
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -1_150, fxSource: 'rate' });
    // From the first transaction in GBP (March), keeping the rates typed in
    const rates = await send('GET', '/currencies/GBP/rates?limit=1000');
    const on = (date: string) => rates.find((r: { date: string }) => r.date === date);
    expect(on('2026-03-05')).toMatchObject({ rate: 1.15, source: 'ecb' });
    expect(on('2026-03-01')).toMatchObject({ rate: 1.17, source: 'manual' });

    // A second run only asks for what's new
    requests.length = 0;
    await send('POST', '/currencies/download');
    expect(requests.every((r) => r.includes('2026-10-'))).toBe(true);
  });

  it('asked while a download runs, downloads again afterwards', async () => {
    let release!: () => void;
    frankfurterGate = new Promise((r) => (release = r));
    requests.length = 0;
    // This run already knows which currencies it needs when the francs appear
    const first = downloadRates();
    const chf = await send('POST', '/accounts', {
      name: 'Franken',
      type: 'checking',
      currency: 'CHF',
      isOffBudget: 0,
    });
    await send('POST', '/transactions', {
      accountId: chf.id,
      date: '2026-09-14',
      amount: -500,
      payeeName: 'Migros',
    });
    const again = downloadRates();
    frankfurterGate = null;
    release();
    await first;
    await again;
    expect(requests.some((r) => r.includes('base=CHF'))).toBe(true);
    expect((await txIn(chf.id))[0]).toMatchObject({ budgetAmount: -575, fxSource: 'rate' });
  });

  it('records a currency the ECB doesn’t publish, and an unreachable service', async () => {
    await send('POST', '/accounts', { name: 'Pesos', type: 'cash', currency: 'ARS' });
    const result = await send('POST', '/currencies/download');
    expect(result).toMatchObject({ unsupported: ['ARS'], ratesError: 'unsupported:ARS' });

    frankfurterDown = true;
    await send('POST', '/accounts', { name: 'Krona', type: 'cash', currency: 'SEK' });
    const down = await send('POST', '/currencies/download');
    expect(down.ratesError).toBe('unreachable');
    frankfurterDown = false;
  });

  it('never happens in the demo, even after restoring a budget that downloads', async () => {
    // Asked only if `fetch: null` didn't replace it
    const asked: string[] = [];
    configureRatesDownload({
      fetch: async (input) => {
        asked.push(String(input));
        throw new TypeError('A request left the demo');
      },
    });
    await asInDemo(async () => {
      // A backup made where downloading is on brings the setting along
      const { body: backup } = await call('GET', '/export/backup');
      backup.budgetSettings[0].downloadRates = 1;
      expect((await call('POST', '/export/restore', backup)).status).toBe(200);
      const before = await send('GET', '/currencies');
      expect(before.downloadRates).toBe(true);

      // A new currency and a transaction with no rate would otherwise start downloads
      const nok = await send('POST', '/accounts', {
        name: 'Kroner',
        type: 'cash',
        currency: 'NOK',
      });
      await send('POST', '/transactions', {
        accountId: nok.id,
        date: '2026-10-08',
        amount: -5_000,
        payeeName: 'Rema 1000',
      });
      expect(await downloadRates()).toEqual({ downloaded: 0, error: null, unsupported: [] });
      const after = await send('GET', '/currencies');
      expect(after).toMatchObject({
        ratesUpdatedAt: before.ratesUpdatedAt,
        ratesError: before.ratesError,
      });
      expect(after.currencies.find((c: { code: string }) => c.code === 'NOK')).toMatchObject({
        latest: null,
        waiting: 1,
      });
    });
    expect(asked).toEqual([]);
    // The rest of the file doesn't download
    await send('PUT', '/currencies', { downloadRates: false });
  });
});

describe('restoring', () => {
  it('refuses a backup with a rate of zero or a made-up currency', async () => {
    const { body: backup } = await call('GET', '/export/backup');
    const broken = [
      { ...backup, exchangeRates: [{ ...backup.exchangeRates[0], rate: 0 }] },
      { ...backup, accounts: [{ ...backup.accounts[0], currency: 'euro' }] },
      { ...backup, budgetSettings: [{ ...backup.budgetSettings[0], currency: 'XX' }] },
    ];
    for (const body of broken)
      expect((await call('POST', '/export/restore', body)).status).toBe(400);
  });
});

describe('changing the budget currency', () => {
  it('re-labels accounts so their money stays what it is, and converts again', async () => {
    const eur = await send('POST', '/accounts', { name: 'Euro account', type: 'checking' });
    const before = await send('GET', '/accounts');
    const gbpAccounts = before.filter((a: { currency: string | null }) => a.currency === 'GBP');
    expect(gbpAccounts.length).toBeGreaterThan(0);

    const changed = await send('PUT', '/currencies', { currency: 'GBP' });
    expect(changed.budgetCurrency).toBe('GBP');
    const after = await send('GET', '/accounts');
    const byId = new Map(after.map((a: { id: string }) => [a.id, a]));
    expect(byId.get(eur.id)).toMatchObject({ currency: 'EUR' });
    for (const a of gbpAccounts) expect(byId.get(a.id)).toMatchObject({ currency: null });

    // Back to EUR for the rest of the file's state
    await send('PUT', '/currencies', { currency: 'EUR' });
    expect(
      (await send('GET', '/accounts')).find((a: { id: string }) => a.id === eur.id).currency,
    ).toBeNull();
  });

  it('can let the accounts in the budget’s currency follow it, when the first was a wrong guess', async () => {
    const mine = await send('POST', '/accounts', { name: 'Girokonto', type: 'checking' });
    // The dialog asks about every account in the budget's currency, closed ones too
    const closed = await send('POST', '/accounts', { name: 'Old account', type: 'checking' });
    const before = (await send('GET', '/currencies')).accountsInBudgetCurrency;
    await call('DELETE', `/accounts/${closed.id}`);
    expect((await send('GET', '/currencies')).accountsInBudgetCurrency).toBe(before);
    const gbp = (await send('GET', '/accounts')).filter(
      (a: { currency: string | null }) => a.currency === 'GBP',
    );
    const changed = await send('PUT', '/currencies', { currency: 'USD', budgetAccounts: 'follow' });
    expect(changed.budgetCurrency).toBe('USD');
    const after = new Map(
      (await send('GET', '/accounts')).map((a: { id: string }) => [a.id, a] as const),
    );
    // Its amounts were in dollars all along: only the name of the budget's currency changed
    expect(after.get(mine.id)).toMatchObject({ currency: null });
    for (const a of gbp) expect(after.get(a.id)).toMatchObject({ currency: 'GBP' });
  });
});
