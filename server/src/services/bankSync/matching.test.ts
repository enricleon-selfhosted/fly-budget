import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MATCH_WINDOW_DAYS,
  TRANSFER_WINDOW_DAYS,
  daysBetween,
  pickManualMatch,
  pickTransferCounterpart,
  type ManualCandidate,
  type TransferCandidate,
} from './matching.js';

const BASE = Date.parse('2026-03-01T00:00:00Z');
const day = (offset: number) => new Date(BASE + offset * 864e5).toISOString().slice(0, 10);

const manual = fc.record({
  id: fc.uuid(),
  offset: fc.integer({ min: -30, max: 30 }),
  amount: fc.constantFrom(-1234, -500, 500, 1234),
  created: fc.integer({ min: 0, max: 1000 }),
});
const toManual = (m: { id: string; offset: number; amount: number; created: number }) =>
  ({
    id: m.id,
    date: day(m.offset),
    amount: m.amount,
    createdAt: new Date(BASE + m.created * 1000).toISOString(),
  }) satisfies ManualCandidate;

describe('daysBetween', () => {
  it('is symmetric and counts calendar days, across month ends and leap days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -2000, max: 2000 }),
        (a, b) => {
          expect(daysBetween(day(a), day(b))).toBe(Math.abs(a - b));
          expect(daysBetween(day(a), day(b))).toBe(daysBetween(day(b), day(a)));
        },
      ),
    );
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('pickManualMatch', () => {
  it('picks a same-amount candidate within the window, the closest one, or nothing', () => {
    fc.assert(
      fc.property(
        fc.array(manual, { maxLength: 12 }),
        fc.constantFrom(-1234, 500),
        (raw, amount) => {
          const candidates = raw.map(toManual);
          const picked = pickManualMatch({ date: day(0), amount }, candidates);
          const valid = candidates.filter(
            (c) => c.amount === amount && daysBetween(c.date, day(0)) <= MATCH_WINDOW_DAYS,
          );
          if (!valid.length) {
            expect(picked).toBeNull();
            return;
          }
          const chosen = candidates.find((c) => c.id === picked)!;
          expect(valid).toContain(chosen);
          const closest = Math.min(...valid.map((c) => daysBetween(c.date, day(0))));
          expect(daysBetween(chosen.date, day(0))).toBe(closest);
        },
      ),
    );
  });

  it('does not depend on the order candidates come in', () => {
    const listAndShuffled = fc
      .uniqueArray(manual, { selector: (m) => m.id, maxLength: 10 })
      .chain((raw) =>
        fc.tuple(
          fc.constant(raw),
          fc.shuffledSubarray(raw, { minLength: raw.length, maxLength: raw.length }),
        ),
      );
    fc.assert(
      fc.property(listAndShuffled, ([raw, shuffled]) => {
        expect(pickManualMatch({ date: day(0), amount: 500 }, shuffled.map(toManual))).toBe(
          pickManualMatch({ date: day(0), amount: 500 }, raw.map(toManual)),
        );
      }),
    );
  });

  it('prefers the older row when two are equally close', () => {
    const older = { id: 'b', date: day(-2), amount: 500, createdAt: '2026-01-01T00:00:00Z' };
    const newer = { id: 'a', date: day(2), amount: 500, createdAt: '2026-02-01T00:00:00Z' };
    expect(pickManualMatch({ date: day(0), amount: 500 }, [newer, older])).toBe('b');
  });
});

const transfer = fc.record({
  id: fc.uuid(),
  accountId: fc.constantFrom('A', 'B', 'C'),
  offset: fc.integer({ min: -8, max: 8 }),
  amount: fc.constantFrom(-1000, 1000, 2000),
});
const toTransfer = (t: { id: string; accountId: string; offset: number; amount: number }) =>
  ({
    id: t.id,
    accountId: t.accountId,
    currency: null,
    date: day(t.offset),
    amount: t.amount,
  }) satisfies TransferCandidate;

describe('pickTransferCounterpart', () => {
  const query = (
    over: Partial<Parameters<typeof pickTransferCounterpart>[0]> = {},
  ): Parameters<typeof pickTransferCounterpart>[0] => ({
    accountId: 'A',
    currency: null,
    date: day(0),
    amount: -1000,
    counterpartyAccountId: null,
    siblings: 0,
    ...over,
  });

  it('only ever picks an opposite amount in another account within the window', () => {
    fc.assert(
      fc.property(
        fc.array(transfer, { maxLength: 12 }),
        fc.constantFrom(null, 'B', 'C'),
        fc.nat(2),
        (raw, named, siblings) => {
          const candidates = raw.map(toTransfer);
          const picked = pickTransferCounterpart(
            query({ counterpartyAccountId: named, siblings }),
            candidates,
          );
          if (picked === null) return;
          const c = candidates.find((x) => x.id === picked)!;
          expect(c.accountId).not.toBe('A');
          expect(c.amount).toBe(1000);
          expect(daysBetween(c.date, day(0))).toBeLessThanOrEqual(TRANSFER_WINDOW_DAYS);
          if (named) expect(c.accountId).toBe(named);
        },
      ),
    );
  });

  it('without the bank naming the account, links only an unambiguous pair', () => {
    fc.assert(
      fc.property(fc.array(transfer, { maxLength: 12 }), fc.nat(2), (raw, siblings) => {
        const candidates = raw.map(toTransfer);
        const eligible = candidates.filter(
          (c) =>
            c.accountId !== 'A' &&
            c.amount === 1000 &&
            daysBetween(c.date, day(0)) <= TRANSFER_WINDOW_DAYS,
        );
        const picked = pickTransferCounterpart(query({ siblings }), candidates);
        expect(picked).toBe(eligible.length === 1 && siblings === 0 ? eligible[0].id : null);
      }),
    );
  });

  it('never pairs accounts in different currencies, even when the bank names the account', () => {
    const currency = fc.constantFrom(null, 'USD', 'GBP');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(transfer, currency), { maxLength: 12 }),
        currency,
        fc.constantFrom(null, 'B', 'C'),
        fc.nat(2),
        (raw, own, named, siblings) => {
          const candidates = raw.map(([t, c]) => ({ ...toTransfer(t), currency: c }));
          const picked = pickTransferCounterpart(
            query({ currency: own, counterpartyAccountId: named, siblings }),
            candidates,
          );
          if (picked !== null) expect(candidates.find((c) => c.id === picked)!.currency).toBe(own);
        },
      ),
    );
    // The only opposite amount, in the very account the bank names, but in another currency
    const usd = { id: 'u', accountId: 'B', currency: 'USD', date: day(0), amount: 1000 };
    expect(pickTransferCounterpart(query({ counterpartyAccountId: 'B' }), [usd])).toBeNull();
    expect(pickTransferCounterpart(query(), [usd])).toBeNull();
    expect(pickTransferCounterpart(query({ currency: 'USD' }), [usd])).toBe('u');
  });

  it('when the bank names the account, never pairs with another account', () => {
    const inC = { id: 'c1', accountId: 'C', currency: null, date: day(0), amount: 1000 };
    expect(pickTransferCounterpart(query({ counterpartyAccountId: 'B' }), [inC])).toBeNull();
  });

  it('when the bank names the account, takes its closest candidate even among several', () => {
    const near = { id: 'near', accountId: 'B', currency: null, date: day(1), amount: 1000 };
    const far = { id: 'far', accountId: 'B', currency: null, date: day(3), amount: 1000 };
    const other = { id: 'other', accountId: 'C', currency: null, date: day(0), amount: 1000 };
    expect(
      pickTransferCounterpart(query({ counterpartyAccountId: 'B', siblings: 1 }), [
        far,
        other,
        near,
      ]),
    ).toBe('near');
    const tie = { id: 'tie', accountId: 'B', currency: null, date: day(-1), amount: 1000 };
    expect(pickTransferCounterpart(query({ counterpartyAccountId: 'B' }), [near, tie])).toBeNull();
  });

  it('never pairs a zero amount', () => {
    const zero = { id: 'z', accountId: 'B', currency: null, date: day(0), amount: 0 };
    expect(pickTransferCounterpart(query({ amount: 0 }), [zero])).toBeNull();
  });
});
