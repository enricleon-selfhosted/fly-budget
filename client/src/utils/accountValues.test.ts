import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  accountsWithoutRate,
  changeInBudget,
  totalInBudget,
  valueAgoInBudget,
  valueInBudget,
} from './accountValues';
import type { Account } from '../types';

const cents = fc.integer({ min: -100_000_000, max: 100_000_000 });

// An account in the budget's currency (currency null) or in another one, with or without a rate
const account = fc
  .record({
    balance: cents,
    currency: fc.constantFrom<string | null>(null, 'CHF', 'USD', 'GBP'),
    budgetBalance: fc.oneof(fc.constant(null), fc.constant(undefined), cents),
  })
  .map((a): Pick<Account, 'balance' | 'currency' | 'budgetBalance'> => a);

// Accounts with distinct ids, as the server gives them
const accounts = fc
  .array(account, { maxLength: 12 })
  .map((list) => list.map((a, i) => ({ ...a, id: `acc-${i}` })));

describe('valueInBudget (property-based)', () => {
  it('an account in the budget currency is worth its balance, whatever a rate says', () => {
    fc.assert(
      fc.property(account, (a) => {
        if (a.currency !== null) return;
        expect(valueInBudget(a)).toBe(a.balance);
      }),
    );
  });

  it('an account in another currency is worth its balance at the rate, or nothing without one', () => {
    fc.assert(
      fc.property(account, (a) => {
        if (a.currency === null) return;
        const expected = typeof a.budgetBalance === 'number' ? a.budgetBalance : null;
        expect(valueInBudget(a)).toBe(expected);
      }),
    );
  });
});

describe('totalInBudget (property-based)', () => {
  it('is the sum of the accounts that have a value', () => {
    fc.assert(
      fc.property(accounts, (list) => {
        const expected = list.reduce((sum, a) => sum + (valueInBudget(a) ?? 0), 0);
        expect(totalInBudget(list)).toBe(expected);
      }),
    );
  });

  it('an account in another currency with no rate changes nothing', () => {
    fc.assert(
      fc.property(accounts, fc.integer({ min: -100_000, max: 100_000 }), (list, balance) => {
        const noRate = { id: 'no-rate', balance, currency: 'CHF', budgetBalance: null };
        expect(totalInBudget([...list, noRate])).toBe(totalInBudget(list));
      }),
    );
  });

  it('does not depend on the order of the accounts', () => {
    fc.assert(
      fc.property(accounts, (list) => {
        expect(totalInBudget([...list].reverse())).toBe(totalInBudget(list));
      }),
    );
  });

  it('a foreign account adds its rate-converted value, never its own balance', () => {
    fc.assert(
      fc.property(cents, cents, (balance, budgetBalance) => {
        const foreign = { balance, currency: 'CHF', budgetBalance };
        expect(totalInBudget([foreign])).toBe(budgetBalance);
      }),
    );
  });
});

describe('valueAgoInBudget (property-based)', () => {
  it('an account in the budget currency is worth the balance it had', () => {
    fc.assert(
      fc.property(account, cents, (a, agoBalance) => {
        if (a.currency !== null) return;
        expect(valueAgoInBudget(a, agoBalance)).toBe(agoBalance);
      }),
    );
  });

  it('a balance that did not move is worth what it is now', () => {
    fc.assert(
      fc.property(account, (a) => {
        if (a.currency === null) return;
        const now = valueInBudget(a);
        const ago = valueAgoInBudget(a, a.balance);
        if (a.balance === 0) expect(ago).toBeNull();
        else expect(ago).toBe(now);
      }),
    );
  });

  it('is null without a rate, or without a balance now to take the rate from', () => {
    fc.assert(
      fc.property(account, cents, (a, agoBalance) => {
        if (a.currency === null) return;
        const cannot = valueInBudget(a) === null || a.balance === 0;
        expect(valueAgoInBudget(a, agoBalance) === null).toBe(cannot);
      }),
    );
  });

  it('converts at the rate now: within half a cent of the balance times the rate', () => {
    fc.assert(
      fc.property(cents, cents, cents, (balance, budgetBalance, agoBalance) => {
        fc.pre(balance !== 0);
        const result = valueAgoInBudget({ balance, currency: 'USD', budgetBalance }, agoBalance);
        expect(result).not.toBeNull();
        expect(Math.abs(result! - (agoBalance * budgetBalance) / balance)).toBeLessThanOrEqual(0.5);
      }),
    );
  });

  it('example: 90.00 then at a rate that gives 118.00 now is worth 106.20 then', () => {
    const chf = { balance: 10_000, currency: 'CHF', budgetBalance: 11_800 };
    expect(valueAgoInBudget(chf, 9_000)).toBe(10_620);
  });
});

describe('changeInBudget (property-based)', () => {
  it('no change when every balance is what it was', () => {
    fc.assert(
      fc.property(accounts, (list) => {
        const balancesAgo = Object.fromEntries(list.map((a) => [a.id, a.balance]));
        expect(changeInBudget(list, balancesAgo).change).toBe(0);
      }),
    );
  });

  it('a rate movement alone is not a change: balances that held still show nothing', () => {
    fc.assert(
      fc.property(account, cents, (a, otherRate) => {
        if (a.currency === null) return;
        const moved = { ...a, id: 'x', budgetBalance: otherRate };
        const balancesAgo = { x: a.balance };
        expect(changeInBudget([moved], balancesAgo).change).toBe(0);
      }),
    );
  });

  it('for accounts in the budget currency, it is the balance change', () => {
    fc.assert(
      fc.property(accounts, (list) => {
        const local = list
          .filter((a) => a.currency === null)
          .map((a, i) => ({ ...a, id: `local-${i}` }));
        // Each balance moved by its own step, so the sums can't cancel out by accident
        const steps = local.map((_, i) => i + 1);
        const balancesAgo = Object.fromEntries(local.map((a, i) => [a.id, a.balance - steps[i]]));
        const change = steps.reduce((sum, step) => sum + step, 0);
        const base = local.reduce((sum, a, i) => sum + a.balance - steps[i], 0);
        expect(changeInBudget(local, balancesAgo)).toEqual({ change, base });
      }),
    );
  });

  it('an account in another currency with no rate is left out of the change and its base', () => {
    fc.assert(
      fc.property(accounts, cents, (list, agoBalance) => {
        const noRate = { id: 'no-rate', balance: 100, currency: 'CHF', budgetBalance: null };
        const before = changeInBudget(list, { 'no-rate': agoBalance });
        const after = changeInBudget([...list, noRate], { 'no-rate': agoBalance });
        expect(after).toEqual(before);
      }),
    );
  });
});

describe('accountsWithoutRate (property-based)', () => {
  it('returns exactly the accounts in another currency that have no rate', () => {
    fc.assert(
      fc.property(accounts, (list) => {
        const missing = accountsWithoutRate(list);
        const expected = list.filter((a) => a.currency !== null && valueInBudget(a) === null);
        expect(missing).toEqual(expected);
        // Every account is either counted in the total or listed here
        const valued = list.length - missing.length;
        expect(valued).toBe(list.filter((a) => valueInBudget(a) !== null).length);
      }),
    );
  });
});
