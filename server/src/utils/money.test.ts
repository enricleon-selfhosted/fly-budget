import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AmountError, decimalToCents } from './money.js';

/** Formats cents the way banks send them: "-12.34" */
const asDecimal = (cents: number) =>
  `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

describe('decimalToCents', () => {
  it('converts any 2-decimal amount exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), (cents) => {
        expect(decimalToCents(asDecimal(cents))).toBe(cents);
      }),
    );
  });

  it('is symmetric around zero and never returns -0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e13 }), fc.nat(9), (cents, extra) => {
        const s = `${asDecimal(cents)}${extra}`;
        expect(decimalToCents(`-${s}`)).toBe(-decimalToCents(s) || 0);
        expect(Object.is(decimalToCents(`-${s}`), -0)).toBe(false);
      }),
    );
  });

  it('rounds digits past the second decimal half away from zero', () => {
    expect(decimalToCents('1.005')).toBe(101);
    expect(decimalToCents('-1.005')).toBe(-101);
    expect(decimalToCents('1.0049999')).toBe(100);
    expect(decimalToCents('7')).toBe(700);
    expect(decimalToCents('0.1')).toBe(10);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'NaN', '1e5', '1,000.00', '--1', '0x10', ' 1', '1.', '.5', '+1']) {
      expect(() => decimalToCents(bad), bad).toThrow(AmountError);
    }
  });

  it('rejects amounts that would not be exact as a number', () => {
    expect(() => decimalToCents('999999999999999.99')).toThrow(AmountError);
  });
});
