import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { transactions } from '../db/schema.js';
import { linkTransfer } from '../services/transactionHelpers.js';
import { accountsRouter } from './accounts.js';
import { transactionsRouter } from './transactions.js';

// Linking two existing transactions as a transfer (bank sync does it) and undoing it. Its own
// file, so the database holds only this test's data.

let server: Server;
let base: string;

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
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
