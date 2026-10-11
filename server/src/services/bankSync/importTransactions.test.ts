import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq, like } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../../db/index.js';
import { accounts, categories, categoryGroups, rules, transactions } from '../../db/schema.js';
import { createSqliteImportStore, type ImportStore } from './importStore.js';
import { importTransactions } from './importTransactions.js';
import type { RemoteTransaction } from './types.js';

// Through the public function only: remote transactions in, rows in the database out.

beforeAll(() => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
});

beforeEach(() => {
  db.delete(transactions).run();
  db.delete(accounts).run();
  db.delete(rules).run();
});

let seq = 0;
function account(name: string, currency: string | null = null) {
  const id = `acct-${++seq}`;
  db.insert(accounts).values({ id, name, type: 'checking', currency }).run();
  return id;
}

const target = (accountId: string, currency = 'EUR') => ({
  accountId,
  importedIdPrefix: `test:${accountId}:`,
  currency,
});

function remote(over: Partial<RemoteTransaction> = {}): RemoteTransaction {
  return {
    externalId: `x-${++seq}`,
    date: '2026-03-10',
    amount: -1234,
    currency: 'EUR',
    payeeName: 'Mercadona',
    importedPayee: 'COMPRA MERCADONA 1234',
    notes: null,
    counterpartyAccountHash: null,
    ...over,
  };
}

const rowsOf = (accountId: string) =>
  db.select().from(transactions).where(eq(transactions.accountId, accountId)).all();

function typedIn(accountId: string, over: Partial<typeof transactions.$inferInsert> = {}) {
  const id = `manual-${++seq}`;
  db.insert(transactions)
    .values({ id, accountId, date: '2026-03-08', amount: -1234, payeeName: 'Groceries', ...over })
    .run();
  return id;
}

describe('adding', () => {
  it('adds new transactions with their payee, bank text and imported id, and applies rules', () => {
    db.insert(categoryGroups).values({ id: 'g', name: 'Everyday' }).onConflictDoNothing().run();
    db.insert(categories)
      .values({ id: 'food', groupId: 'g', name: 'Food' })
      .onConflictDoNothing()
      .run();
    db.insert(rules)
      .values({
        id: 'r1',
        conditions: JSON.stringify([
          { field: 'imported_payee', op: 'contains', value: 'mercadona' },
        ]),
        actions: JSON.stringify([{ type: 'set_category', value: 'food' }]),
      })
      .run();
    const a = account('Checking');

    const result = importTransactions(target(a), [
      remote({ externalId: 'e1', notes: 'Card 1234' }),
    ]);

    expect(result).toEqual({ added: 1, matched: 0, transfers: 0, duplicates: 0, otherCurrency: 0 });
    expect(rowsOf(a)).toMatchObject([
      {
        amount: -1234,
        date: '2026-03-10',
        payeeName: 'Mercadona',
        importedPayee: 'COMPRA MERCADONA 1234',
        notes: 'Card 1234',
        importedId: `test:${a}:e1`,
        categoryId: 'food',
      },
    ]);
  });

  it('never imports the same transaction twice, whatever the batches look like', () => {
    const tx = fc.record({
      externalId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      offset: fc.integer({ min: 0, max: 40 }),
      amount: fc.integer({ min: -50_000, max: 50_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(tx, { maxLength: 15 }),
        fc.array(tx, { maxLength: 15 }),
        (first, second) => {
          db.delete(transactions).run();
          const a = account('Checking');
          const toRemote = (t: (typeof first)[number]) =>
            remote({
              externalId: t.externalId,
              amount: t.amount,
              date: new Date(Date.UTC(2026, 0, 1 + t.offset)).toISOString().slice(0, 10),
            });

          importTransactions(target(a), first.map(toRemote));
          const again = importTransactions(target(a), first.map(toRemote));
          expect(again.added + again.matched).toBe(0);
          importTransactions(target(a), second.map(toRemote));

          const ids = rowsOf(a).map((r) => r.importedId);
          expect(new Set(ids).size).toBe(ids.length);
          expect(new Set(ids)).toEqual(
            new Set([...first, ...second].map((t) => `test:${a}:${t.externalId}`)),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it('imports a batch whole or not at all', () => {
    const a = account('Checking');
    const real = createSqliteImportStore();
    let inserts = 0;
    const failing: ImportStore = {
      ...real,
      insert(input) {
        if (++inserts === 2) throw new Error('disk full');
        return real.insert(input);
      },
    };
    expect(() => importTransactions(target(a), [remote(), remote()], { store: failing })).toThrow(
      'disk full',
    );
    // Nothing half-imported that the next sync would skip as a duplicate
    expect(rowsOf(a)).toHaveLength(0);
    expect(importTransactions(target(a), [remote(), remote()]).added).toBe(2);
  });

  it('skips transactions in another currency than the account', () => {
    const a = account('Checking');
    const result = importTransactions(target(a), [remote({ currency: 'USD' }), remote()]);
    expect(result).toMatchObject({ added: 1, otherCurrency: 1 });
  });
});

describe('matching what the user typed in', () => {
  it('merges into a typed-in transaction of the same amount within 10 days, keeping what the user entered', () => {
    const a = account('Checking');
    const manual = typedIn(a, { date: '2026-03-01', categoryId: null, notes: 'weekly shop' });

    const result = importTransactions(target(a), [
      remote({ externalId: 'e9', date: '2026-03-11' }),
    ]);

    expect(result).toMatchObject({ added: 0, matched: 1 });
    expect(rowsOf(a)).toMatchObject([
      {
        id: manual,
        date: '2026-03-01',
        payeeName: 'Groceries',
        notes: 'weekly shop',
        importedId: `test:${a}:e9`,
        importedPayee: 'COMPRA MERCADONA 1234',
      },
    ]);
  });

  it('adds instead when the amount differs or the dates are too far apart', () => {
    const a = account('Checking');
    typedIn(a, { date: '2026-03-01', amount: -1234 });
    typedIn(a, { date: '2026-03-10', amount: -1235 });
    const result = importTransactions(target(a), [remote({ date: '2026-03-12' })]);
    expect(result).toMatchObject({ added: 1, matched: 0 });
  });

  it('merges each typed-in transaction at most once, closest dates first', () => {
    const a = account('Checking');
    const early = typedIn(a, { date: '2026-03-02' });
    const late = typedIn(a, { date: '2026-03-09' });
    const result = importTransactions(target(a), [
      remote({ externalId: 'p', date: '2026-03-03' }),
      remote({ externalId: 'q', date: '2026-03-10' }),
      remote({ externalId: 'r', date: '2026-03-10' }),
    ]);
    expect(result).toMatchObject({ matched: 2, added: 1 });
    const byId = new Map(rowsOf(a).map((r) => [r.id, r]));
    expect(byId.get(early)!.importedId).toBe(`test:${a}:p`);
    expect(byId.get(late)!.importedId).toBe(`test:${a}:q`);
  });

  it('never merges into reconciled, imported or split-part rows', () => {
    const a = account('Checking');
    typedIn(a, { reconciled: 1 });
    typedIn(a, { importedId: 'csv-row' });
    const parent = typedIn(a, { amount: -5000, isParent: 1 });
    typedIn(a, { parentTransactionId: parent });
    const result = importTransactions(target(a), [remote()]);
    expect(result).toMatchObject({ added: 1, matched: 0 });
  });

  it('merges into a transfer the user entered by hand (YNAB style)', () => {
    const a = account('Checking');
    const b = account('Savings');
    const out = typedIn(a, {
      amount: -10_000,
      payeeName: 'Transfer: Savings',
      transferTransactionId: 'x',
    });
    const into = typedIn(b, {
      amount: 10_000,
      payeeName: 'Transfer: Checking',
      transferTransactionId: out,
    });
    db.update(transactions)
      .set({ transferTransactionId: into })
      .where(eq(transactions.id, out))
      .run();

    importTransactions(target(a), [remote({ externalId: 'o', amount: -10_000 })]);
    importTransactions(target(b), [remote({ externalId: 'i', amount: 10_000 })]);

    expect(rowsOf(a)).toMatchObject([
      { id: out, importedId: `test:${a}:o`, transferTransactionId: into },
    ]);
    expect(rowsOf(b)).toMatchObject([
      { id: into, importedId: `test:${b}:i`, transferTransactionId: out },
    ]);
  });
});

describe('transfers between the user’s accounts', () => {
  it('links the second side when it arrives, whichever account syncs first', () => {
    const a = account('Checking');
    const b = account('Savings');
    const first = importTransactions(target(a), [remote({ amount: -10_000, date: '2026-03-10' })]);
    const second = importTransactions(target(b), [remote({ amount: 10_000, date: '2026-03-12' })]);

    expect(first.transfers).toBe(0);
    expect(second.transfers).toBe(1);
    const [out] = rowsOf(a);
    const [into] = rowsOf(b);
    expect(out).toMatchObject({
      transferTransactionId: into.id,
      payeeName: 'Transfer: Savings',
      categoryId: null,
    });
    expect(into).toMatchObject({ transferTransactionId: out.id, payeeName: 'Transfer: Checking' });
  });

  it('leaves ambiguous pairs alone', () => {
    const a = account('Checking');
    const b = account('Savings');
    const c = account('Joint');
    importTransactions(target(a), [remote({ amount: -2_000 })]);
    importTransactions(target(c), [remote({ amount: -2_000, date: '2026-03-11' })]);
    // Two possible other sides
    expect(importTransactions(target(b), [remote({ amount: 2_000 })]).transfers).toBe(0);

    const d = account('Cash');
    const e = account('Card');
    importTransactions(target(d), [remote({ amount: -3_000 })]);
    // Two transactions of the amount in the arriving batch: which one is the transfer?
    const result = importTransactions(target(e), [
      remote({ externalId: 'e-1', amount: 3_000 }),
      remote({ externalId: 'e-2', amount: 3_000, date: '2026-03-11' }),
    ]);
    expect(result.transfers).toBe(0);
  });

  it('follows the IBAN the bank names, even when another account has a candidate too', () => {
    const a = account('Checking');
    const b = account('Savings');
    const c = account('Joint');
    importTransactions(target(b), [remote({ externalId: 'b1', amount: 5_000 })]);
    importTransactions(target(c), [remote({ externalId: 'c1', amount: 5_000 })]);

    const result = importTransactions(
      target(a),
      [remote({ amount: -5_000, counterpartyAccountHash: 'hash-of-savings-iban' })],
      { ownAccountsByIbanHash: new Map([['hash-of-savings-iban', b]]) },
    );

    expect(result.transfers).toBe(1);
    expect(rowsOf(a)[0].transferTransactionId).toBe(rowsOf(b)[0].id);
    expect(rowsOf(c)[0].transferTransactionId).toBeNull();
  });

  it('never pairs accounts in different currencies, or with typed-in or closed-account rows', () => {
    const eur = account('Checking');
    const usd = account('USD pocket', 'USD');
    importTransactions(target(usd, 'USD'), [remote({ currency: 'USD', amount: 7_000 })]);
    expect(importTransactions(target(eur), [remote({ amount: -7_000 })]).transfers).toBe(0);

    const a = account('Wallet');
    typedIn(a, { amount: 8_000, date: '2026-03-10' });
    const b = account('Main');
    expect(importTransactions(target(b), [remote({ amount: -8_000 })]).transfers).toBe(0);

    const closed = account('Old');
    importTransactions(target(closed), [remote({ amount: 9_000 })]);
    db.update(accounts).set({ closedAt: '2026-03-11' }).where(eq(accounts.id, closed)).run();
    const open = account('New');
    expect(importTransactions(target(open), [remote({ amount: -9_000 })]).transfers).toBe(0);
  });

  it('never links an account in another currency as a transfer, even when the bank names it', () => {
    const eur = account('Checking');
    const gbp = account('GBP pocket', 'GBP');
    importTransactions(target(gbp, 'GBP'), [remote({ currency: 'GBP', amount: 6_000 })]);

    const result = importTransactions(
      target(eur),
      [remote({ amount: -6_000, counterpartyAccountHash: 'hash-of-gbp-iban' })],
      { ownAccountsByIbanHash: new Map([['hash-of-gbp-iban', gbp]]) },
    );

    expect(result.transfers).toBe(0);
    expect(rowsOf(eur)[0].transferTransactionId).toBeNull();
    expect(rowsOf(gbp)[0].transferTransactionId).toBeNull();
  });

  it('does not pair across more than 4 days', () => {
    const a = account('Checking');
    const b = account('Savings');
    importTransactions(target(a), [remote({ amount: -4_000, date: '2026-03-01' })]);
    expect(
      importTransactions(target(b), [remote({ amount: 4_000, date: '2026-03-06' })]).transfers,
    ).toBe(0);
  });

  it('keeps each imported id once even after linking', () => {
    const a = account('Checking');
    const b = account('Savings');
    importTransactions(target(a), [remote({ externalId: 's', amount: -600 })]);
    importTransactions(target(b), [remote({ externalId: 't', amount: 600 })]);
    importTransactions(target(b), [remote({ externalId: 't', amount: 600 })]);
    expect(
      db.select().from(transactions).where(like(transactions.importedId, 'test:%')).all(),
    ).toHaveLength(2);
  });
});
