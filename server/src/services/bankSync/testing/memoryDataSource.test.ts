import { createHash } from 'crypto';
import type { BankDataSource, RemoteTransaction } from '../types.js';
import { describeBankDataSource, type ContractFixture } from './bankDataSourceContract.js';

// The simplest data source that meets the contract: checks the contract suite itself, and
// shows what a provider has to do.

const clean = (s: string | null, max: number) =>
  (s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();

function memoryDataSource(fixture: ContractFixture): BankDataSource {
  const cents = (amount: string) => {
    const negative = amount.startsWith('-');
    const [whole, frac] = amount.replace('-', '').split('.');
    const value = Number(whole) * 100 + Number(frac);
    return negative ? -value || 0 : value;
  };
  return {
    async fetchTransactions(since) {
      return fixture.transactions
        .filter((t) => t.booked && t.date >= since)
        .map((t): RemoteTransaction => {
          const text = clean(t.counterparty, 200) || clean(t.description, 200) || 'Unknown';
          const content = createHash('sha256')
            .update(JSON.stringify([t.date, t.amount, t.direction, t.counterparty, t.description]))
            .digest('hex');
          return {
            externalId: t.reference ?? content,
            date: t.date,
            amount: t.direction === 'out' ? -cents(t.amount) || 0 : cents(t.amount),
            currency: fixture.currency,
            payeeName: text,
            importedPayee: text,
            notes: clean(t.description, 500) || null,
            counterpartyAccountHash: null,
          };
        });
    },
    async fetchBalance() {
      return fixture.balance === null
        ? null
        : { amount: cents(fixture.balance), currency: fixture.currency, date: null };
    },
  };
}

describeBankDataSource('in-memory reference', (fixture) =>
  memoryDataSource({
    ...fixture,
    // The toy version can't tell identical unreferenced transactions apart: give them references
    transactions: fixture.transactions.map((t, i) => ({ ...t, reference: t.reference ?? `r${i}` })),
  }),
);
