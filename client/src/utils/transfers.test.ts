import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CURRENCY_CODES } from './budgetCurrency';
import { rateText } from './currencyRates';
import {
  budgetSideHint,
  budgetSideTakesCategory,
  canLinkAsTransfer,
  crossesBudgetBoundary,
  exchangeLabel,
  exchangeRate,
  isExchange,
  transferRequest,
} from './transfers';

const arbCurrency = fc.option(fc.constantFrom(...CURRENCY_CODES), { nil: null });
const arbAccount = fc.record({ currency: arbCurrency, isOffBudget: fc.constantFrom(0, 1) });
const arbCents = fc.integer({ min: 1, max: 10_000_000_000 });
const arbSignedCents = fc.oneof(
  arbCents,
  arbCents.map((c) => -c),
);

describe('isExchange (property-based)', () => {
  it('is symmetric and never true for an account with itself', () => {
    fc.assert(
      fc.property(arbAccount, arbAccount, (a, b) => {
        expect(isExchange(a, b)).toBe(isExchange(b, a));
        expect(isExchange(a, a)).toBe(false);
      }),
    );
  });

  it('is true exactly when the currencies differ, with null meaning the budget currency', () => {
    fc.assert(
      fc.property(arbCurrency, arbCurrency, (x, y) => {
        expect(isExchange({ currency: x }, { currency: y })).toBe(x !== y);
      }),
    );
  });

  it('treats an absent currency (undefined) like null', () => {
    expect(isExchange({ currency: null }, { currency: undefined as unknown as null })).toBe(false);
  });
});

describe('budget boundary (property-based)', () => {
  it('a category side is the on-budget account when the other one is off budget', () => {
    fc.assert(
      fc.property(arbAccount, arbAccount, (self, other) => {
        expect(budgetSideTakesCategory(self, other)).toBe(
          self.isOffBudget === 0 && other.isOffBudget === 1,
        );
      }),
    );
  });

  it('crosses the boundary exactly when one account is off budget and the other is not', () => {
    fc.assert(
      fc.property(arbAccount, arbAccount, (a, b) => {
        expect(crossesBudgetBoundary(a, b)).toBe(a.isOffBudget !== b.isOffBudget);
        expect(crossesBudgetBoundary(a, b)).toBe(crossesBudgetBoundary(b, a));
      }),
    );
  });

  it('only one side of a boundary transfer can take a category', () => {
    fc.assert(
      fc.property(arbAccount, arbAccount, (a, b) => {
        expect(budgetSideTakesCategory(a, b) && budgetSideTakesCategory(b, a)).toBe(false);
      }),
    );
  });

  it('explains the category by the direction of the money', () => {
    expect(budgetSideHint(true)).toMatch(/income/);
    expect(budgetSideHint(false)).toMatch(/spending/);
  });
});

describe('exchangeRate (property-based)', () => {
  it('is null when either amount is zero', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        expect(exchangeRate(0, cents)).toBeNull();
        expect(exchangeRate(cents, 0)).toBeNull();
      }),
    );
  });

  it('is |to| / |from|, however small', () => {
    fc.assert(
      fc.property(arbCents, arbCents, (from, to) => {
        expect(exchangeRate(from, to)).toBe(to / from);
      }),
    );
    // IDR 1,000,000.00 → EUR 58.00
    expect(exchangeRate(100_000_000, 5_800)).toBeCloseTo(0.000058, 12);
  });

  it('ignores the signs of the amounts (the account side is negative for money out)', () => {
    fc.assert(
      fc.property(arbSignedCents, arbSignedCents, (from, to) => {
        expect(exchangeRate(from, to)).toBe(exchangeRate(Math.abs(from), Math.abs(to)));
      }),
    );
  });

  it('is at least 1 when more arrived than was sent, and at most 1 otherwise', () => {
    fc.assert(
      fc.property(arbCents, arbCents, (from, to) => {
        const rate = exchangeRate(from, to);
        if (rate === null) return;
        if (to > from) expect(rate).toBeGreaterThanOrEqual(1);
        if (to < from) expect(rate).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('exchangeLabel (property-based)', () => {
  const arbPair = fc
    .tuple(fc.constantFrom(...CURRENCY_CODES), fc.constantFrom(...CURRENCY_CODES))
    .filter(([a, b]) => a !== b);

  it('names both currencies and states the rate it was made at', () => {
    fc.assert(
      fc.property(arbPair, arbSignedCents, arbSignedCents, ([from, to], sent, received) => {
        const label = exchangeLabel(
          { cents: sent, code: from },
          { cents: received, code: to },
        ).replace(/ /g, ' ');
        expect(label.startsWith(`${from} `)).toBe(true);
        expect(label).toContain(` → ${to} `);
        const rate = exchangeRate(sent, received);
        if (rate === null) {
          expect(label).not.toContain('·');
        } else {
          expect(label.endsWith(` · ${rateText(from, to, rate)}`)).toBe(true);
        }
      }),
    );
  });

  it('shows the example from the design notes', () => {
    const label = exchangeLabel({ cents: 50_000, code: 'GBP' }, { cents: 58_025, code: 'EUR' });
    expect(label.replace(/ /g, ' ')).toBe('GBP 500.00 → EUR 580.25 · 1 GBP = 1.1605 EUR');
  });

  it('shows the rate of an exchange into a much smaller unit (IDR to EUR)', () => {
    const label = exchangeLabel(
      { cents: 100_000_000, code: 'IDR' },
      { cents: 5_800, code: 'EUR' },
    ).replace(/ /g, ' ');
    expect(label).toContain('· 1 IDR = 0.000058 EUR');
  });

  it('shows the amounts without a rate when one of them is zero', () => {
    const label = exchangeLabel({ cents: 0, code: 'GBP' }, { cents: 100, code: 'EUR' });
    expect(label.replace(/ /g, ' ')).toBe('GBP 0.00 → EUR 1.00');
  });
});

describe('canLinkAsTransfer (property-based)', () => {
  const arbTx = fc.record({
    transferTransactionId: fc.option(fc.constant('other-1'), { nil: null }),
    reconciled: fc.constantFrom(0, 1),
    isParent: fc.constantFrom(0, 1),
    parentTransactionId: fc.option(fc.constant('parent-1'), { nil: null }),
    isAdjustment: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
  });

  it('offers only plain transactions: no transfer, split, part, correction or reconciled one', () => {
    fc.assert(
      fc.property(arbTx, (tx) => {
        expect(canLinkAsTransfer(tx)).toBe(
          tx.transferTransactionId === null &&
            tx.reconciled === 0 &&
            tx.isParent === 0 &&
            tx.parentTransactionId === null &&
            !tx.isAdjustment,
        );
      }),
    );
  });

  it('offers a plain transaction', () => {
    expect(
      canLinkAsTransfer({
        transferTransactionId: null,
        reconciled: 0,
        isParent: 0,
        parentTransactionId: null,
      }),
    ).toBe(true);
  });
});

describe('transferRequest (property-based)', () => {
  const arbInput = fc.record({
    signedAmount: arbSignedCents,
    otherAmount: fc.option(arbCents, { nil: undefined }),
    categoryId: fc.option(fc.constantFrom('cat-1', null), { nil: undefined }),
    notes: fc.option(fc.constant('Rent'), { nil: null }),
  });
  const base = { accountId: 'self', otherAccountId: 'other', date: '2026-10-10' };

  it('sends from the side money leaves: this account on an outflow, the other on an inflow', () => {
    fc.assert(
      fc.property(arbInput, arbAccount, arbAccount, (input, self, other) => {
        const req = transferRequest({ ...base, ...input }, { self, other });
        const selfSends = input.signedAmount < 0;
        expect(req.fromAccountId).toBe(selfSends ? 'self' : 'other');
        expect(req.toAccountId).toBe(selfSends ? 'other' : 'self');
        expect(req.amount).toBeGreaterThan(0);
        expect(req.date).toBe(base.date);
        expect(req.notes).toBe(input.notes);
      }),
    );
  });

  it('moves the typed amount and sends no toAmount within one currency', () => {
    fc.assert(
      fc.property(arbInput, arbAccount, fc.constantFrom(0, 1), (input, self, otherOff) => {
        const other = { currency: self.currency, isOffBudget: otherOff };
        const req = transferRequest({ ...base, ...input }, { self, other });
        expect(req.amount).toBe(Math.abs(input.signedAmount));
        expect(req).not.toHaveProperty('toAmount');
      }),
    );
  });

  it('keeps both amounts of an exchange, each on its own side', () => {
    fc.assert(
      fc.property(arbInput, arbAccount, arbAccount, arbCents, (input, self, other, otherAmount) => {
        fc.pre(isExchange(self, other));
        const req = transferRequest({ ...base, ...input, otherAmount }, { self, other });
        const typed = Math.abs(input.signedAmount);
        if (input.signedAmount < 0) {
          expect([req.amount, req.toAmount]).toEqual([typed, otherAmount]);
        } else {
          expect([req.amount, req.toAmount]).toEqual([otherAmount, typed]);
        }
      }),
    );
  });

  it('sends a category only across the budget boundary, never between two budget accounts', () => {
    fc.assert(
      fc.property(arbInput, arbAccount, arbAccount, (input, self, other) => {
        const req = transferRequest({ ...base, ...input }, { self, other });
        if (crossesBudgetBoundary(self, other) && input.categoryId !== undefined) {
          expect(req.categoryId).toBe(input.categoryId);
        } else {
          expect(req).not.toHaveProperty('categoryId');
        }
        if (self.isOffBudget === 0 && other.isOffBudget === 0) {
          expect(req).not.toHaveProperty('categoryId');
        }
      }),
    );
  });

  it('passes a device-chosen id through', () => {
    const req = transferRequest(
      { ...base, signedAmount: -500, id: 'client-id-1234567' },
      { self: { currency: null, isOffBudget: 0 }, other: { currency: null, isOffBudget: 0 } },
    );
    expect(req).toEqual({
      id: 'client-id-1234567',
      fromAccountId: 'self',
      toAccountId: 'other',
      date: base.date,
      amount: 500,
      notes: null,
    });
  });
});
