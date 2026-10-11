import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  consentEnded,
  defaultSyncFrom,
  localDay,
  planMapping,
  shouldSkipBackgroundSync,
  syncFromAfter,
  syncWindowStart,
} from './rules.js';

// The pure rules behind account mapping (D9, D11) and syncing (D9, D10). They load no database.

const day = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1) + offset * 864e5).toISOString().slice(0, 10);
const TODAY = day(200);

const currency = fc.constantFrom('EUR', 'USD', 'SEK');
const bank = (c: string) => ({ name: 'Cuenta', currency: c, cashAccountType: 'CACC' });

describe('planMapping', () => {
  it('refuses to import an account the latest consent leaves out, and lets it be ignored', () => {
    const left = { ...bank('EUR'), inConsent: 0 };
    const context = { budgetCurrency: 'EUR', today: TODAY };
    expect(planMapping({ id: 'a', action: 'create' }, left, context)).toHaveProperty('error');
    expect(
      planMapping({ id: 'a', action: 'link', accountId: 'x' }, left, {
        ...context,
        target: { currency: null, closedAt: null, alreadyImportedBy: false },
      }),
    ).toHaveProperty('error');
    expect(planMapping({ id: 'a', action: 'skip' }, left, context)).toEqual({ action: 'skip' });
  });

  it('creates accounts in another currency off budget with that currency, others as asked', () => {
    fc.assert(
      fc.property(
        currency,
        currency,
        fc.constantFrom(0, 1, undefined),
        (bankCurrency, budget, offBudget) => {
          const plan = planMapping(
            { id: 'a', action: 'create', isOffBudget: offBudget },
            bank(bankCurrency),
            { budgetCurrency: budget, today: TODAY },
          );
          if ('error' in plan || plan.action !== 'create') throw new Error('expected a create');
          if (bankCurrency === budget) {
            expect(plan.account.currency).toBeNull();
            expect(plan.account.isOffBudget).toBe(offBudget ?? 0);
          } else {
            expect(plan.account).toMatchObject({ currency: bankCurrency, isOffBudget: 1 });
          }
        },
      ),
    );
  });

  it('links only into an open account in the same currency that nothing else imports into', () => {
    fc.assert(
      fc.property(
        currency,
        currency,
        fc.option(currency, { nil: null }),
        fc.boolean(),
        fc.boolean(),
        (bankCurrency, budget, targetCurrency, closed, taken) => {
          const plan = planMapping(
            { id: 'a', action: 'link', accountId: 'x' },
            bank(bankCurrency),
            {
              budgetCurrency: budget,
              today: TODAY,
              target: {
                currency: targetCurrency,
                closedAt: closed ? day(1) : null,
                alreadyImportedBy: taken,
              },
            },
          );
          const sameCurrency = (targetCurrency ?? budget) === bankCurrency;
          expect('error' in plan).toBe(closed || taken || !sameCurrency);
        },
      ),
    );
  });

  it('never accepts an import date in the future', () => {
    const plan = planMapping({ id: 'a', action: 'create', syncFrom: day(201) }, bank('EUR'), {
      budgetCurrency: 'EUR',
      today: TODAY,
    });
    expect(plan).toHaveProperty('error');
  });

  it('starts a linked account right after its newest imported transaction, never in the future', () => {
    expect(syncFromAfter(day(150), TODAY)).toBe(day(151));
    expect(syncFromAfter(TODAY, TODAY)).toBe(TODAY);
    expect(syncFromAfter(null, TODAY)).toBe(defaultSyncFrom(TODAY));
    expect(defaultSyncFrom(TODAY)).toBe(day(110));
  });
});

describe('syncWindowStart', () => {
  it('reads from the chosen date first, then 10 days before the last sync, never earlier than the chosen date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 199 }),
        fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
        (from, last) => {
          const start = syncWindowStart(
            day(from),
            last === null ? null : `${day(last)}T08:00:00.000Z`,
            TODAY,
          );
          if (last === null) expect(start).toBe(day(from));
          else expect(start).toBe(day(Math.max(from, last - 10)));
        },
      ),
    );
  });

  it('without a chosen date, starts where a new account’s history does', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), (offset) => {
        expect(syncWindowStart(null, null, day(offset))).toBe(defaultSyncFrom(day(offset)));
      }),
    );
  });
});

describe('when to sync', () => {
  const at = Date.parse('2026-03-20T10:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('a background sync skips a connection synced less than 6 hours ago, and runs at 6 hours', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 * BACKGROUND_SYNC_INTERVAL_MS }), (ago) => {
        expect(shouldSkipBackgroundSync(iso(at - ago), at)).toBe(ago < BACKGROUND_SYNC_INTERVAL_MS);
      }),
    );
    expect(shouldSkipBackgroundSync(iso(at - BACKGROUND_SYNC_INTERVAL_MS + 1), at)).toBe(true);
    expect(shouldSkipBackgroundSync(iso(at - BACKGROUND_SYNC_INTERVAL_MS), at)).toBe(false);
    expect(shouldSkipBackgroundSync(null, at)).toBe(false);
  });

  it('a consent has ended from the moment its access runs out', () => {
    fc.assert(
      fc.property(fc.integer({ min: -864e5, max: 864e5 }), (offset) => {
        expect(consentEnded(iso(at + offset), at)).toBe(offset <= 0);
      }),
    );
  });

  it('counts days in the server’s time zone', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4e12 }), (ms) => {
        const d = new Date(ms);
        const expected = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
          .map((n, i) => String(n).padStart(i ? 2 : 4, '0'))
          .join('-');
        expect(localDay(ms)).toBe(expected);
      }),
    );
  });
});
