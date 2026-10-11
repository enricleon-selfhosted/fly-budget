import type { BankDataSource } from '../bankSync/types.js';
import type { EnableBankingApi, PsuHeaders } from './client.js';
import { EnableBankingError } from './errors.js';
import { normalizeTransaction, pickBalance, withExternalIds } from './mapping.js';
import { transactionSchema } from './schemas.js';

/** Stops a bank that keeps returning continuation keys from looping forever */
const MAX_PAGES = 200;

export type DataSourceOptions = {
  psu?: PsuHeaders;
  /** Called with the number of entries that couldn't be read, for the log */
  onUnreadable?: (count: number) => void;
};

/** One Enable Banking account as a BankDataSource */
export function createEnableBankingDataSource(
  api: EnableBankingApi,
  accountUid: string,
  options: DataSourceOptions = {},
): BankDataSource {
  return {
    async fetchTransactions(since) {
      const raw: unknown[] = [];
      let continuationKey: string | undefined;
      for (let page = 0; ; page++) {
        // A partial read would leave a gap the next sync never fills: fail instead
        if (page === MAX_PAGES) throw new EnableBankingError('Too many pages of transactions');
        const res = await api.getTransactions(
          accountUid,
          { dateFrom: since, continuationKey },
          options.psu,
        );
        raw.push(...res.transactions);
        if (!res.continuationKey) break;
        continuationKey = res.continuationKey;
      }

      let unreadable = 0;
      const normalized = [];
      for (const entry of raw) {
        const parsed = transactionSchema.safeParse(entry);
        if (!parsed.success) {
          unreadable++;
          continue;
        }
        const tx = normalizeTransaction(parsed.data);
        if (tx && tx.date >= since) normalized.push(tx);
      }
      if (unreadable) options.onUnreadable?.(unreadable);
      return withExternalIds(normalized);
    },

    async fetchBalance() {
      return pickBalance(await api.getBalances(accountUid, options.psu));
    },
  };
}
