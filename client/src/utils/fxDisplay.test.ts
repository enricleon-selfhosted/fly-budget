import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { budgetTotal, fxNote, fxSourceLabel, rateText, valueInBudget } from './fxDisplay';

const arbCents = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
const arbSource = fc.constantFrom('manual' as const, 'exchange' as const, 'rate' as const);
const arbCode = fc.constantFrom('EUR', 'GBP', 'USD', 'CHF', 'SEK');
// Absent (the budget's currency), waiting for a rate, or converted
const arbRow = fc.record({
  amount: arbCents,
  budgetAmount: fc.oneof(fc.constant(undefined), fc.constant(null), arbCents),
});
const arbWaiting = arbCents.map((amount) => ({ amount, budgetAmount: null }));
const arbRows = fc.array(arbRow, { maxLength: 40 });

describe('valueInBudget (property-based)', () => {
  it('counts a budget-currency row as its amount', () => {
    fc.assert(
      fc.property(arbCents, (amount) => {
        expect(valueInBudget({ amount, budgetAmount: undefined })).toBe(amount);
      }),
    );
  });

  it('uses the converted value when there is one, and nothing while there is no rate', () => {
    fc.assert(
      fc.property(arbCents, arbCents, (amount, budgetAmount) => {
        expect(valueInBudget({ amount, budgetAmount })).toBe(budgetAmount);
        expect(valueInBudget({ amount, budgetAmount: null })).toBeNull();
      }),
    );
  });
});

describe('budgetTotal (property-based)', () => {
  it('adds the absolute value of every converted row, and counts the rows still waiting', () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const values = rows.map(valueInBudget);
        const expectedTotal = values.reduce<number>(
          (sum, v) => sum + (v === null ? 0 : Math.abs(v)),
          0,
        );
        const expectedWaiting = values.filter((v) => v === null).length;
        expect(budgetTotal(rows)).toEqual({ total: expectedTotal, waiting: expectedWaiting });
      }),
    );
  });

  it('does not depend on the order of the rows', () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        expect(budgetTotal([...rows].reverse())).toEqual(budgetTotal(rows));
      }),
    );
  });

  it('a row waiting for a rate leaves the total alone and is counted as waiting', () => {
    fc.assert(
      fc.property(arbRows, arbWaiting, (rows, waiting) => {
        const before = budgetTotal(rows);
        const after = budgetTotal([...rows, waiting]);
        expect(after.total).toBe(before.total);
        expect(after.waiting).toBe(before.waiting + 1);
      }),
    );
  });

  it('is never negative and at least as big as any single converted row', () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const { total } = budgetTotal(rows);
        expect(total).toBeGreaterThanOrEqual(0);
        for (const row of rows) {
          const v = valueInBudget(row);
          if (v !== null) expect(total).toBeGreaterThanOrEqual(Math.abs(v));
        }
      }),
    );
  });

  it('rows all in the budget currency add up as their amounts, with nothing waiting', () => {
    fc.assert(
      fc.property(fc.array(arbCents, { maxLength: 40 }), (amounts) => {
        const rows = amounts.map((amount) => ({ amount, budgetAmount: undefined }));
        expect(budgetTotal(rows)).toEqual({
          total: amounts.reduce((sum, a) => sum + Math.abs(a), 0),
          waiting: 0,
        });
      }),
    );
  });
});

describe('rateText (property-based)', () => {
  it('has no text without a usable rate', () => {
    expect(rateText(null, 'GBP', 'EUR')).toBeNull();
    expect(rateText(undefined, 'GBP', 'EUR')).toBeNull();
    expect(rateText(0, 'GBP', 'EUR')).toBeNull();
    expect(rateText(Number.NaN, 'GBP', 'EUR')).toBeNull();
    expect(rateText(Number.POSITIVE_INFINITY, 'GBP', 'EUR')).toBeNull();
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 0, noNaN: true }), (rate) => {
        expect(rateText(rate, 'GBP', 'EUR')).toBeNull();
      }),
    );
  });

  it('reads "1 FROM = rate TO" with four decimals, rounded from the rate', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0001, max: 1000, noNaN: true, noDefaultInfinity: true }),
        arbCode,
        arbCode,
        (rate, from, to) => {
          const text = rateText(rate, from, to)!;
          const match = /^1 ([A-Z]{3}) = ([\d,]+\.\d{4}) ([A-Z]{3})$/.exec(text);
          expect(match).not.toBeNull();
          expect(match![1]).toBe(from);
          expect(match![3]).toBe(to);
          const shown = Number(match![2].replace(/,/g, ''));
          expect(Math.abs(shown - rate)).toBeLessThanOrEqual(0.00005 + 1e-9);
        },
      ),
    );
  });
});

describe('fxSourceLabel and fxNote (property-based)', () => {
  it('gives each source its own label, and a clear one for no rate', () => {
    const labels = [
      fxSourceLabel('manual'),
      fxSourceLabel('exchange'),
      fxSourceLabel('rate'),
      fxSourceLabel(null),
    ];
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(fxSourceLabel(undefined)).toBe(fxSourceLabel(null));
  });

  it('starts with the source label and adds the rate only when there is one', () => {
    fc.assert(
      fc.property(
        fc.option(arbSource, { nil: null }),
        fc.option(fc.double({ min: 0.0001, max: 1000, noNaN: true, noDefaultInfinity: true }), {
          nil: null,
        }),
        arbCode,
        arbCode,
        (source, rate, from, to) => {
          const note = fxNote(source, rate, from, to);
          expect(note.startsWith(fxSourceLabel(source))).toBe(true);
          expect(note.includes(' = ')).toBe(rate !== null);
        },
      ),
    );
  });

  it('spells out the rate with the same "·" separator the detail panel uses', () => {
    expect(fxNote('rate', 1.17, 'GBP', 'EUR')).toBe("At the day's rate · 1 GBP = 1.1700 EUR");
  });
});
