import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { centsToInput, formatCentsAxis, formatCurrency, parseCents } from './currency';
import { CURRENCY_CODES } from './budgetCurrency';

// Up to ±$100 billion, far beyond any real balance but still exact in a double
const arbCents = fc.integer({ min: -10_000_000_000_00, max: 10_000_000_000_00 });

// Undo formatCurrency's "-$1,234.56" formatting to get cents back
const unformat = (s: string) => {
  const negative = s.startsWith('-');
  const digits = s.replace(/[-$,]/g, '');
  const cents = Math.round(parseFloat(digits) * 100);
  return negative ? -cents : cents;
};

describe('currency helpers (property-based)', () => {
  it('parseCents(centsToInput(c)) gives back the absolute amount', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        expect(parseCents(centsToInput(cents))).toBe(Math.abs(cents));
      }),
    );
  });

  it('parses any "dollars.cc" string to exact integer cents', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100_000_000_000 }), fc.nat({ max: 99 }), (dollars, cc) => {
        const s = `${dollars}.${String(cc).padStart(2, '0')}`;
        expect(parseCents(s)).toBe(dollars * 100 + cc);
      }),
    );
  });

  it('always returns a finite integer, never NaN or a fraction of a cent', () => {
    fc.assert(
      fc.property(
        // Arbitrary text plus number-like strings, including exponents such as "1e400"
        fc.oneof(
          fc.string(),
          fc.double().map(String),
          fc.double().map((d) => d.toExponential()),
        ),
        (s) => {
          expect(Number.isSafeInteger(parseCents(s))).toBe(true);
        },
      ),
    );
  });

  it('formatCurrency round-trips to the same cents, with 0 or 2 decimals', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        const s = formatCurrency(cents);
        expect(unformat(s)).toBe(cents);
        expect(s).toMatch(/^-?\$\d{1,3}(,\d{3})*(\.\d{2})?$/);
        expect(s.startsWith('-')).toBe(cents < 0);
      }),
    );
  });
});

// Undo formatCentsAxis's "-$1.5M" formatting to get dollars back
const unformatAxis = (s: string) => {
  const m = /^(-?)\$(\d+(?:\.\d)?)([kM]?)$/.exec(s);
  if (!m) throw new Error(`unexpected axis label ${s}`);
  const scale = m[3] === 'M' ? 1_000_000 : m[3] === 'k' ? 1_000 : 1;
  return (m[1] ? -1 : 1) * Number(m[2]) * scale;
};

describe('formatCentsAxis (property-based)', () => {
  it('reads back within rounding of the real amount, with the right sign', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        const s = formatCentsAxis(cents);
        const dollars = cents / 100;
        const back = unformatAxis(s);
        // One decimal of k/M is at most 5% off; whole dollars at most $0.50
        expect(Math.abs(back - dollars)).toBeLessThanOrEqual(
          Math.max(0.5, Math.abs(dollars) * 0.05) + 1e-6,
        );
        if (Math.abs(dollars) >= 0.5) expect(s.startsWith('-')).toBe(cents < 0);
      }),
    );
  });

  it('labels whole thousands and millions exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 1, max: 5000 }), (k, m) => {
        expect(formatCentsAxis(k * 1_000_00)).toBe(`$${k}k`);
        expect(formatCentsAxis(m * 1_000_000_00)).toBe(`$${m}M`);
        expect(formatCentsAxis(-k * 1_000_00)).toBe(`-$${k}k`);
      }),
    );
  });

  it('gives each distinct nice tick a distinct label', () => {
    // Axis ticks are multiples of a step like 25k or 50k; labels must never repeat
    const ticks = [0, 35_000, 70_000, 100_000, 135_000, 250_000, 1_000_000, 1_500_000];
    const labels = ticks.map((d) => formatCentsAxis(d * 100));
    expect(new Set(labels).size).toBe(ticks.length);
  });
});

// "CHF 1,234.50": Intl puts a no-break space between the code and the amount
const FOREIGN = /^(-?)([A-Z]{3})\u00a0(\d{1,3}(?:,\d{3})*)\.(\d{2})$/;

describe('formatCurrency in another currency (property-based)', () => {
  // Any three-letter code (Intl accepts them all), plus the ones the app offers
  const arbForeign = fc.oneof(fc.constantFrom(...CURRENCY_CODES), fc.stringMatching(/^[A-Z]{3}$/));

  it('shows the code, the amount with two decimals and the sign, never NaN', () => {
    fc.assert(
      fc.property(arbCents, arbForeign, (cents, code) => {
        const s = formatCurrency(cents, code);
        expect(s).not.toContain('NaN');
        const m = FOREIGN.exec(s);
        expect(m, s).not.toBeNull();
        const [, sign, shownCode, whole, frac] = m!;
        expect(shownCode).toBe(code);
        expect(sign === '-').toBe(cents < 0);
        const back = Number(whole.replace(/,/g, '')) * 100 + Number(frac);
        expect(sign ? -back : back).toBe(cents);
      }),
    );
  });

  it('gives EUR, USD and CHF exact examples with two decimals', () => {
    expect(formatCurrency(123_456, 'EUR')).toBe('EUR 1,234.56');
    expect(formatCurrency(123_400, 'USD')).toBe('USD 1,234.00');
    expect(formatCurrency(-5_000, 'CHF')).toBe('-CHF 50.00');
  });

  it('gives every offered currency two decimals, including those with none in ISO', () => {
    for (const code of CURRENCY_CODES) {
      expect(formatCurrency(100_000, code)).toMatch(/\.00$/);
    }
  });

  it('shows a code Intl does not know as "<CODE> 1,234.56"', () => {
    fc.assert(
      fc.property(
        arbCents,
        fc.string({ minLength: 1, maxLength: 6 }).filter((code) => !/^[a-zA-Z]{3}$/.test(code)),
        (cents, code) => {
          const s = formatCurrency(cents, code);
          const sign = cents < 0 ? '-' : '';
          const amount = (Math.abs(cents) / 100).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          expect(s).toBe(`${sign}${code} ${amount}`);
        },
      ),
    );
  });
});
