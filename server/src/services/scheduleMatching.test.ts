import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  amountScore,
  pickImportMatches,
  scoreMatch,
  textMatches,
  type ImportedTransaction,
  type MatchSchedule,
  type PendingOccurrence,
} from './scheduleMatching.js';

const day = (offset: number) =>
  new Date(Date.UTC(2026, 2, 10) + offset * 864e5).toISOString().slice(0, 10);

const schedule = (over: Partial<MatchSchedule> = {}): MatchSchedule => ({
  amount: 60_000,
  amountType: 'variable',
  dateFlexibility: 3,
  payeeId: null,
  accountId: 'gbp',
  name: 'Weekly pay',
  matchText: 'ACME LTD',
  ...over,
});
const tx = (over: Partial<ImportedTransaction> = {}): ImportedTransaction => ({
  id: 't1',
  date: day(0),
  amount: 61_234,
  payeeId: null,
  payeeName: 'Acme Ltd',
  importedPayee: 'FASTER PAYMENT ACME LTD REF 0042',
  notes: null,
  accountId: 'gbp',
  ...over,
});

describe('amountScore', () => {
  it('exact needs the exact amount, approximate within 10%, variable any amount in the same direction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e7 }),
        fc.integer({ min: -1e7, max: 1e7 }),
        (expected, amount) => {
          const exact = amountScore('exact', amount, expected);
          const approx = amountScore('approximate', amount, expected);
          const variable = amountScore('variable', amount, expected);
          expect(exact > 0).toBe(amount === expected);
          expect(approx > 0).toBe(amount > 0 && Math.abs(amount - expected) / expected <= 0.1);
          expect(variable > 0).toBe(amount > 0);
          // Closer never scores lower
          expect(variable).toBeGreaterThanOrEqual(amount === expected ? 30 : 0);
        },
      ),
    );
  });
});

describe('textMatches', () => {
  it('looks for the text in the bank text, payee and notes, ignoring case', () => {
    expect(textMatches(tx(), 'acme ltd')).toBe(true);
    expect(
      textMatches(tx({ importedPayee: null, payeeName: 'x', notes: 'Ref ACME LTD' }), 'Acme'),
    ).toBe(true);
    expect(textMatches(tx(), 'GLOBEX')).toBe(false);
    expect(textMatches(tx(), '  ')).toBe(false);
  });
});

describe('scoreMatch', () => {
  it('a weekly pay of varying amount is recognized by its bank text', () => {
    const { score, payeeScore } = scoreMatch(
      tx(),
      { expectedDate: day(1), expectedAmount: 60_000 },
      schedule(),
    );
    expect(payeeScore).toBe(25);
    expect(score).toBeGreaterThan(40);
  });

  it('a variable amount far from the usual needs the payee or bank text', () => {
    const occ = { expectedDate: day(0), expectedAmount: 60_000 };
    const stranger = tx({ importedPayee: 'REFUND', payeeName: 'Shop', amount: 20_000 });
    expect(scoreMatch(stranger, occ, schedule()).score).toBe(0);
    // Within 25% it can still be suggested on the date and account alone
    expect(scoreMatch({ ...stranger, amount: 55_000 }, occ, schedule()).score).toBeGreaterThan(0);
  });

  it('never matches outside the date flexibility or in the other direction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 10 }),
        fc.integer({ min: 0, max: 5 }),
        (offset, flex) => {
          const result = scoreMatch(
            tx({ date: day(offset) }),
            { expectedDate: day(0), expectedAmount: 60_000 },
            schedule({ dateFlexibility: flex }),
          );
          if (Math.abs(offset) > flex) expect(result.score).toBe(0);
        },
      ),
    );
    expect(
      scoreMatch(
        tx({ amount: -61_234 }),
        { expectedDate: day(0), expectedAmount: 60_000 },
        schedule(),
      ).score,
    ).toBe(0);
  });
});

describe('pickImportMatches', () => {
  const occ = (
    id: string,
    offset: number,
    over: Partial<MatchSchedule> = {},
  ): PendingOccurrence => ({
    id,
    expectedDate: day(offset),
    expectedAmount: 60_000,
    schedule: schedule(over),
  });

  it('matches one-to-one only, recognized by payee or bank text, in the same account', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            offset: fc.integer({ min: -5, max: 5 }),
            text: fc.constantFrom('ACME LTD PAY', 'OTHER'),
          }),
          { maxLength: 5 },
        ),
        fc.array(
          fc.record({
            offset: fc.integer({ min: -5, max: 5 }),
            account: fc.constantFrom('gbp', 'eur'),
          }),
          { maxLength: 4 },
        ),
        (rawTxs, rawOccs) => {
          const txs = rawTxs.map((t, i) =>
            tx({ id: `t${i}`, date: day(t.offset), importedPayee: t.text, payeeName: t.text }),
          );
          const occs = rawOccs.map((o, i) => occ(`o${i}`, o.offset, { accountId: o.account }));
          const matches = pickImportMatches(txs, occs);
          const txIds = matches.map((m) => m.transactionId);
          const occIds = matches.map((m) => m.occurrenceId);
          expect(new Set(txIds).size).toBe(txIds.length);
          expect(new Set(occIds).size).toBe(occIds.length);
          for (const m of matches) {
            const t = txs.find((x) => x.id === m.transactionId)!;
            const o = occs.find((x) => x.id === m.occurrenceId)!;
            expect(o.schedule.accountId).toBe(t.accountId);
            expect(t.importedPayee).toContain('ACME LTD');
          }
        },
      ),
    );
  });

  it('leaves it to the user when two occurrences could be the one', () => {
    expect(pickImportMatches([tx()], [occ('a', 0)])).toHaveLength(1);
    expect(pickImportMatches([tx()], [occ('a', -1), occ('b', 1)])).toEqual([]);
  });
});
