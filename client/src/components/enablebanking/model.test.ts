import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Account, EnableBankingAccount } from '../../types';
import {
  EEA_COUNTRIES,
  RENEW_WARNING_DAYS,
  accessLeft,
  accessStatus,
  accountsToMapAfterConsent,
  bankCurrency,
  daysAgoIso,
  defaultCountry,
  defaultOffBudget,
  describeSync,
  initialMappingRow,
  isHttpsUrl,
  linkOptions,
  mappingAction,
  psuOptions,
  stepAfterConsent,
  stepAfterMapping,
  withAction,
  withLinkedAccount,
} from './model';

// 10 October 2026, midday, local time (the clock is passed in, never read)
const NOW = new Date(2026, 9, 10, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

function bankAccount(overrides: Partial<EnableBankingAccount> = {}): EnableBankingAccount {
  return {
    id: 'bank-1',
    name: 'Cuenta Online',
    ibanMask: 'ES12 •••• 3456',
    currency: null,
    cashAccountType: 'CACC',
    suggestedType: 'checking',
    accountId: null,
    accountName: null,
    isEnabled: true,
    syncFrom: null,
    bankBalance: null,
    bankBalanceAt: null,
    balance: null,
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'Checking',
    type: 'checking',
    startingBalance: 0,
    isOffBudget: 0,
    sortOrder: 0,
    closedAt: null,
    logo: null,
    currency: null,
    createdAt: '2026-01-01T00:00:00Z',
    balance: 0,
    ...overrides,
  };
}

describe('defaultCountry', () => {
  it('uses the region of the browser language when Enable Banking covers it', () => {
    expect(defaultCountry('de-DE')).toBe('DE');
    expect(defaultCountry('fr-FR')).toBe('FR');
    expect(defaultCountry('pt-PT')).toBe('PT');
  });

  it('falls back to Spain for other regions, bare languages and no language', () => {
    expect(defaultCountry('en-US')).toBe('ES');
    expect(defaultCountry('de')).toBe('ES');
    expect(defaultCountry('zh-Hant-TW')).toBe('ES');
    expect(defaultCountry(undefined)).toBe('ES');
  });

  it('always returns a country in the list, whatever the language string', () => {
    const codes = new Set(EEA_COUNTRIES.map((c) => c.code));
    fc.assert(fc.property(fc.string(), (language) => codes.has(defaultCountry(language))));
  });
});

describe('initialMappingRow', () => {
  it('preselects the existing account of an account already imported', () => {
    const row = initialMappingRow(
      bankAccount({ accountId: 'local-1', accountName: 'Old', syncFrom: '2026-07-12' }),
      'EUR',
      NOW,
    );
    expect(row.action).toBe('link');
    expect(row.accountId).toBe('local-1');
    expect(row.syncFrom).toBe('2026-07-12');
  });

  it("doesn't import an ignored account", () => {
    expect(initialMappingRow(bankAccount({ isEnabled: false }), 'EUR', NOW).action).toBe('skip');
  });

  it('imports a new account as a new one, 90 days back, on budget for a checking account', () => {
    const row = initialMappingRow(bankAccount(), 'EUR', NOW);
    expect(row).toMatchObject({
      action: 'create',
      name: 'Cuenta Online',
      type: 'checking',
      offBudget: false,
      syncFrom: '2026-07-12',
    });
  });

  it('keeps investment-type accounts off budget', () => {
    const row = initialMappingRow(bankAccount({ suggestedType: 'investment' }), 'EUR', NOW);
    expect(row.offBudget).toBe(true);
  });

  it('keeps an account in another currency off budget', () => {
    const row = initialMappingRow(bankAccount({ currency: 'USD' }), 'EUR', NOW);
    expect(row.offBudget).toBe(true);
    expect(bankCurrency(bankAccount({ currency: 'USD' }), 'EUR')).toBe('USD');
    expect(bankCurrency(bankAccount(), 'EUR')).toBe('EUR');
  });
});

describe('defaultOffBudget', () => {
  it('is on budget only for cash and credit types, unless the currency is foreign', () => {
    expect(defaultOffBudget('savings', false)).toBe(false);
    expect(defaultOffBudget('credit', false)).toBe(false);
    expect(defaultOffBudget('mortgage', false)).toBe(true);
    expect(defaultOffBudget('checking', true)).toBe(true);
  });
});

describe('mappingAction', () => {
  it('sends a skip with no details', () => {
    const acc = bankAccount();
    const row = initialMappingRow(acc, 'EUR', NOW);
    expect(mappingAction(acc, { ...row, action: 'skip' }, 'EUR')).toEqual({
      id: 'bank-1',
      action: 'skip',
    });
  });

  it('needs a name for a new account and trims it', () => {
    const acc = bankAccount();
    const row = initialMappingRow(acc, 'EUR', NOW);
    expect(mappingAction(acc, { ...row, name: '   ' }, 'EUR')).toBeNull();
    expect(mappingAction(acc, { ...row, name: '  Main  ' }, 'EUR')).toMatchObject({
      action: 'create',
      accountName: 'Main',
      isOffBudget: 0,
      syncFrom: '2026-07-12',
    });
  });

  it('sends 1 for off budget, and forces it for another currency', () => {
    const acc = bankAccount({ currency: 'USD' });
    const row = initialMappingRow(acc, 'EUR', NOW);
    expect(mappingAction(acc, row, 'EUR')).toMatchObject({ isOffBudget: 1 });
  });

  it('needs an existing account to link to, and leaves the date to the server when empty', () => {
    const acc = bankAccount();
    const row = initialMappingRow(acc, 'EUR', NOW);
    const linking = withAction(row, acc, 'link', NOW);
    expect(mappingAction(acc, linking, 'EUR')).toBeNull();
    expect(mappingAction(acc, { ...linking, accountId: 'acc-9' }, 'EUR')).toEqual({
      id: 'bank-1',
      action: 'link',
      accountId: 'acc-9',
      syncFrom: undefined,
    });
  });
});

describe('withAction and withLinkedAccount', () => {
  it('starts a new account 90 days back when switching to create from a link', () => {
    const acc = bankAccount({ accountId: 'local-1', syncFrom: '2026-09-01' });
    const linked = initialMappingRow(acc, 'EUR', NOW);
    expect(withAction(linked, acc, 'create', NOW).syncFrom).toBe('2026-07-12');
  });

  it("shows an imported account's own start date when it is picked again", () => {
    const acc = bankAccount({ accountId: 'local-1', syncFrom: '2026-09-01' });
    const ignored = initialMappingRow(bankAccount({ isEnabled: false }), 'EUR', NOW);
    const linking = withAction(ignored, acc, 'link', NOW);
    expect(linking.accountId).toBe('');
    expect(linking.syncFrom).toBe('');
    expect(withLinkedAccount(linking, acc, 'local-1').syncFrom).toBe('2026-09-01');
    expect(withLinkedAccount(linking, acc, 'local-2').syncFrom).toBe('');
  });
});

describe('linkOptions', () => {
  const budget = 'EUR';
  const accounts = [
    account({ id: 'open-eur' }),
    account({ id: 'closed-eur', closedAt: '2026-01-01T00:00:00Z' }),
    account({ id: 'usd', currency: 'USD' }),
    account({ id: 'taken-eur' }),
  ];

  it('lists open accounts in the same currency that no other row has picked', () => {
    const ids = linkOptions(accounts, 'EUR', budget, new Set(['taken-eur']), '').map((a) => a.id);
    expect(ids).toEqual(['open-eur']);
  });

  it('keeps the account the row already picked, even when closed or taken', () => {
    const ids = linkOptions(accounts, 'EUR', budget, new Set(['taken-eur']), 'closed-eur').map(
      (a) => a.id,
    );
    expect(ids).toEqual(['open-eur', 'closed-eur']);
  });

  it('matches the bank currency, not the budget', () => {
    const ids = linkOptions(accounts, 'USD', budget, new Set(), '').map((a) => a.id);
    expect(ids).toEqual(['usd']);
  });
});

describe('accessLeft', () => {
  it('counts whole days left', () => {
    const validUntil = new Date(NOW.getTime() + 10.5 * DAY_MS).toISOString();
    expect(accessLeft(validUntil, NOW)).toEqual({ expired: false, days: 10 });
  });

  it('is expired once the end has passed', () => {
    const validUntil = new Date(NOW.getTime() - DAY_MS).toISOString();
    expect(accessLeft(validUntil, NOW)).toEqual({ expired: true, days: -1 });
  });

  it('is unknown for an invalid date', () => {
    expect(accessLeft('not a date', NOW)).toBeNull();
  });
});

describe('accessStatus', () => {
  const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
  const syncStatus = fc.constantFrom('good', 'syncing', 'error', 'reauth_required') as fc.Arbitrary<
    'good' | 'syncing' | 'error' | 'reauth_required'
  >;

  it('says until when access lasts, and warns in the last two weeks', () => {
    expect(accessStatus({ validUntil: inDays(60.25), syncStatus: 'good' }, NOW)).toMatchObject({
      daysLeft: 60,
      expired: false,
      expiresSoon: false,
      renewNeeded: false,
      text: 'Access until Dec 9, 2026',
    });
    expect(accessStatus({ validUntil: inDays(3.25), syncStatus: 'good' }, NOW)).toMatchObject({
      expiresSoon: true,
      renewNeeded: true,
      text: 'Access until Oct 13, 2026 (3 days left)',
    });
    expect(accessStatus({ validUntil: inDays(0.25), syncStatus: 'good' }, NOW).text).toBe(
      'Access until Oct 10, 2026 (ends today)',
    );
  });

  it('says when access ended', () => {
    expect(accessStatus({ validUntil: inDays(-2), syncStatus: 'good' }, NOW)).toMatchObject({
      expired: true,
      expiresSoon: false,
      renewNeeded: true,
      text: 'Access ended Oct 8, 2026',
    });
  });

  it('says nothing about an end date that is not a valid time, unless the bank asks to renew', () => {
    expect(accessStatus({ validUntil: 'not a date', syncStatus: 'good' }, NOW)).toEqual({
      daysLeft: null,
      expired: false,
      expiresSoon: false,
      renewNeeded: false,
      text: null,
    });
    expect(
      accessStatus({ validUntil: 'not a date', syncStatus: 'reauth_required' }, NOW).renewNeeded,
    ).toBe(true);
  });

  it('needs a renewal exactly when the bank asks, access ended, or it ends soon', () => {
    fc.assert(
      fc.property(fc.double({ min: -400, max: 400, noNaN: true }), syncStatus, (days, status) => {
        const access = accessStatus({ validUntil: inDays(days), syncStatus: status }, NOW);
        const left = accessLeft(inDays(days), NOW)!;
        expect(access.daysLeft).toBe(left.days);
        expect(access.expired).toBe(left.expired);
        expect(access.expiresSoon).toBe(!left.expired && left.days < RENEW_WARNING_DAYS);
        expect(access.renewNeeded).toBe(
          status === 'reauth_required' || access.expired || access.expiresSoon,
        );
        expect(access.expired && access.expiresSoon).toBe(false);
        expect(access.text).not.toBeNull();
      }),
    );
  });
});

describe('after consent', () => {
  const shared = [
    bankAccount({ id: 'imported', accountId: 'local-1' }),
    bankAccount({ id: 'ignored', isEnabled: false }),
    bankAccount({ id: 'new' }),
  ];

  it('asks about every account of a new connection', () => {
    expect(accountsToMapAfterConsent(shared, false).map((a) => a.id)).toEqual([
      'imported',
      'ignored',
      'new',
    ]);
  });

  it('asks a renewal only about accounts the bank added since', () => {
    expect(accountsToMapAfterConsent(shared, true).map((a) => a.id)).toEqual(['new']);
  });

  it('a renewal never asks about an account already imported or ignored', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            accountId: fc.option(fc.constant('local-1'), { nil: null }),
            isEnabled: fc.boolean(),
          }),
          { maxLength: 10 },
        ),
        (rows) => {
          const accounts = rows.map((r, i) => bankAccount({ ...r, id: `bank-${i}` }));
          const toMap = accountsToMapAfterConsent(accounts, true);
          for (const a of toMap) expect(a.accountId === null && a.isEnabled).toBe(true);
          expect(toMap.length).toBe(
            accounts.filter((a) => a.accountId === null && a.isEnabled).length,
          );
          expect(accountsToMapAfterConsent(accounts, false)).toEqual(accounts);
        },
      ),
    );
  });

  it('maps accounts when there are some; otherwise a renewal syncs and a new connection ends', () => {
    expect(stepAfterConsent(2, false)).toBe('accounts');
    expect(stepAfterConsent(1, true)).toBe('accounts');
    expect(stepAfterConsent(0, true)).toBe('sync');
    expect(stepAfterConsent(0, false)).toBe('done');
  });
});

describe('stepAfterMapping', () => {
  it('syncs once something was imported, and a renewal always syncs', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.boolean(),
        (created, linked, renewing) => {
          expect(stepAfterMapping({ created, linked }, renewing)).toBe(
            created + linked > 0 || renewing ? 'sync' : 'done',
          );
        },
      ),
    );
  });

  it('ends a new connection where nothing was imported', () => {
    expect(stepAfterMapping({ created: 0, linked: 0 }, false)).toBe('done');
    expect(stepAfterMapping({ created: 0, linked: 0 }, true)).toBe('sync');
  });
});

describe('describeSync', () => {
  it('lists only the kinds that happened', () => {
    expect(describeSync({ added: 1, matched: 0, transfers: 0 })).toEqual([
      '1 new transaction imported',
    ]);
    expect(describeSync({ added: 0, matched: 3, transfers: 2 })).toEqual([
      '0 new transactions imported',
      '3 transactions matched to ones you entered',
      '2 transfers linked between your accounts',
    ]);
  });

  it('says how many transactions were matched to recurring items', () => {
    expect(describeSync({ added: 2, matched: 0, transfers: 0, recurring: 1 })).toEqual([
      '2 new transactions imported',
      '1 transaction matched to a recurring item',
    ]);
    expect(describeSync({ added: 2, matched: 1, transfers: 0, recurring: 3 })).toEqual([
      '2 new transactions imported',
      '1 transaction matched to ones you entered',
      '3 transactions matched to recurring items',
    ]);
  });

  it('leaves the recurring line out when there are none, or the result predates it', () => {
    expect(describeSync({ added: 2, matched: 0, transfers: 0, recurring: 0 })).toEqual([
      '2 new transactions imported',
    ]);
    expect(describeSync({ added: 2, matched: 0, transfers: 0 })).toEqual([
      '2 new transactions imported',
    ]);
  });

  it('gives one recurring line for any count, in the same place', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (added, matched, recurring) => {
          const lines = describeSync({ added, matched, transfers: 0, recurring });
          const found = lines.filter((line) => line.includes('recurring'));
          expect(found).toHaveLength(recurring > 0 ? 1 : 0);
          if (recurring > 0) {
            expect(found[0].startsWith(`${recurring} transaction`)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('psuOptions', () => {
  it('offers the types the bank lists, personal first, and personal when it lists none', () => {
    expect(psuOptions(['personal', 'business'])).toEqual(['personal', 'business']);
    expect(psuOptions(['business'])).toEqual(['business']);
    expect(psuOptions([])).toEqual(['personal']);
    expect(psuOptions(['personal', 'personal', 'business'])).toEqual(['personal', 'business']);
    expect(psuOptions(['business', 'personal'])).toEqual(['personal', 'business']);
    expect(psuOptions(['corporate'])).toEqual(['personal']);
  });
});

describe('daysAgoIso and isHttpsUrl', () => {
  it('counts calendar days back as YYYY-MM-DD', () => {
    expect(daysAgoIso(90, NOW)).toBe('2026-07-12');
    expect(daysAgoIso(0, NOW)).toBe('2026-10-10');
  });

  it('accepts only https addresses', () => {
    expect(isHttpsUrl('https://localhost/flybudget-callback')).toBe(true);
    expect(isHttpsUrl('  HTTPS://example.com/cb')).toBe(true);
    expect(isHttpsUrl('http://127.0.0.1:3001/api/enablebanking/callback')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});
