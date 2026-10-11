import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  accountName,
  consentValidUntil,
  ibanHash,
  maskIban,
  normalizeTransaction,
  pickBalance,
  suggestAccountType,
  withExternalIds,
} from './mapping.js';
import type { EbTransaction } from './schemas.js';

const tx = (over: Partial<EbTransaction> = {}): EbTransaction => ({
  entry_reference: 'ref-1',
  transaction_amount: { currency: 'EUR', amount: '12.30' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-03-10',
  creditor: { name: 'MERCADONA S.A.' },
  remittance_information: ['COMPRA TARJ. 1234', 'VALENCIA'],
  ...over,
});

describe('IBANs', () => {
  it('hash the same however the IBAN is spaced or cased, and are masked to the edges', () => {
    expect(ibanHash('es91 2100 0418 4502 0005 1332')).toBe(ibanHash('ES9121000418450200051332'));
    expect(ibanHash('ES91')).toBeNull();
    expect(maskIban('ES91 2100 0418 4502 0005 1332')).toBe('ES91 •••• 1332');
    expect(maskIban(null)).toBeNull();
  });
});

describe('normalizeTransaction', () => {
  it('signs amounts from the indicator, even when the bank signs them too', () => {
    expect(normalizeTransaction(tx())!.amount).toBe(-1230);
    expect(normalizeTransaction(tx({ credit_debit_indicator: 'CRDT' }))!.amount).toBe(1230);
    expect(
      normalizeTransaction(tx({ transaction_amount: { currency: 'EUR', amount: '-12.30' } }))!
        .amount,
    ).toBe(-1230);
  });

  it('takes the payee from the other party, the remittance text as notes', () => {
    expect(normalizeTransaction(tx())).toMatchObject({
      payeeName: 'MERCADONA S.A.',
      importedPayee: 'MERCADONA S.A.',
      notes: 'COMPRA TARJ. 1234 VALENCIA',
    });
    // Money in: the payer
    expect(
      normalizeTransaction(tx({ credit_debit_indicator: 'CRDT', debtor: { name: 'ACME NOMINA' } })),
    ).toMatchObject({ payeeName: 'ACME NOMINA' });
  });

  it('falls back to the remittance text, then the bank code, then "Unknown"', () => {
    expect(normalizeTransaction(tx({ creditor: null }))).toMatchObject({
      payeeName: 'COMPRA TARJ. 1234 VALENCIA',
      notes: null,
    });
    expect(
      normalizeTransaction(
        tx({
          creditor: null,
          remittance_information: null,
          bank_transaction_code: { description: 'Card fee' },
        }),
      ),
    ).toMatchObject({ payeeName: 'Card fee' });
    expect(
      normalizeTransaction(tx({ creditor: null, remittance_information: [] }))!.payeeName,
    ).toBe('Unknown');
  });

  it('skips what is not booked, or has no usable date or amount', () => {
    for (const status of ['PDNG', 'HOLD', 'CNCL', 'RJCT', 'SCHD', 'OTHR'])
      expect(normalizeTransaction(tx({ status }))).toBeNull();
    expect(normalizeTransaction(tx({ booking_date: '2026-02-30', value_date: null }))).toBeNull();
    expect(normalizeTransaction(tx({ booking_date: null, value_date: '2026-03-09' }))!.date).toBe(
      '2026-03-09',
    );
    expect(
      normalizeTransaction(tx({ transaction_amount: { currency: 'EUR', amount: '1e3' } })),
    ).toBeNull();
  });

  it('hashes the IBAN of the other side for transfer detection', () => {
    expect(
      normalizeTransaction(tx({ creditor_account: { iban: 'ES9121000418450200051332' } }))!
        .counterpartyAccountHash,
    ).toBe(ibanHash('ES9121000418450200051332'));
    expect(
      normalizeTransaction(
        tx({ credit_debit_indicator: 'CRDT', debtor_account: { iban: 'DE89370400440532013000' } }),
      )!.counterpartyAccountHash,
    ).toBe(ibanHash('DE89370400440532013000'));
  });
});

describe('withExternalIds', () => {
  it('uses the bank reference, else a content hash numbered for identical repeats', () => {
    const [withRef, a, b] = withExternalIds(
      [tx(), tx({ entry_reference: null }), tx({ entry_reference: null })].map((t) =>
        normalizeTransaction(t)!,
      ),
    );
    expect(withRef.externalId).toBe('ref:ref-1');
    expect(a.externalId).toMatch(/^hash:[0-9a-f]{32}:1$/);
    expect(b.externalId).toBe(a.externalId.replace(/:1$/, ':2'));
  });

  it('gives the same ids for the same data on every fetch', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ref: fc.option(fc.uuid(), { nil: null }),
            amount: fc.constantFrom('1.00', '2.50'),
            day: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 20 },
        ),
        (rows) => {
          const build = () =>
            withExternalIds(
              rows.map((r) =>
                normalizeTransaction(
                  tx({
                    entry_reference: r.ref,
                    transaction_amount: { currency: 'EUR', amount: r.amount },
                    booking_date: `2026-03-0${r.day}`,
                  }),
                )!,
              ),
            ).map((t) => t.externalId);
          expect(build()).toEqual(build());
        },
      ),
    );
  });
});

describe('pickBalance', () => {
  it('prefers booked balances, which match booked transactions', () => {
    const balance = (balance_type: string, amount: string) => ({
      balance_type,
      balance_amount: { currency: 'EUR', amount },
    });
    expect(pickBalance([balance('ITAV', '50.00'), balance('CLBD', '-12.34')])).toEqual({
      amount: -1234,
      currency: 'EUR',
      date: null,
    });
    expect(pickBalance([balance('XYZ', '1.00')])!.amount).toBe(100);
    expect(pickBalance([])).toBeNull();
    expect(pickBalance([balance('CLBD', 'n/a')])).toBeNull();
  });
});

describe('accounts and consents', () => {
  it('suggests an account type from the ISO cash account type', () => {
    expect(suggestAccountType('CACC')).toBe('checking');
    expect(suggestAccountType('SVGS')).toBe('savings');
    expect(suggestAccountType('CARD')).toBe('credit');
    expect(suggestAccountType('LOAN')).toBe('loan');
    expect(suggestAccountType(null)).toBe('checking');
  });

  it('names an account from what the bank gives', () => {
    const base = { identification_hash: 'h', currency: 'EUR' };
    expect(accountName({ ...base, name: ' Cuenta\nOnline ' })).toBe('Cuenta Online');
    expect(accountName({ ...base, account_id: { iban: 'ES9121000418450200051332' } })).toBe(
      'ES91 •••• 1332',
    );
    expect(accountName(base)).toBe('Bank account');
  });

  it('asks for consent as long as the bank allows, never more than 180 days', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const days = (iso: string) => (Date.parse(iso) - now) / 864e5;
    expect(days(consentValidUntil(90 * 86_400, now))).toBeCloseTo(90, 2);
    expect(days(consentValidUntil(365 * 86_400, now))).toBeCloseTo(180, 2);
    expect(days(consentValidUntil(null, now))).toBeLessThan(180);
  });
});
