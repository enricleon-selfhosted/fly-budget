import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  MAX_RATE_AGE_DAYS,
  convertCents,
  downloadRanges,
  impliedRate,
  pickFxRate,
  rateOn,
  type DailyRate,
} from './conversion.js';

const day = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1) + offset * 864e5).toISOString().slice(0, 10);

/** Amounts a budget holds, both directions */
const cents = fc.integer({ min: -10_000_000_000, max: 10_000_000_000 });
const nonZero = cents.filter((c) => c !== 0);
/** Rates like the ECB's, from yen to dinars */
const rate = fc.double({ min: 0.0001, max: 50_000, noNaN: true, noDefaultInfinity: true });

describe('convertCents', () => {
  it('rounds exactly like SQLite does in the budget totals', () => {
    const sqlite = new Database(':memory:');
    const stmt = sqlite.prepare('select cast(round(? * ?) as integer) as v');
    fc.assert(
      fc.property(cents, rate, (amount, r) => {
        const { v } = stmt.get(amount, r) as { v: number };
        expect(convertCents(amount, r)).toBe(v);
      }),
    );
  });

  it('keeps the direction, and opposite amounts convert to opposite values', () => {
    fc.assert(
      fc.property(nonZero, rate, (amount, r) => {
        const value = convertCents(amount, r);
        expect(value === 0 || Math.sign(value) === Math.sign(amount)).toBe(true);
        expect(convertCents(-amount, r) + value).toBe(0);
      }),
    );
  });
});

describe('impliedRate', () => {
  it('converts the amount into exactly the target', () => {
    fc.assert(
      fc.property(nonZero, nonZero, (amount, target) => {
        const r = impliedRate(amount, target)!;
        expect(Math.abs(convertCents(amount, r))).toBe(Math.abs(target));
      }),
    );
  });

  it('has no rate for a zero on either side', () => {
    expect(impliedRate(0, 100)).toBeNull();
    expect(impliedRate(100, 0)).toBeNull();
  });
});

describe('rateOn', () => {
  const series = fc
    .uniqueArray(fc.integer({ min: 0, max: 400 }), { maxLength: 40 })
    .chain((days) =>
      fc.tuple(
        fc.constant([...days].sort((a, b) => a - b)),
        fc.array(fc.tuple(rate, fc.constantFrom('ecb' as const, 'manual' as const)), {
          minLength: days.length,
          maxLength: days.length,
        }),
      ),
    )
    .map(([days, values]) =>
      days.map((d, i): DailyRate => ({ date: day(d), rate: values[i][0], source: values[i][1] })),
    );

  it('is the latest rate on or before the date, a downloaded one only up to a week old', () => {
    fc.assert(
      fc.property(series, fc.integer({ min: -10, max: 420 }), (rates, d) => {
        const date = day(d);
        const before = rates.filter((r) => r.date <= date);
        const latest = before[before.length - 1];
        const age = latest ? (Date.parse(date) - Date.parse(latest.date)) / 864e5 : 0;
        const expected =
          !latest || (latest.source === 'ecb' && age > MAX_RATE_AGE_DAYS) ? null : latest.rate;
        expect(rateOn(rates, date)).toBe(expected);
      }),
    );
  });

  it('a rate typed in applies until the next rate', () => {
    const rates: DailyRate[] = [{ date: day(0), rate: 1.2, source: 'manual' }];
    expect(rateOn(rates, day(300))).toBe(1.2);
    expect(rateOn(rates, day(-1))).toBeNull();
  });
});

describe('pickFxRate', () => {
  const lookup = () => 1.17;
  const base = { amount: -2_000, date: day(5), current: { rate: null, source: null }, lookup };

  it('prefers a rate typed in, then the exchange, then the day’s rate', () => {
    expect(
      pickFxRate({ ...base, current: { rate: 1.3, source: 'manual' }, exchangeOther: 2_400 }),
    ).toEqual({ rate: 1.3, source: 'manual' });
    expect(pickFxRate({ ...base, exchangeOther: 2_340 })).toEqual({
      rate: 1.17,
      source: 'exchange',
    });
    expect(pickFxRate(base)).toEqual({ rate: 1.17, source: 'rate' });
    // An older automatic rate is recomputed, not kept
    expect(pickFxRate({ ...base, current: { rate: 9, source: 'rate' } })).toEqual({
      rate: 1.17,
      source: 'rate',
    });
  });

  it('an exchange converts to exactly what arrived on the other side', () => {
    fc.assert(
      fc.property(nonZero, nonZero, (amount, other) => {
        const choice = pickFxRate({ ...base, amount, exchangeOther: -other })!;
        expect(choice.source).toBe('exchange');
        expect(Math.abs(convertCents(amount, choice.rate))).toBe(Math.abs(other));
      }),
    );
  });

  it('split parts take their parent’s rate, even none', () => {
    const parent = { rate: 1.25, source: 'manual' as const };
    expect(pickFxRate({ ...base, parent })).toEqual(parent);
    expect(pickFxRate({ ...base, parent: null })).toBeNull();
  });

  it('has no rate when there is none for the day', () => {
    expect(pickFxRate({ ...base, lookup: () => null })).toBeNull();
  });
});

describe('downloadRanges', () => {
  it('covers every day from the start to today, without downloading what is already there', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.option(fc.tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 60 }))),
        fc.integer({ min: 0, max: 400 }),
        (start, have, todayOffset) => {
          const today = day(todayOffset);
          const stored = have ? { first: day(have[0]), last: day(have[0] + have[1]) } : null;
          const ranges = downloadRanges(stored, day(start), today);
          const covered = (d: string) =>
            ranges.some((r) => r.from <= d && d <= r.to) ||
            (stored !== null && stored.first <= d && d <= stored.last);
          for (let d = start; d <= todayOffset; d++) expect(covered(day(d))).toBe(true);
          for (const r of ranges) {
            expect(r.from <= r.to).toBe(true);
            if (stored) expect(r.to < stored.first || r.from > stored.last).toBe(true);
          }
        },
      ),
    );
  });

  it('starts a week early, so a weekend or holiday start has the business day before it', () => {
    expect(downloadRanges(null, day(10), day(20))).toEqual([{ from: day(3), to: day(20) }]);
    expect(downloadRanges(null, day(21), day(20))).toEqual([]);
  });
});
