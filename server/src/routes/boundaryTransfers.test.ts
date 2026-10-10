import { afterAll, beforeAll, expect, it } from 'vitest';
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

// Paid in GBP, budgeting in EUR (decision D24): the GBP account is off budget, and money counts
// for the budget when it's changed into EUR. Its own file, so the database holds only this test.

let server: Server;
let base: string;
const month = '2096-04';

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  app.use('/api/budget', budgetRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/transactions', transactionsRouter);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server.close());

const send = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());

it('an exchange into the budget currency, categorized as income, is income to budget', async () => {
  db.insert(categoryGroups).values({ id: 'g-inc', name: 'Income', isIncome: 1 }).run();
  db.insert(categories).values({ id: 'c-salary', groupId: 'g-inc', name: 'Salary' }).run();
  db.insert(categoryGroups).values({ id: 'g-exp', name: 'Bills', isIncome: 0 }).run();
  db.insert(categories).values({ id: 'c-rent', groupId: 'g-exp', name: 'Rent' }).run();

  const gbp = await send('POST', '/accounts', {
    name: 'Revolut GBP',
    type: 'checking',
    currency: 'GBP',
  });
  const eur = await send('POST', '/accounts', { name: 'Revolut EUR', type: 'checking' });

  // The weekly pay arrives in GBP: off budget, so not income yet
  await send('POST', '/transactions', {
    accountId: gbp.id,
    date: `${month}-03`,
    amount: 60_000,
    payeeName: 'ACME LTD',
  });
  expect((await send('GET', `/budget/${month}/summary`)).income).toBe(0);

  // Changed into EUR: the EUR side is categorized as income
  await send('POST', '/transactions/transfer', {
    fromAccountId: gbp.id,
    toAccountId: eur.id,
    date: `${month}-04`,
    amount: 50_000,
    toAmount: 58_025,
    categoryId: 'c-salary',
  });
  await send('POST', '/transactions', {
    accountId: eur.id,
    date: `${month}-05`,
    amount: -40_000,
    categoryId: 'c-rent',
  });

  const summary = await send('GET', `/budget/${month}/summary`);
  expect(summary.income).toBe(58_025);

  const incomeVsExpenses = await send(
    'GET',
    `/reports/income-vs-expenses?from=${month}&to=${month}`,
  );
  expect(incomeVsExpenses[0]).toMatchObject({ income: 58_025, expenses: 40_000 });

  // The GBP pay and the GBP side of the exchange stay out of the budget-currency reports
  const income = await send('GET', `/reports/income-by-category?from=${month}&to=${month}`);
  expect(income).toEqual([
    expect.objectContaining({ categoryId: 'c-salary', totalReceived: 58_025 }),
  ]);
});

it('a plain transfer between two budget accounts is neither income nor spending', async () => {
  const a = await send('POST', '/accounts', { name: 'Main', type: 'checking' });
  const b = await send('POST', '/accounts', { name: 'Savings', type: 'savings' });
  await send('POST', '/transactions/transfer', {
    fromAccountId: a.id,
    toAccountId: b.id,
    date: `${month}-10`,
    amount: 10_000,
  });
  const incomeVsExpenses = await send(
    'GET',
    `/reports/income-vs-expenses?from=${month}&to=${month}`,
  );
  expect(incomeVsExpenses[0]).toMatchObject({ income: 58_025, expenses: 40_000 });
});
