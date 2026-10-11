import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  amountFit,
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

describe('amountFit', () => {
  const amountTypes = ['exact', 'approximate', 'variable'] as const;
  // Expected amounts of either direction, and any amount
  const pair = fc
    .tuple(
      fc.integer({ min: 1, max: 1e7 }),
      fc.integer({ min: -1e7, max: 1e7 }),
      fc.constantFrom(1, -1),
    )
    .map(([expected, amount, sign]) => ({ expected: expected * sign, amount: amount * sign }));

  it('exact needs the exact amount, approximate within 10%, variable any amount in the same direction', () => {
    fc.assert(
      fc.property(pair, ({ expected, amount }) => {
        const off = Math.abs(amount - expected) / Math.abs(expected);
        const sameDirection = Math.sign(amount) === Math.sign(expected);
        expect(amountFit('exact', amount, expected) !== null).toBe(amount === expected);
        expect(amountFit('approximate', amount, expected) !== null).toBe(
          sameDirection && off <= 0.1,
        );
        expect(amountFit('variable', amount, expected) !== null).toBe(sameDirection);
      }),
    );
  });

  it('the expected amount is exact for every type; only a variable amount more than 25% off is loose', () => {
    fc.assert(
      fc.property(pair, fc.constantFrom(...amountTypes), ({ expected, amount }, type) => {
        const fit = amountFit(type, amount, expected);
        const off = Math.abs(amount - expected) / Math.abs(expected);
        if (amount === expected) expect(fit).toBe('exact');
        expect(fit === 'loose').toBe(
          type === 'variable' && Math.sign(amount) === Math.sign(expected) && off > 0.25,
        );
      }),
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

  it('a loose amount needs the payee or bank text to count; an exact or close one does not', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('exact', 'approximate', 'variable'),
        fc.integer({ min: -200_000, max: 200_000 }),
        fc.boolean(),
        (amountType, amount, recognized) => {
          const t = recognized
            ? tx({ amount })
            : tx({ amount, importedPayee: 'REFUND', payeeName: 'Shop' });
          const result = scoreMatch(
            t,
            { expectedDate: day(0), expectedAmount: 60_000 },
            schedule({ amountType }),
          );
          const fit = amountFit(amountType, amount, 60_000);
          expect(result.score > 0).toBe(fit !== null && (recognized || fit !== 'loose'));
          expect(result.payeeScore > 0).toBe(result.score > 0 && recognized);
        },
      ),
    );
  });

  it('a closer amount never scores lower', () => {
    const rank = { exact: 3, close: 2, loose: 1 };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.integer({ min: 1, max: 200_000 }),
        (a, b) => {
          const occ = { expectedDate: day(0), expectedAmount: 60_000 };
          const [fitA, fitB] = [a, b].map((amount) => amountFit('variable', amount, 60_000)!);
          const [scoreA, scoreB] = [a, b].map(
            (amount) => scoreMatch(tx({ amount }), occ, schedule()).score,
          );
          if (rank[fitA] >= rank[fitB]) expect(scoreA).toBeGreaterThanOrEqual(scoreB);
        },
      ),
    );
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
