import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { accounts, transactions } from '../db/schema.js';
import { ACCOUNT_TYPES, defaultOffBudget } from '../utils/accountTypes.js';
import {
  accountBalance,
  accountSummary,
  createAccount,
  openAccount,
  setBalanceTo,
} from './accountService.js';

// Through the service's functions: what they return, and what ends up stored.

beforeAll(() => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
});

beforeEach(() => {
  db.delete(transactions).run();
  db.delete(accounts).run();
});

const stored = (id: string) => db.select().from(accounts).where(eq(accounts.id, id)).get();

let seq = 0;
function addTransaction(accountId: string, over: Partial<typeof transactions.$inferInsert> = {}) {
  const id = `t-${++seq}`;
  db.insert(transactions)
    .values({ id, accountId, date: '2026-03-01', amount: -1_000, ...over })
    .run();
  return id;
}

describe('createAccount', () => {
  it('keeps the currency it is given, and keeps accounts in another currency off budget', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ACCOUNT_TYPES),
        fc.constantFrom(undefined, null, 'GBP', 'USD'),
        fc.constantFrom(undefined, 0 as const, 1 as const),
        (type, currency, isOffBudget) => {
          const account = createAccount({ name: 'Account', type, currency, isOffBudget });
          expect(account.currency).toBe(currency ?? null);
          expect(account.isOffBudget).toBe(currency ? 1 : (isOffBudget ?? defaultOffBudget(type)));
          expect(stored(account.id)).toEqual(account);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('runs inside a caller’s transaction, and is undone with it', () => {
    let id = '';
    expect(() =>
      db.transaction(() => {
        id = createAccount({ name: 'Doomed', type: 'checking' }).id;
        throw new Error('the rest failed');
      }),
    ).toThrow('the rest failed');
    expect(stored(id)).toBeUndefined();
  });
});

describe('balances', () => {
  it('sets the starting balance so the balance is what was asked, split parts counted once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.array(fc.integer({ min: -1e6, max: 1e6 }), { maxLength: 6 }),
        fc.boolean(),
        (startingBalance, target, amounts, split) => {
          const { id } = createAccount({ name: 'Checking', type: 'checking', startingBalance });
          for (const amount of amounts) addTransaction(id, { amount });
          if (split) {
            const parent = addTransaction(id, { amount: -3_000, isParent: 1 });
            addTransaction(id, { amount: -1_000, parentTransactionId: parent });
            addTransaction(id, { amount: -2_000, parentTransactionId: parent });
          }
          const sum = amounts.reduce((a, b) => a + b, 0) + (split ? -3_000 : 0);
          expect(accountBalance(id)).toBe(startingBalance + sum);

          setBalanceTo(id, target);
          expect(accountBalance(id)).toBe(target);
          expect(stored(id)!.startingBalance).toBe(target - sum);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('finds an account’s name and balance closed or not; only open accounts are open', () => {
    const { id } = createAccount({ name: 'Old card', type: 'credit', startingBalance: -500 });
    addTransaction(id, { amount: -1_500 });
    expect(openAccount(id)).toEqual({ id, name: 'Old card' });
    db.update(accounts).set({ closedAt: '2026-03-02' }).where(eq(accounts.id, id)).run();
    expect(openAccount(id)).toBeNull();
    expect(accountSummary(id)).toEqual({ name: 'Old card', balance: -2_000 });

    expect(openAccount('missing')).toBeNull();
    expect(accountSummary('missing')).toBeNull();
    expect(accountBalance('missing')).toBeNull();
  });
});
