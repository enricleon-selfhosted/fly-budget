import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { accountsRouter } from './accounts.js';

// Accounts in another currency than the budget's keep it, and stay off budget. Its own file, so
// the database holds only this test's data.

let server: Server;
let base: string;

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server.close());

const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('account currency', () => {
  it('accounts in the budget currency have none and follow the usual budget rules', async () => {
    const { status, body } = await send('POST', '/accounts', { name: 'Main', type: 'checking' });
    expect(status).toBe(201);
    expect(body.currency).toBeNull();
    expect(body.isOffBudget).toBe(0);
  });

  it('an account in another currency is created off budget, even a checking account', async () => {
    const { body } = await send('POST', '/accounts', {
      name: 'USD pocket',
      type: 'checking',
      currency: 'USD',
    });
    expect(body.currency).toBe('USD');
    expect(body.isOffBudget).toBe(1);
  });

  it('an account in another currency can be on budget, from the start or later (M1)', async () => {
    const created = await send('POST', '/accounts', {
      name: 'GBP',
      type: 'savings',
      currency: 'GBP',
      isOffBudget: 0,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ currency: 'GBP', isOffBudget: 0 });

    const { body: account } = await send('POST', '/accounts', {
      name: 'CHF',
      type: 'savings',
      currency: 'CHF',
    });
    const updated = await send('PUT', `/accounts/${account.id}`, { isOffBudget: 0 });
    expect(updated.body).toMatchObject({ currency: 'CHF', isOffBudget: 0 });
  });

  it('changing an account’s currency keeps it on or off budget', async () => {
    const { body: account } = await send('POST', '/accounts', { name: 'Wallet', type: 'cash' });
    const foreign = await send('PUT', `/accounts/${account.id}`, { currency: 'SEK' });
    expect(foreign.body).toMatchObject({ currency: 'SEK', isOffBudget: 0 });

    const back = await send('PUT', `/accounts/${account.id}`, { currency: null });
    expect(back.body).toMatchObject({ currency: null, isOffBudget: 0 });
  });

  it.each(['eur', 'EURO', 'E1R', ''])('rejects %j as a currency', async (currency) => {
    const { status } = await send('POST', '/accounts', { name: 'X', type: 'cash', currency });
    expect(status).toBe(400);
  });

  it('a rename leaves the currency alone', async () => {
    const { body: account } = await send('POST', '/accounts', {
      name: 'NOK',
      type: 'savings',
      currency: 'NOK',
    });
    const { body } = await send('PUT', `/accounts/${account.id}`, { name: 'Norway' });
    expect(body).toMatchObject({ name: 'Norway', currency: 'NOK', isOffBudget: 1 });
  });
});
