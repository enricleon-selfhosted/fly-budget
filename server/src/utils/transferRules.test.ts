import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_TRANSFER_CANDIDATES,
  linkableProblem,
  mirrorsAmount,
  rankTransferCandidates,
  sideTakesCategory,
  transferPairProblem,
  type LinkCandidate,
  type LinkableRow,
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

// What decides whether a row can be linked: any mix of the flags a stored row can have
const linkable: fc.Arbitrary<LinkableRow> = fc.record({
  transferTransactionId: fc.constantFrom(null, 'other'),
  isParent: fc.constantFrom(0, 1),
  parentTransactionId: fc.constantFrom(null, 'parent'),
  isAdjustment: fc.constantFrom(0, 1),
  reconciled: fc.constantFrom(0, 1),
});

describe('linkableProblem', () => {
  it('only plain, unreconciled transactions can be linked; not being plain is said first', () => {
    fc.assert(
      fc.property(linkable, (t) => {
        const plain =
          !t.transferTransactionId && !t.isParent && !t.parentTransactionId && !t.isAdjustment;
        const problem = linkableProblem(t);
        if (!plain) expect(problem?.reason).toBe('not_plain');
        else if (t.reconciled) expect(problem?.reason).toBe('reconciled');
        else expect(problem).toBeNull();
      }),
    );
  });
});

describe('rankTransferCandidates', () => {
  const day = (offset: number) =>
    new Date(Date.UTC(2096, 2, 10) + offset * 864e5).toISOString().slice(0, 10);
  const plain: LinkableRow = {
    transferTransactionId: null,
    isParent: 0,
    parentTransactionId: null,
    isAdjustment: 0,
    reconciled: 0,
  };
  const candidate = fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    offset: fc.integer({ min: -7, max: 7 }),
    amount,
    account,
    flags: fc.oneof(fc.constant(plain), linkable),
  });
  const toCandidate = (c: {
    id: string;
    offset: number;
    amount: number;
    account: TransferAccount;
    flags: LinkableRow;
  }): LinkCandidate => ({
    ...c.flags,
    id: c.id,
    date: day(c.offset),
    amount: c.amount,
    account: c.account,
  });
  const distance = (c: LinkCandidate) => Math.abs(Date.parse(c.date) - Date.parse(day(0)));

  it('offers the closest linkable transactions that make a valid pair, at most the maximum', () => {
    fc.assert(
      fc.property(
        fc.record({ amount, account, flags: fc.oneof(fc.constant(plain), linkable) }),
        fc.array(candidate, { maxLength: 30 }),
        (src, raw) => {
          const source = toCandidate({ ...src, id: 'source', offset: 0 });
          const nearby = raw.map(toCandidate);
          const offered = rankTransferCandidates(source, nearby);
          const valid = nearby.filter(
            (c) => !linkableProblem(c) && transferPairProblem(source, c) === null,
          );
          if (linkableProblem(source)) {
            expect(offered).toEqual([]);
            return;
          }
          expect(offered.length).toBe(Math.min(valid.length, MAX_TRANSFER_CANDIDATES));
          for (const c of offered) expect(valid).toContain(c);
          // Closest first, and nothing left out is closer than what's offered
          for (let i = 1; i < offered.length; i++)
            expect(distance(offered[i])).toBeGreaterThanOrEqual(distance(offered[i - 1]));
          const last = offered[offered.length - 1];
          for (const c of valid.filter((v) => !offered.includes(v)))
            expect(distance(c)).toBeGreaterThanOrEqual(distance(last));
        },
      ),
    );
  });
});
