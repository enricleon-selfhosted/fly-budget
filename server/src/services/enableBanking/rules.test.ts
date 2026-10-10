import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { defaultSyncFrom, planMapping, syncFromAfter } from './accountMapping.js';
import { syncWindowStart } from './syncService.js';

// The pure rules behind account mapping (D9, D11) and sync windows (D9).

const day = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1) + offset * 864e5).toISOString().slice(0, 10);
const TODAY = day(200);

const currency = fc.constantFrom('EUR', 'USD', 'SEK');
const bank = (c: string) => ({ name: 'Cuenta', currency: c, cashAccountType: 'CACC' });

describe('planMapping', () => {
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
});
