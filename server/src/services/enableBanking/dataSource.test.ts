import { describe, expect, it } from 'vitest';
import {
  describeBankDataSource,
  type ContractFixture,
} from '../bankSync/testing/bankDataSourceContract.js';
import type { EnableBankingApi } from './client.js';
import { createEnableBankingDataSource } from './dataSource.js';

// The Enable Banking data source must meet the same contract as every other provider. The
// fixture is served the way Enable Banking does: unsigned amounts with CRDT/DBIT, pending
// entries mixed in, pages joined by continuation keys, the date filter applied server-side.

function servedLikeEnableBanking(fixture: ContractFixture, pageSize = 7): EnableBankingApi {
  const raw = fixture.transactions.map((t) => ({
    entry_reference: t.reference,
    transaction_amount: { currency: fixture.currency, amount: t.amount },
    credit_debit_indicator: t.direction === 'out' ? 'DBIT' : 'CRDT',
    status: t.booked ? 'BOOK' : 'PDNG',
    booking_date: t.date,
    creditor: t.direction === 'out' ? { name: t.counterparty } : null,
    debtor: t.direction === 'in' ? { name: t.counterparty } : null,
    remittance_information: t.description === null ? null : [t.description],
  }));
  const unused = () => Promise.reject(new Error('not used by the data source'));
  return {
    getApplication: unused,
    listAspsps: unused,
    startAuthorization: unused,
    createSession: unused,
    getSessionAccounts: unused,
    deleteSession: unused,
    async getTransactions(_uid, { dateFrom, continuationKey }) {
      const matching = raw.filter((t) => t.booking_date >= dateFrom);
      const start = continuationKey ? Number(continuationKey) : 0;
      const next = start + pageSize;
      return {
        transactions: matching.slice(start, next),
        continuationKey: next < matching.length ? String(next) : null,
      };
    },
    async getBalances() {
      return fixture.balance === null
        ? []
        : [
            {
              balance_type: 'ITAV',
              balance_amount: { currency: fixture.currency, amount: '999.99' },
            },
            {
              balance_type: 'CLBD',
              balance_amount: { currency: fixture.currency, amount: fixture.balance },
            },
          ];
    },
  };
}

describeBankDataSource('Enable Banking', (fixture) =>
  createEnableBankingDataSource(servedLikeEnableBanking(fixture), 'account-uid'),
);

describe('Enable Banking data source specifics', () => {
  it('skips entries it cannot read and reports how many', async () => {
    const api = servedLikeEnableBanking({ currency: 'EUR', balance: null, transactions: [] });
    api.getTransactions = async () => ({
      transactions: [
        { not: 'a transaction' },
        {
          entry_reference: 'ok',
          transaction_amount: { currency: 'EUR', amount: '1.00' },
          credit_debit_indicator: 'CRDT',
          status: 'BOOK',
          booking_date: '2026-02-01',
        },
      ],
      continuationKey: null,
    });
    let unreadable = 0;
    const source = createEnableBankingDataSource(api, 'uid', {
      onUnreadable: (n) => (unreadable = n),
    });
    expect(await source.fetchTransactions('2026-01-01')).toHaveLength(1);
    expect(unreadable).toBe(1);
  });

  it('fails rather than importing part of an endless list', async () => {
    const api = servedLikeEnableBanking({ currency: 'EUR', balance: null, transactions: [] });
    api.getTransactions = async () => ({ transactions: [], continuationKey: 'again' });
    await expect(
      createEnableBankingDataSource(api, 'uid').fetchTransactions('2026-01-01'),
    ).rejects.toThrow(/Too many pages/);
  });

  it('passes the PSU headers on every request', async () => {
    const seen: unknown[] = [];
    const api = servedLikeEnableBanking({ currency: 'EUR', balance: '1.00', transactions: [] });
    const getTransactions = api.getTransactions;
    api.getTransactions = (uid, query, psu) => {
      seen.push(psu);
      return getTransactions(uid, query, psu);
    };
    const psu = { 'Psu-Ip-Address': '203.0.113.5', 'Psu-User-Agent': 'Firefox' };
    await createEnableBankingDataSource(api, 'uid', { psu }).fetchTransactions('2026-01-01');
    expect(seen).toEqual([psu]);
  });
});
