import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { categories, categoryGroups } from '../db/schema.js';
import { accountsRouter } from './accounts.js';
import { budgetRouter } from './budget.js';
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
const fakeFrankfurter: typeof fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url.pathname + url.search);
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
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  app.use('/api/budget', budgetRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use(
    '/api/currencies',
    createCurrenciesRouter({ download: downloadRates, scheduleDownload: () => {} }),
  );
  app.use(
    '/api/demo-currencies',
    createCurrenciesRouter({ download: null, scheduleDownload: () => {} }),
  );
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
    const saved = await send('PUT', '/currencies', { currency: 'EUR' });
    expect(saved).toMatchObject({ budgetCurrency: 'EUR', downloadRates: false });
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

describe('downloading rates', () => {
  it('is off until turned on, and refused in the demo', async () => {
    expect((await call('POST', '/currencies/download')).status).toBe(409);
    expect((await call('PUT', '/demo-currencies', { downloadRates: true })).status).toBe(403);
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
    await send('PUT', '/currencies', { downloadRates: true });
    const result = await send('POST', '/currencies/download');
    expect(result).toMatchObject({ error: null, unsupported: [], ratesError: null });
    expect(result.downloaded).toBeGreaterThan(0);
    // The Friday before applies to Saturday's coffee
    expect((await txIn(gbp.id))[0]).toMatchObject({ budgetAmount: -1_150, fxSource: 'rate' });
    // Rates typed in are kept
    const rates = await send('GET', '/currencies/GBP/rates?limit=1000');
    expect(rates.find((r: { date: string }) => r.date === '2026-03-01')).toMatchObject({
      rate: 1.17,
      source: 'manual',
    });

    // A second run only asks for what's new
    requests.length = 0;
    await send('POST', '/currencies/download');
    expect(requests.every((r) => r.includes('2026-10-'))).toBe(true);
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
});
