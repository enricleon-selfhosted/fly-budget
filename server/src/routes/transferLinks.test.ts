import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { categories, categoryGroups, transactions } from '../db/schema.js';
import { linkTransfer } from '../services/transactionHelpers.js';
import { accountsRouter } from './accounts.js';
import { transactionsRouter } from './transactions.js';

// Linking two existing transactions as a transfer (bank sync does it) and undoing it. Its own
// file, so the database holds only this test's data.

let server: Server;
let base: string;

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  db.insert(categoryGroups).values({ id: 'g-income', name: 'Income', isIncome: 1 }).run();
  db.insert(categories).values({ id: 'c-salary', groupId: 'g-income', name: 'Salary' }).run();
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
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
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const row = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;

async function twoAccounts() {
  const { body: checking } = await send('POST', '/accounts', {
    name: 'Checking',
    type: 'checking',
  });
  const { body: savings } = await send('POST', '/accounts', { name: 'Savings', type: 'savings' });
  return { checking, savings };
}

function imported(accountId: string, amount: number, payee: string) {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  db.insert(transactions)
    .values({
      id,
      accountId,
      date: '2096-03-10',
      amount,
      payeeName: payee,
      importedPayee: payee,
      importedId: `test:${id}`,
    })
    .run();
  return id;
}

describe('linkTransfer', () => {
  it('makes two opposite transactions look like a transfer made in the app', async () => {
    const { checking, savings } = await twoAccounts();
    const out = imported(checking.id, -10_000, 'TRASPASO A AHORRO');
    const into = imported(savings.id, 10_000, 'TRASPASO DESDE CUENTA');

    expect(linkTransfer(out, into)).toEqual({ ok: true });
    expect(row(out)).toMatchObject({
      transferTransactionId: into,
      payeeName: 'Transfer: Savings',
      payeeId: null,
      categoryId: null,
    });
    expect(row(into)).toMatchObject({
      transferTransactionId: out,
      payeeName: 'Transfer: Checking',
    });
    // The bank's text stays for rules and for undoing
    expect(row(out).importedPayee).toBe('TRASPASO A AHORRO');
  });

  it('refuses pairs that are not two sides of one movement', async () => {
    const { checking, savings } = await twoAccounts();
    const a = imported(checking.id, -500, 'A');
    expect(linkTransfer(a, imported(savings.id, 400, 'B'))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(linkTransfer(a, imported(checking.id, 500, 'C'))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(linkTransfer(a, 'missing')).toMatchObject({ ok: false, status: 404 });

    const reconciled = imported(savings.id, 500, 'D');
    db.update(transactions).set({ reconciled: 1 }).where(eq(transactions.id, reconciled)).run();
    expect(linkTransfer(a, reconciled)).toMatchObject({ ok: false, status: 403 });
    // Nothing changed on the first one
    expect(row(a).transferTransactionId).toBeNull();
  });

  it('never re-links a side that is already a transfer', async () => {
    const { checking, savings } = await twoAccounts();
    const a = imported(checking.id, -700, 'A');
    const b = imported(savings.id, 700, 'B');
    linkTransfer(a, b);
    const c = imported(savings.id, 700, 'C');
    expect(linkTransfer(a, c)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('POST /transactions/:id/unlink-transfer', () => {
  it('turns a linked pair back into two transactions named after the bank text', async () => {
    const { checking, savings } = await twoAccounts();
    const out = imported(checking.id, -2_500, 'BIZUM ANA');
    const into = imported(savings.id, 2_500, 'BIZUM RECIBIDO');
    linkTransfer(out, into);

    const { status, body } = await send('POST', `/transactions/${out}/unlink-transfer`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: out, transferTransactionId: null, payeeName: 'BIZUM ANA' });
    expect(body.payeeId).toEqual(expect.any(String));
    expect(row(into)).toMatchObject({ transferTransactionId: null, payeeName: 'BIZUM RECIBIDO' });
  });

  it('unlinks a transfer made in the app, leaving both sides without a payee', async () => {
    const { checking, savings } = await twoAccounts();
    const { body: pair } = await send('POST', '/transactions/transfer', {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2096-03-11',
      amount: 1_000,
    });
    const { body } = await send('POST', `/transactions/${pair[0].id}/unlink-transfer`);
    expect(body).toMatchObject({ transferTransactionId: null, payeeName: null, payeeId: null });
    expect(row(pair[1].id).transferTransactionId).toBeNull();
  });

  it('answers 400 for an ordinary transaction and 403 when a side is reconciled', async () => {
    const { checking, savings } = await twoAccounts();
    const plain = imported(checking.id, -100, 'X');
    expect((await send('POST', `/transactions/${plain}/unlink-transfer`)).status).toBe(400);

    const a = imported(checking.id, -300, 'A');
    const b = imported(savings.id, 300, 'B');
    linkTransfer(a, b);
    db.update(transactions).set({ reconciled: 1 }).where(eq(transactions.id, b)).run();
    expect((await send('POST', `/transactions/${a}/unlink-transfer`)).status).toBe(403);
    expect(row(a).transferTransactionId).toBe(b);
  });
});

describe('exchanges and transfers across the budget boundary', () => {
  async function gbpAndEur() {
    const { body: gbp } = await send('POST', '/accounts', {
      name: 'GBP pocket',
      type: 'checking',
      currency: 'GBP',
    });
    const { body: eur } = await send('POST', '/accounts', { name: 'EUR pocket', type: 'checking' });
    return { gbp, eur };
  }

  it('an exchange needs the amount received, and keeps a different amount on each side', async () => {
    const { gbp, eur } = await gbpAndEur();
    const missing = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2096-03-12',
      amount: 50_000,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/amount received/);

    const { status, body: pair } = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2096-03-12',
      amount: 50_000,
      toAmount: 58_025,
    });
    expect(status).toBe(201);
    expect(pair.map((t: { amount: number }) => t.amount)).toEqual([-50_000, 58_025]);
  });

  it('editing one side of an exchange moves the date but not the other amount', async () => {
    const { gbp, eur } = await gbpAndEur();
    const { body: pair } = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2096-03-12',
      amount: 10_000,
      toAmount: 11_600,
    });
    await send('PUT', `/transactions/${pair[1].id}`, { amount: 11_650, date: '2096-03-13' });
    expect(row(pair[0].id)).toMatchObject({ amount: -10_000, date: '2096-03-13' });
    expect(row(pair[1].id)).toMatchObject({ amount: 11_650 });

    const flipped = await send('PUT', `/transactions/${pair[1].id}`, { amount: -11_650 });
    expect(flipped.status).toBe(400);
  });

  it('the budget side of money coming from an off-budget account can be income', async () => {
    const { gbp, eur } = await gbpAndEur();
    const { body: pair } = await send('POST', '/transactions/transfer', {
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2096-03-12',
      amount: 10_000,
      toAmount: 11_600,
      categoryId: null,
    });
    // The GBP side is off budget: no category there
    const offSide = await send('PUT', `/transactions/${pair[0].id}`, { categoryId: 'c-salary' });
    expect(offSide.status).toBe(400);
    const onSide = await send('PUT', `/transactions/${pair[1].id}`, { categoryId: 'c-salary' });
    expect(onSide.status).toBe(200);
    expect(row(pair[1].id).categoryId).toBe('c-salary');
  });

  it('a transfer between two budget accounts never takes a category', async () => {
    const { checking, savings } = await twoAccounts();
    const { body: pair } = await send('POST', '/transactions/transfer', {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2096-03-12',
      amount: 1_000,
    });
    expect(
      (await send('PUT', `/transactions/${pair[1].id}`, { categoryId: 'c-salary' })).status,
    ).toBe(400);
    const created = await send('POST', '/transactions/transfer', {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2096-03-12',
      amount: 1_000,
      categoryId: 'c-salary',
    });
    expect(created.status).toBe(400);
  });

  it('links an exchange by hand, keeping the income category on the budget side', async () => {
    const { gbp, eur } = await gbpAndEur();
    const out = imported(gbp.id, -20_000, 'Exchanged to EUR');
    const into = imported(eur.id, 23_210, 'Exchanged from GBP');
    db.update(transactions).set({ categoryId: 'c-salary' }).where(eq(transactions.id, into)).run();

    const { status } = await send('POST', `/transactions/${out}/link-transfer`, { otherId: into });
    expect(status).toBe(200);
    expect(row(out)).toMatchObject({
      transferTransactionId: into,
      categoryId: null,
      amount: -20_000,
    });
    expect(row(into)).toMatchObject({
      transferTransactionId: out,
      categoryId: 'c-salary',
      amount: 23_210,
    });

    // Two money-out transactions are not a transfer
    const a = imported(gbp.id, -100, 'A');
    const b = imported(eur.id, -100, 'B');
    expect((await send('POST', `/transactions/${a}/link-transfer`, { otherId: b })).status).toBe(
      400,
    );
  });
});
