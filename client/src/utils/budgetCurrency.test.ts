import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  accountCurrency,
  budgetCurrency,
  CURRENCY_CODES,
  isForeignCurrency,
  otherCurrencyCodes,
} from './budgetCurrency';

const KNOWN_SYMBOLS: Array<[symbol: string, code: string]> = [
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['kr', 'SEK'],
  ['zł', 'PLN'],
  ['Fr', 'CHF'],
  ['CHF', 'CHF'],
  ['R$', 'BRL'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['₺', 'TRY'],
  ['Kč', 'CZK'],
  ['Ft', 'HUF'],
  ['lei', 'RON'],
];
const KNOWN = new Set(KNOWN_SYMBOLS.map(([symbol]) => symbol));

const arbCode = fc.stringMatching(/^[A-Z]{3}$/);
const arbOfferedCode = fc.constantFrom(...CURRENCY_CODES);

describe('budgetCurrency (property-based)', () => {
  it('an explicit code always wins over the symbol', () => {
    fc.assert(
      fc.property(arbCode, fc.string(), (code, symbol) => {
        expect(budgetCurrency(code, symbol)).toBe(code);
      }),
    );
  });

  it('maps a known symbol to its code, ignoring spaces around it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_SYMBOLS),
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        ([symbol, code], before, after) => {
          expect(budgetCurrency(null, ' '.repeat(before) + symbol + ' '.repeat(after))).toBe(code);
        },
      ),
    );
  });

  it('falls back to USD for any symbol it does not know', () => {
    fc.assert(
      fc.property(
        fc.string().filter((symbol) => !KNOWN.has(symbol.trim())),
        (symbol) => {
          expect(budgetCurrency(null, symbol)).toBe('USD');
        },
      ),
    );
  });

  it('never returns anything but a three-letter code, even for object property names', () => {
    for (const symbol of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(budgetCurrency(null, symbol)).toBe('USD');
    }
    fc.assert(
      fc.property(fc.string(), (symbol) => {
        expect(budgetCurrency(null, symbol)).toMatch(/^[A-Z]{3}$/);
      }),
    );
  });
});

describe('account currency helpers (property-based)', () => {
  it('an account in the budget currency (null) uses the budget currency', () => {
    fc.assert(
      fc.property(arbCode, (budget) => {
        expect(accountCurrency({ currency: null }, budget)).toBe(budget);
        expect(isForeignCurrency({ currency: null })).toBe(false);
      }),
    );
  });

  it('a foreign account keeps its own code', () => {
    fc.assert(
      fc.property(arbCode, arbCode, (budget, code) => {
        expect(accountCurrency({ currency: code }, budget)).toBe(code);
        expect(isForeignCurrency({ currency: code })).toBe(true);
      }),
    );
  });

  it('lists every offered code except the budget one, each once', () => {
    fc.assert(
      fc.property(
        fc.oneof(arbOfferedCode, arbCode),
        fc.oneof(fc.constant(null), arbOfferedCode, arbCode),
        (budget, current) => {
          const codes = otherCurrencyCodes(budget, current);
          expect(codes).not.toContain(budget);
          expect(new Set(codes).size).toBe(codes.length);
          for (const code of CURRENCY_CODES) {
            if (code !== budget) expect(codes).toContain(code);
          }
          // An account's own code stays selectable even when it isn't a common one
          if (current && current !== budget) expect(codes).toContain(current);
        },
      ),
    );
  });
});
