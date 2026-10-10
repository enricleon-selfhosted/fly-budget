import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  mirrorsAmount,
  sideTakesCategory,
  transferPairProblem,
  type TransferAccount,
} from './transferRules.js';

const account = fc.record({
  id: fc.constantFrom('a', 'b', 'c'),
  currency: fc.constantFrom(null, 'GBP', 'USD'),
  isOffBudget: fc.constantFrom(0, 1),
});
const amount = fc.integer({ min: -100_000, max: 100_000 });

describe('transferPairProblem', () => {
  it('accepts exactly: two accounts, opposite directions, and one amount within one currency', () => {
    fc.assert(
      fc.property(account, amount, account, amount, (accA, a, accB, b) => {
        const ok =
          accA.id !== accB.id &&
          a !== 0 &&
          b !== 0 &&
          Math.sign(a) === -Math.sign(b) &&
          (accA.currency !== accB.currency || a === -b);
        const problem = transferPairProblem(
          { amount: a, account: accA },
          { amount: b, account: accB },
        );
        expect(problem === null).toBe(ok);
      }),
    );
  });

  it('lets an exchange keep a different amount on each side', () => {
    const gbp: TransferAccount = { id: 'gbp', currency: 'GBP', isOffBudget: 1 };
    const eur: TransferAccount = { id: 'eur', currency: null, isOffBudget: 0 };
    expect(
      transferPairProblem({ amount: -50_000, account: gbp }, { amount: 58_025, account: eur }),
    ).toBeNull();
    expect(
      transferPairProblem({ amount: -50_000, account: gbp }, { amount: -58_025, account: eur }),
    ).not.toBeNull();
  });
});

describe('sideTakesCategory', () => {
  it('only the on-budget side of a transfer with an off-budget account', () => {
    fc.assert(
      fc.property(account, account, (self, other) => {
        expect(sideTakesCategory(self, other)).toBe(
          self.isOffBudget === 0 && other.isOffBudget === 1,
        );
        // Never both sides
        expect(sideTakesCategory(self, other) && sideTakesCategory(other, self)).toBe(false);
      }),
    );
  });
});

describe('mirrorsAmount', () => {
  it('only within one currency', () => {
    fc.assert(
      fc.property(account, account, (a, b) => {
        expect(mirrorsAmount(a, b)).toBe(a.currency === b.currency);
      }),
    );
  });
});
