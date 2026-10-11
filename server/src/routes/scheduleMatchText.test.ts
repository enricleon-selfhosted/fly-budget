import { afterAll, beforeAll, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { addDays, format } from 'date-fns';
import { db } from '../db/index.js';
import { transactions } from '../db/schema.js';
import { MAX_DATE_FLEXIBILITY } from '../services/scheduleMatching.js';
import { accountsRouter } from './accounts.js';
import { schedulesRouter } from './schedules.js';

// A recurring item can be recognized by the bank's text (decision D28), and how its occurrences
// are matched. Its own file, so the database holds only this test's data.

let server: Server;
let base: string;

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  app.use('/api/schedules', schedulesRouter);
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

it('stores, changes and clears the bank text of a weekly, variable income', async () => {
  const { body: account } = await send('POST', '/accounts', {
    name: 'Revolut GBP',
    type: 'checking',
    currency: 'GBP',
  });
  const created = await send('POST', '/schedules', {
    name: 'Weekly pay',
    amount: 60_000,
    amountType: 'variable',
    recurrenceType: 'weekly',
    startDate: '2026-03-06',
    accountId: account.id,
    matchText: '  ACME LTD ',
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ matchText: 'ACME LTD', amountType: 'variable' });

  const changed = await send('PUT', `/schedules/${created.body.id}`, { matchText: 'ACME PAYROLL' });
  expect(changed.body.matchText).toBe('ACME PAYROLL');
  const cleared = await send('PUT', `/schedules/${created.body.id}`, { matchText: null });
  expect(cleared.body.matchText).toBeNull();

  const tooLong = await send('PUT', `/schedules/${created.body.id}`, {
    matchText: 'x'.repeat(201),
  });
  expect(tooLong.status).toBe(400);
});

it('takes a date flexibility up to the most matching looks for', async () => {
  const item = {
    name: 'Rent',
    amount: -90_000,
    recurrenceType: 'monthly',
    startDate: '2026-03-01',
  };
  const widest = await send('POST', '/schedules', {
    ...item,
    dateFlexibility: MAX_DATE_FLEXIBILITY,
  });
  expect(widest.status).toBe(201);
  const wider = await send('POST', '/schedules', {
    ...item,
    dateFlexibility: MAX_DATE_FLEXIBILITY + 1,
  });
  expect(wider.status).toBe(400);
});

it('after an item changes direction, its past occurrences are still suggested matches in theirs', async () => {
  const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');
  const { body: account } = await send('POST', '/accounts', { name: 'Checking', type: 'checking' });
  const { body: item } = await send('POST', '/schedules', {
    name: 'Gym',
    amount: -5_000,
    recurrenceType: 'weekly',
    startDate: day(-7),
    accountId: account.id,
  });
  db.insert(transactions)
    .values({ id: 'gym-paid', accountId: account.id, date: day(-7), amount: -5_000 })
    .run();

  // From now on it's a refund: future occurrences expect money in, last week's still money out
  await send('PUT', `/schedules/${item.id}`, { amount: 5_000 });

  const { body: suggestions } = await send('GET', '/schedules/match-suggestions');
  const lastWeek = suggestions.find(
    (s: { scheduleId: string; expectedAmount: number }) =>
      s.scheduleId === item.id && s.expectedAmount === -5_000,
  );
  expect(lastWeek?.candidates.map((c: { transactionId: string }) => c.transactionId)).toEqual([
    'gym-paid',
  ]);
});
