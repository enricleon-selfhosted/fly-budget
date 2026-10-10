import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MAX_RATE,
  accountCountText,
  budgetCurrencyChangeText,
  checkRateEntry,
  dayText,
  downloadSummaryText,
  isDay,
  latestRateText,
  parseRate,
  rateSourceLabel,
  rateText,
  ratesErrorText,
  ratesProblem,
  ratesUpdatedText,
  todayDay,
  unsupportedCurrencies,
  waitingText,
} from './currencyRates';

const arbCode = fc.stringMatching(/^[A-Z]{3}$/);
const arbRate = fc.double({
  min: Number.MIN_VALUE,
  max: MAX_RATE,
  noNaN: true,
  noDefaultInfinity: true,
});
const arbDay = fc
  .record({
    year: fc.integer({ min: 1990, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );

describe('rate text (property-based)', () => {
  it('reads "1 base = rate quote" with the rate to six significant digits', () => {
    fc.assert(
      fc.property(arbCode, arbCode, arbRate, (base, quote, rate) => {
        const text = rateText(base, quote, rate);
        const prefix = `1 ${base} = `;
        const suffix = ` ${quote}`;
        expect(text.startsWith(prefix)).toBe(true);
        expect(text.endsWith(suffix)).toBe(true);
        const shown = Number(
          text.slice(prefix.length, text.length - suffix.length).replace(/,/g, ''),
        );
        expect(Math.abs(shown - rate) / rate).toBeLessThan(1e-5);
      }),
    );
  });

  it('shows the latest rate with its day, or "No rate yet"', () => {
    expect(latestRateText('GBP', 'EUR', null)).toBe('No rate yet');
    fc.assert(
      fc.property(arbCode, arbCode, arbRate, arbDay, (base, quote, rate, date) => {
        const text = latestRateText(base, quote, { rate, date });
        expect(text.startsWith(rateText(base, quote, rate))).toBe(true);
        expect(text).toContain(` on ${dayText(date)}`);
        expect(text).toContain(date.slice(0, 4));
      }),
    );
  });

  it('shows the source of a rate in plain words, distinct for each', () => {
    expect(rateSourceLabel('ecb')).toBe('Downloaded');
    expect(rateSourceLabel('manual')).toBe('Typed in');
  });
});

describe('days (property-based)', () => {
  it('accepts real yyyy-MM-dd days and nothing else', () => {
    fc.assert(
      fc.property(arbDay, (day) => {
        expect(isDay(day)).toBe(true);
        expect(dayText(day)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
      }),
    );
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '26-01-01', '', 'today']) {
      expect(isDay(bad)).toBe(false);
    }
  });

  it("gives today's day in the same format", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1990-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        (now) => {
          const day = todayDay(now);
          expect(isDay(day)).toBe(true);
          expect(day.slice(0, 4)).toBe(String(now.getFullYear()));
        },
      ),
    );
  });

  it('shows text that is not a day as it is, rather than throwing', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !isDay(s)),
        (s) => {
          expect(dayText(s) === s || /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(dayText(s))).toBe(true);
        },
      ),
    );
  });

  it('says when the rates were last updated, or that they never were', () => {
    expect(ratesUpdatedText(null)).toBe('Not downloaded yet');
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        (when) => {
          expect(ratesUpdatedText(when.toISOString())).toMatch(
            /^Last updated [A-Z][a-z]{2} \d{1,2}, \d{4} at \d{2}:\d{2}$/,
          );
        },
      ),
    );
    expect(ratesUpdatedText('not a date')).toBe('Last updated');
  });
});

describe('typed-in rates (property-based)', () => {
  it('reads back every rate that is typed as its own number', () => {
    fc.assert(
      fc.property(arbRate, (rate) => {
        expect(parseRate(String(rate))).toBe(rate);
        expect(parseRate(`  ${String(rate)}  `)).toBe(rate);
      }),
    );
  });

  it('refuses zero, negatives, rates above the server limit, and anything not a number', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e9, max: 0, noNaN: true }), (rate) => {
        expect(parseRate(String(rate))).toBeNull();
      }),
    );
    fc.assert(
      fc.property(fc.double({ min: MAX_RATE * 1.000001, max: 1e300, noNaN: true }), (rate) => {
        expect(parseRate(String(rate))).toBeNull();
      }),
    );
    for (const text of ['', '   ', 'abc', 'NaN', 'Infinity', '1,5', '0x10']) {
      expect(parseRate(text)).toBeNull();
    }
  });

  it('checks the form: a real day and a rate above zero, with a message for each problem', () => {
    fc.assert(
      fc.property(arbDay, arbRate, (day, rate) => {
        expect(checkRateEntry(day, String(rate))).toEqual({ ok: true, date: day, rate });
      }),
    );
    fc.assert(
      fc.property(arbDay, fc.constantFrom('0', '-1', '', 'x'), (day, text) => {
        const result = checkRateEntry(day, text);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/rate/);
      }),
    );
    const noDay = checkRateEntry('', '1.2');
    expect(noDay).toEqual({ ok: false, error: 'Pick a date for the rate.' });
  });
});

describe('download problems (property-based)', () => {
  it('reads the codes the ECB does not publish from ratesError', () => {
    fc.assert(
      fc.property(fc.uniqueArray(arbCode, { minLength: 1, maxLength: 6 }), (codes) => {
        expect(unsupportedCurrencies(`unsupported:${codes.join(',')}`)).toEqual(codes);
        const problem = ratesProblem(`unsupported:${codes.join(',')}`);
        expect(problem).toEqual({ kind: 'unsupported', codes });
        const text = ratesErrorText(`unsupported:${codes.join(',')}`);
        for (const code of codes) expect(text).toContain(code);
      }),
    );
  });

  it('classifies every other error, and says nothing when there is none', () => {
    expect(ratesProblem(null)).toBeNull();
    expect(ratesErrorText(null)).toBeNull();
    expect(ratesProblem('unreachable')).toEqual({ kind: 'unreachable' });
    expect(ratesErrorText('unreachable')).toContain("Couldn't reach");
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== '' && s !== 'unreachable' && !s.startsWith('unsupported:')),
        (error) => {
          expect(ratesProblem(error)).toEqual({ kind: 'unknown' });
          expect(ratesErrorText(error)).not.toBeNull();
        },
      ),
    );
    expect(unsupportedCurrencies('unsupported:abc,1X')).toEqual([]);
  });

  it('sums up a download in a sentence, mentioning what failed', () => {
    expect(downloadSummaryText({ downloaded: 0, error: null, unsupported: [] })).toBe(
      'The rates are up to date.',
    );
    expect(downloadSummaryText({ downloaded: 1, error: null, unsupported: [] })).toBe(
      'Downloaded 1 rate.',
    );
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }).filter((n) => n > 1),
        fc.uniqueArray(arbCode, { maxLength: 3 }),
        fc.boolean(),
        (downloaded, unsupported, unreachable) => {
          const text = downloadSummaryText({
            downloaded,
            error: unreachable ? 'unreachable' : null,
            unsupported,
          });
          expect(text).toContain(`Downloaded ${downloaded.toLocaleString('en-US')} rates.`);
          for (const code of unsupported) expect(text).toContain(code);
          expect(text.includes("Couldn't reach")).toBe(unreachable);
        },
      ),
    );
  });
});

describe('counts and wording (property-based)', () => {
  it('shows a waiting count only when there is one', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 0 }), (count) => {
        expect(waitingText(count)).toBeNull();
      }),
    );
    expect(waitingText(1)).toBe('1 transaction is waiting for a rate');
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1000000 }), (count) => {
        expect(waitingText(count)).toMatch(/^[\d,]+ transactions are waiting for a rate$/);
      }),
    );
  });

  it('counts accounts in the singular for one and the plural otherwise', () => {
    expect(accountCountText(1)).toBe('1 account');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }).filter((n) => n !== 1),
        (count) => {
          expect(accountCountText(count)).toMatch(/^[\d,]+ accounts$/);
        },
      ),
    );
  });

  it('names both currencies when the budget changes', () => {
    fc.assert(
      fc.property(arbCode, arbCode, (from, to) => {
        const text = budgetCurrencyChangeText(from, to);
        expect(text).toContain(`The budget will be in ${to}.`);
        expect(text).toContain(`${from} keep ${from}`);
      }),
    );
  });
});
