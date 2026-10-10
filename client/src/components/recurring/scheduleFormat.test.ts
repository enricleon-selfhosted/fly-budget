import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { OccurrenceDisplayStatus } from '../../types';
import { formatCurrency } from '../../utils/currency';
import {
  accountCurrencyLookup,
  computeTotals,
  describeCurrencyTotals,
  formatPlainAmount,
  formatScheduleAmount,
  splitByCurrency,
  summarizeByCurrency,
  type SummaryItem,
} from './scheduleFormat';

const STATUSES: OccurrenceDisplayStatus[] = [
  'upcoming',
  'due',
  'waiting',
  'paid',
  'skipped',
  'cancelled',
];

const arbAmount = fc.integer({ min: -100_000_000, max: 100_000_000 });

// An occurrence in one of three currencies, as the summary sees it
const arbItem = fc.record({
  expectedAmount: arbAmount,
  matchedAmount: fc.option(arbAmount, { nil: null }),
  displayStatus: fc.constantFrom(...STATUSES),
  currency: fc.constantFrom('EUR', 'GBP', 'USD'),
});
type Item = SummaryItem & { currency: string };

const BUDGET = 'EUR';

describe('formatScheduleAmount', () => {
  it('prefixes approximate amounts with ~ and income with +', () => {
    expect(formatScheduleAmount(1234, 'exact')).toBe(`+${formatCurrency(1234)}`);
    expect(formatScheduleAmount(-1234, 'approximate')).toBe(`~${formatCurrency(1234)}`);
    expect(formatScheduleAmount(1234, 'variable')).toBe(`~+${formatCurrency(1234)}`);
  });

  it("formats in the item's account currency, and the budget's when there is none", () => {
    expect(formatScheduleAmount(-1234, 'exact', 'GBP')).toBe(formatCurrency(1234, 'GBP'));
    expect(formatScheduleAmount(-1234, 'exact', null)).toBe(formatCurrency(1234));
    expect(formatScheduleAmount(-1234, 'exact')).toBe(formatCurrency(1234));
  });
});

describe('accountCurrencyLookup', () => {
  const lookup = accountCurrencyLookup([
    { id: 'budget', currency: null },
    { id: 'gbp', currency: 'GBP' },
  ]);

  it('gives an account its own currency, null for the budget currency', () => {
    expect(lookup('gbp')).toBe('GBP');
    expect(lookup('budget')).toBeNull();
  });

  it('gives null for no account, or one the list does not have (e.g. closed)', () => {
    expect(lookup(null)).toBeNull();
    expect(lookup(undefined)).toBeNull();
    expect(lookup('closed')).toBeNull();
  });
});

describe('computeTotals', () => {
  it('adds paid (matched amount first) and remaining, leaving out skipped and canceled items', () => {
    const totals = computeTotals([
      { expectedAmount: -1000, matchedAmount: -1200, displayStatus: 'paid' },
      { expectedAmount: -500, matchedAmount: null, displayStatus: 'upcoming' },
      { expectedAmount: -700, matchedAmount: null, displayStatus: 'skipped' },
      { expectedAmount: -800, matchedAmount: null, displayStatus: 'cancelled' },
    ]);
    expect(totals).toEqual({ total: 1700, paid: 1200, remaining: 500 });
  });

  it('keeps paid + remaining equal to the total, with nothing negative', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 30 }), (items) => {
        const t = computeTotals(items);
        expect(t.total).toBe(t.paid + t.remaining);
        expect(t.paid).toBeGreaterThanOrEqual(0);
        expect(t.remaining).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('splitByCurrency', () => {
  it('puts every item in exactly one group: the budget currency, then one per other currency', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 40 }), (items) => {
        const split = splitByCurrency(items, (i) => i.currency, BUDGET);
        const placed = [...split.budget, ...split.others.flatMap((g) => g.items)];
        expect(placed).toHaveLength(items.length);
        expect(new Set(placed).size).toBe(items.length);

        expect(split.budget.every((i) => i.currency === BUDGET)).toBe(true);
        for (const group of split.others) {
          expect(group.currency).not.toBe(BUDGET);
          expect(group.items.every((i) => i.currency === group.currency)).toBe(true);
        }
        const codes = split.others.map((g) => g.currency);
        expect([...codes].sort()).toEqual(codes);
        expect(new Set(codes).size).toBe(codes.length);
      }),
    );
  });
});

describe('summarizeByCurrency', () => {
  it('totals only the budget currency in the headline and adds nothing else into it', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 40 }), (items) => {
        const summary = summarizeByCurrency(items, (i) => i.currency, BUDGET);
        expect(summary.totals).toEqual(computeTotals(items.filter((i) => i.currency === BUDGET)));
      }),
    );
  });

  it('accounts for every amount exactly once across the headline and the other currencies', () => {
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 40 }), (items) => {
        const summary = summarizeByCurrency(items, (i) => i.currency, BUDGET);
        const all = computeTotals(items);
        const sum = (key: 'total' | 'paid' | 'remaining') =>
          summary.totals[key] + summary.others.reduce((s, o) => s + o.totals[key], 0);
        expect(sum('total')).toBe(all.total);
        expect(sum('paid')).toBe(all.paid);
        expect(sum('remaining')).toBe(all.remaining);
      }),
    );
  });

  it('shows one entry per other currency that has something to show', () => {
    const summary = summarizeByCurrency<Item>(
      [
        { expectedAmount: 240000, matchedAmount: null, displayStatus: 'upcoming', currency: 'GBP' },
        { expectedAmount: 60000, matchedAmount: 60000, displayStatus: 'paid', currency: 'GBP' },
        { expectedAmount: 9000, matchedAmount: null, displayStatus: 'skipped', currency: 'USD' },
      ],
      (i) => i.currency,
      BUDGET,
    );
    expect(summary.totals.total).toBe(0);
    expect(summary.others).toEqual([
      { currency: 'GBP', totals: { total: 300000, paid: 60000, remaining: 240000 } },
    ]);
  });
});

describe('formatPlainAmount and describeCurrencyTotals', () => {
  it('formats hundredths with grouping and two decimals, without a symbol', () => {
    expect(formatPlainAmount(120000)).toBe('1,200.00');
    expect(formatPlainAmount(5)).toBe('0.05');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (cents) => {
        expect(formatPlainAmount(cents).replace(/,/g, '')).toBe((cents / 100).toFixed(2));
      }),
    );
  });

  it('writes one currency line in the same wording as the budget totals', () => {
    const totals = { total: 240000, paid: 120000, remaining: 120000 };
    expect(describeCurrencyTotals('GBP', totals, 'received')).toBe(
      'GBP: 1,200.00 of 2,400.00 received',
    );
    expect(describeCurrencyTotals('GBP', totals, 'paid')).toBe('GBP: 1,200.00 of 2,400.00 paid');
  });
});
