import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { transactions } from '../db/schema.js';
import { configureRatesDownload, downloadRates } from '../services/fx/download.js';
import { accountsRouter } from './accounts.js';
import { createCurrenciesRouter } from './currencies.js';
import { transactionsRouter } from './transactions.js';

// Editing a transaction in an account in another currency together with its value in the
// budget's (docs/multi-currency M3), and transactions added in bulk getting their rates. Its own
// file, so the database holds only these tests. The budget is in EUR.

let server: Server;
let base: string;

/** A fake Frankfurter: 1.15 EUR on every weekday asked for */
const requests: string[] = [];
const fakeFrankfurter: typeof fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url.pathname + url.search);
  const [from, to] = url.pathname.split('/').pop()!.split('..');
  const rates: Record<string, Record<string, number>> = {};
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      rates[d.toISOString().slice(0, 10)] = { EUR: 1.15 };
  }
  const currency = url.searchParams.get('base');
  return Response.json({ amount: 1, base: currency, start_date: from, end_date: to, rates });
};

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  configureRatesDownload({ fetch: fakeFrankfurter, today: () => '2026-10-09' });
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  app.use('/api/currencies', createCurrenciesRouter());
  app.use('/api/transactions', transactionsRouter);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  await send('PUT', '/currencies', { currency: 'EUR' });
});
afterAll(() => server.close());

const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const row = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;

async function account(name: string, currency?: string): Promise<string> {
  const { body } = await send('POST', '/accounts', { name, type: 'checking', currency });
  return body.id;
}

async function spend(accountId: string, amount = -500): Promise<string> {
  const { body } = await send('POST', '/transactions', {
    accountId,
    date: '2026-03-10',
    amount,
    payeeName: 'Market',
  });
  return body.id;
}

describe('editing a transaction with its value in the budget currency', () => {
  it('checks the value against the amount being saved with it', async () => {
    const gbp = await account('GBP pocket', 'GBP');
    const id = await spend(gbp);

    // A refund of £5 the bank turned into €4
    const res = await send('PUT', `/transactions/${id}`, { amount: 500, budgetAmount: 400 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 500, fxSource: 'manual', fxRate: 0.8 });
  });

  it('refuses a value in the wrong direction for the new amount, changing nothing', async () => {
    const gbp = await account('GBP card', 'GBP');
    const id = await spend(gbp);

    const res = await send('PUT', `/transactions/${id}`, { amount: 500, budgetAmount: -400 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enter an amount in the same direction as the transaction');
    expect(row(id)).toMatchObject({ amount: -500, fxSource: null });
  });

  it('refuses a value for a transaction moved into the budget currency, keeping its account', async () => {
    const gbp = await account('GBP wallet', 'GBP');
    const eur = await account('EUR checking');
    const id = await spend(gbp);

    const res = await send('PUT', `/transactions/${id}`, { accountId: eur, budgetAmount: 4_500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This account is in the budget’s currency');
    expect(row(id).accountId).toBe(gbp);
  });
});

describe('transactions added in bulk', () => {
  it('a CSV import into an account in another currency converts every row', async () => {
    const gbp = await account('GBP savings', 'GBP');
    await send('PUT', '/currencies/GBP/rates/2026-02-01', { rate: 1.2 });

    const rows = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-02-0${i + 2}`,
      amount: -(i + 1) * 1_000,
      payeeName: `Shop ${i}`,
      importedId: `csv-${i}`,
    }));
    const { body } = await send('POST', '/transactions/import/confirm', { accountId: gbp, rows });
    expect(body).toEqual({ imported: 5, skipped: 0 });

    const saved = db.select().from(transactions).where(eq(transactions.accountId, gbp)).all();
    expect(saved).toHaveLength(5);
    for (const t of saved) expect(t).toMatchObject({ fxRate: 1.2, fxSource: 'rate' });
  });

  it('rows still waiting for a rate start a download when downloading is on', async () => {
    const usd = await account('USD account', 'USD');
    // Turning downloading on downloads what's missing; wait for it, then start counting
    await send('PUT', '/currencies', { downloadRates: true });
    await downloadRates();
    requests.length = 0;

    const { body } = await send('POST', '/transactions/import/confirm', {
      accountId: usd,
      rows: [{ date: '2026-06-01', amount: -2_000, payeeName: 'Diner', importedId: 'usd-1' }],
    });
    expect(body).toEqual({ imported: 1, skipped: 0 });
    // The import started the download itself
    expect(requests.some((r) => r.includes('base=USD'))).toBe(true);
    await downloadRates();

    const [t] = db.select().from(transactions).where(eq(transactions.accountId, usd)).all();
    expect(t).toMatchObject({ fxRate: 1.15, fxSource: 'rate' });
  });
});
