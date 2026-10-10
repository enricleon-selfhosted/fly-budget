import { z } from 'zod';

// Amounts from banks arrive as decimal strings. FlyBudget stores every amount, in any
// currency, as integer hundredths ("cents"), so they're converted here with string math:
// parseFloat would turn "0.29" into 28.999… cents.

/** A plain decimal amount as banks send it, e.g. "-12.34": no exponent, separators or spaces */
export const decimalString = z.string().regex(/^-?\d{1,15}(\.\d{1,8})?$/, 'Invalid amount');

/** The amount isn't a plain decimal, or doesn't fit a safe integer once converted */
export class AmountError extends Error {}

/**
 * Exact conversion of a decimal string to integer hundredths. Digits past the second
 * decimal round half away from zero ("1.005" → 101, "-1.005" → -101).
 */
export function decimalToCents(value: string): number {
  if (!decimalString.safeParse(value).success) throw new AmountError('Invalid amount');
  const negative = value.startsWith('-');
  const [whole, frac = ''] = value.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  const rounded = Number(frac[2] ?? '0') >= 5 ? cents + 1 : cents;
  if (!Number.isSafeInteger(rounded)) throw new AmountError('Amount out of range');
  // `|| 0` turns -0 into 0
  return negative ? -rounded || 0 : rounded;
}
