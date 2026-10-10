import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CURRENCY_CODES } from './budgetCurrency';
import {
  budgetSideHint,
  budgetSideTakesCategory,
  crossesBudgetBoundary,
  exchangeLabel,
  exchangeRate,
  isExchange,
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

  it('is |to| / |from| rounded to four decimals, or null when that rounds to zero', () => {
    fc.assert(
      fc.property(arbCents, arbCents, (from, to) => {
        const rate = exchangeRate(from, to);
        const exact = to / from;
        if (rate === null) {
          expect(exact).toBeLessThan(0.00005);
          return;
        }
        expect(Math.abs(rate - exact)).toBeLessThanOrEqual(0.00005 + Math.abs(exact) * 1e-12);
        expect(Number(rate.toFixed(4))).toBe(rate);
      }),
    );
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
          const match = label.match(new RegExp(`· 1 ${from} = ([\\d,]+\\.\\d{4}) ${to}$`));
          expect(match).not.toBeNull();
          expect(Number(match![1].replace(/,/g, ''))).toBe(rate);
        }
      }),
    );
  });

  it('shows the example from the design notes', () => {
    const label = exchangeLabel({ cents: 50_000, code: 'GBP' }, { cents: 58_025, code: 'EUR' });
    expect(label.replace(/ /g, ' ')).toBe('GBP 500.00 → EUR 580.25 · 1 GBP = 1.1605 EUR');
  });

  it('shows the amounts without a rate when one of them is zero', () => {
    const label = exchangeLabel({ cents: 0, code: 'GBP' }, { cents: 100, code: 'EUR' });
    expect(label.replace(/ /g, ' ')).toBe('GBP 0.00 → EUR 1.00');
  });
});
