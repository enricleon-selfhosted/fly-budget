import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BankDataSource } from '../types.js';

// The contract every bank provider's BankDataSource must meet, as a reusable test suite.
// A provider test describes the bank's data in neutral terms (ContractFixture) and returns
// its data source serving that data the way its bank would; the suite only looks at what
// comes out of the interface. Run it with describeBankDataSource(name, make).

export type FixtureTransaction = {
  /** The bank's own id for the transaction, when it gives one */
  reference: string | null;
  date: string;
  /** Unsigned decimal, e.g. "12.30" */
  amount: string;
  direction: 'in' | 'out';
  counterparty: string | null;
  description: string | null;
  booked: boolean;
};

export type ContractFixture = {
  currency: string;
  /** Signed decimal, or null when the bank reports no balance */
  balance: string | null;
  transactions: FixtureTransaction[];
};

const day = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1) + offset * 864e5).toISOString().slice(0, 10);

/** Bank text, including what banks really send: control characters, padding, very long strings */
const bankText = fc.oneof(
  fc.constantFrom('MERCADONA', 'Bizum de Ana', 'TRANSFERENCIA A AHORRO', 'Amazon EU SARL'),
  fc.string({ maxLength: 30 }),
  fc.string({ unit: fc.constantFrom('a', ' ', '\n', '\t', '\u0007', 'ñ', '€'), maxLength: 400 }),
);

const fixtureTransaction = fc.record({
  reference: fc.option(fc.uuid(), { nil: null }),
  date: fc.integer({ min: 0, max: 120 }).map(day),
  amount: fc
    .tuple(fc.integer({ min: 0, max: 99_999 }), fc.integer({ min: 0, max: 99 }))
    .map(([whole, cents]) => `${whole}.${String(cents).padStart(2, '0')}`),
  direction: fc.constantFrom('in' as const, 'out' as const),
  counterparty: fc.option(bankText, { nil: null }),
  description: fc.option(bankText, { nil: null }),
  booked: fc.boolean(),
});

export const contractFixture: fc.Arbitrary<ContractFixture> = fc.record({
  currency: fc.constantFrom('EUR', 'SEK', 'PLN'),
  balance: fc.option(
    fc
      .integer({ min: -1e9, max: 1e9 })
      .map(
        (c) =>
          `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`,
      ),
    { nil: null },
  ),
  // Unique references, like a real bank's
  transactions: fc.uniqueArray(fixtureTransaction, {
    maxLength: 40,
    selector: (t) => t.reference ?? Symbol(),
  }),
});

const toCents = (amount: string, direction: 'in' | 'out') => {
  const [whole, frac] = amount.split('.');
  const cents = Number(whole) * 100 + Number(frac);
  return direction === 'out' ? -cents || 0 : cents;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

export function describeBankDataSource(
  name: string,
  make: (fixture: ContractFixture) => BankDataSource,
) {
  const runs = { numRuns: 60 };
  const since = fc.integer({ min: 0, max: 120 }).map(day);

  describe(`BankDataSource contract: ${name}`, () => {
    it('returns each booked transaction on or after the start date once, signed', async () => {
      await fc.assert(
        fc.asyncProperty(contractFixture, since, async (fixture, from) => {
          const got = await make(fixture).fetchTransactions(from);
          const key = (date: string, amount: number) => `${date} ${amount}`;
          const expected = fixture.transactions
            .filter((t) => t.booked && t.date >= from)
            .map((t) => key(t.date, toCents(t.amount, t.direction)))
            .sort();
          expect(got.map((t) => key(t.date, t.amount)).sort()).toEqual(expected);
        }),
        runs,
      );
    });

    it('gives ids that are unique and stay the same on every fetch, whatever the start date', async () => {
      await fc.assert(
        fc.asyncProperty(contractFixture, since, since, async (fixture, a, b) => {
          const [early, late] = a <= b ? [a, b] : [b, a];
          const source = make(fixture);
          const first = await source.fetchTransactions(early);
          const again = await source.fetchTransactions(early);
          const later = await source.fetchTransactions(late);

          const ids = first.map((t) => t.externalId);
          expect(new Set(ids).size).toBe(ids.length);
          expect(again.map((t) => t.externalId).sort()).toEqual([...ids].sort());
          const byId = new Map(first.map((t) => [t.externalId, t]));
          for (const t of later) expect(byId.get(t.externalId)).toEqual(t);
        }),
        runs,
      );
    });

    it('returns clean, bounded fields', async () => {
      await fc.assert(
        fc.asyncProperty(contractFixture, async (fixture) => {
          for (const t of await make(fixture).fetchTransactions(day(0))) {
            expect(t.externalId.length).toBeGreaterThan(0);
            expect(t.externalId.length).toBeLessThanOrEqual(300);
            expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isSafeInteger(t.amount)).toBe(true);
            expect(Object.is(t.amount, -0)).toBe(false);
            expect(t.currency).toBe(fixture.currency);
            for (const text of [t.payeeName, t.importedPayee]) {
              expect(text.length).toBeGreaterThan(0);
              expect(text.length).toBeLessThanOrEqual(200);
              expect(text).not.toMatch(CONTROL);
              expect(text).toBe(text.trim());
            }
            if (t.notes !== null) {
              expect(t.notes.length).toBeLessThanOrEqual(500);
              expect(t.notes).not.toMatch(CONTROL);
            }
          }
        }),
        runs,
      );
    });

    it('reports the balance in cents, or null when the bank has none', async () => {
      await fc.assert(
        fc.asyncProperty(contractFixture, async (fixture) => {
          const balance = await make(fixture).fetchBalance();
          if (fixture.balance === null) {
            expect(balance).toBeNull();
            return;
          }
          const negative = fixture.balance.startsWith('-');
          const cents = toCents(fixture.balance.replace('-', ''), negative ? 'out' : 'in');
          expect(balance).toMatchObject({ amount: cents, currency: fixture.currency });
        }),
        runs,
      );
    });
  });
}
