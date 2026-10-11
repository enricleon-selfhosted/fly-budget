import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import { accounts, categories, categoryGroups, exchangeRates, transactions } from '../db/schema.js';
import { ACCOUNT_TYPES, defaultOffBudget } from '../utils/accountTypes.js';
import {
  accountBalance,
  accountSummary,
  createAccount,
  openAccount,
  setBalanceTo,
  updateAccount,
} from './accountService.js';
import { saveBudgetSettings } from './fx/settings.js';

// Through the service's functions: what they return, and what ends up stored.

beforeAll(() => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
});

beforeEach(() => {
  db.delete(transactions).run();
  db.delete(accounts).run();
  saveBudgetSettings({ currency: 'EUR' });
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
  it('keeps no currency for the budget’s own, and starts accounts in another one off budget', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ACCOUNT_TYPES),
        fc.constantFrom(undefined, null, 'EUR', 'GBP', 'USD'),
        fc.constantFrom(undefined, 0 as const, 1 as const),
        (type, currency, isOffBudget) => {
          const account = createAccount({ name: 'Account', type, currency, isOffBudget });
          const foreign = currency === 'GBP' || currency === 'USD';
          expect(account.currency).toBe(foreign ? currency : null);
          expect(account.isOffBudget).toBe(isOffBudget ?? (foreign ? 1 : defaultOffBudget(type)));
          expect(stored(account.id)).toEqual(account);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('keeps the currency it is given while the budget has none yet', () => {
    saveBudgetSettings({ currency: null });
    expect(createAccount({ name: 'Euros', type: 'checking', currency: 'EUR' }).currency).toBe(
      'EUR',
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

describe('updateAccount', () => {
  it('keeps no currency when changed to the budget’s own', () => {
    const { id } = createAccount({ name: 'Pounds', type: 'savings', currency: 'GBP' });
    expect(updateAccount(id, { currency: 'EUR' })!.account.currency).toBeNull();
    expect(stored(id)!.currency).toBeNull();
    expect(updateAccount(id, { name: 'Savings' })!.account).toMatchObject({
      name: 'Savings',
      currency: null,
    });
  });

  it('is null for an account that doesn’t exist', () => {
    expect(updateAccount('missing', { name: 'X' })).toBeNull();
  });

  it('moving an account off budget uncategorizes the transfers that stop crossing the boundary', () => {
    db.insert(categoryGroups).values({ id: 'g', name: 'Bills' }).onConflictDoNothing().run();
    db.insert(categories)
      .values({ id: 'savings', groupId: 'g', name: 'Savings' })
      .onConflictDoNothing()
      .run();
    const checking = createAccount({ name: 'Checking', type: 'checking' });
    const brokerage = createAccount({ name: 'Brokerage', type: 'investment' });
    expect([checking.isOffBudget, brokerage.isOffBudget]).toEqual([0, 1]);
    // Money leaving the budget: the budget side has a category
    const out = addTransaction(checking.id, { amount: -5_000, categoryId: 'savings' });
    const into = addTransaction(brokerage.id, { amount: 5_000, transferTransactionId: out });
    db.update(transactions)
      .set({ transferTransactionId: into })
      .where(eq(transactions.id, out))
      .run();

    // Now both are off budget: the transfer no longer crosses
    const result = updateAccount(checking.id, { isOffBudget: 1 })!;

    expect(result).toMatchObject({ account: { isOffBudget: 1 }, transfersUncategorized: 1 });
    expect(stored(checking.id)!.isOffBudget).toBe(1);
    expect(db.select().from(transactions).where(eq(transactions.id, out)).get()!.categoryId).toBe(
      null,
    );
    // A change that keeps the budget status uncategorizes nothing
    expect(updateAccount(checking.id, { name: 'Joint' })!.transfersUncategorized).toBe(0);
  });

  it('converts the account’s transactions when its currency changes', () => {
    db.insert(exchangeRates)
      .values({
        id: 'GBPEUR:2026-01-01',
        date: '2026-01-01',
        base: 'GBP',
        quote: 'EUR',
        rate: 1.2,
        source: 'manual',
      })
      .onConflictDoNothing()
      .run();
    const { id } = createAccount({ name: 'Wallet', type: 'cash' });
    const tx = addTransaction(id, { date: '2026-03-01' });

    updateAccount(id, { currency: 'GBP' });

    expect(db.select().from(transactions).where(eq(transactions.id, tx)).get()).toMatchObject({
      fxRate: 1.2,
      fxSource: 'rate',
    });
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
