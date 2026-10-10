// What every bank provider is translated into before FlyBudget imports it. Providers
// (services/enableBanking/, later Plaid and SimpleFIN) only turn their API into these
// types; deduplication, matching, rules and transfers happen in importTransactions.ts.
// See docs/enable-banking/architecture.md.

/** A booked bank transaction, normalized */
export type RemoteTransaction = {
  /** Stable within its account across fetches: the bank's own reference, else a content hash */
  externalId: string;
  /** Booking date, YYYY-MM-DD */
  date: string;
  /** Integer hundredths, signed: negative = money out */
  amount: number;
  /** ISO 4217 */
  currency: string;
  /** Who the money went to or came from, cleaned up for display ("Unknown" if the bank says nothing) */
  payeeName: string;
  /** The bank's own wording, kept so rules can match it after a rename */
  importedPayee: string;
  /** Free text from the bank (remittance information), if any */
  notes: string | null;
  /** SHA-256 of the other side's IBAN when the bank names it, to recognize transfers */
  counterpartyAccountHash: string | null;
};

/** What the bank says is in the account now */
export type RemoteBalance = {
  amount: number;
  currency: string;
  /** The day the balance refers to, if the bank says */
  date: string | null;
};

/** One bank account of one provider, ready to read */
export interface BankDataSource {
  /** Booked transactions on or after `since` (YYYY-MM-DD), in any order */
  fetchTransactions(since: string): Promise<RemoteTransaction[]>;
  /** The booked balance, or null if the bank doesn't report one */
  fetchBalance(): Promise<RemoteBalance | null>;
}

/** Where a batch of remote transactions goes */
export type ImportTarget = {
  /** The FlyBudget account */
  accountId: string;
  /** Prepended to each externalId to form `transactions.imported_id`, e.g. "enablebanking:<id>:" */
  importedIdPrefix: string;
  /** The bank account's currency: transactions in any other currency are skipped */
  currency: string;
};

export type ImportResult = {
  /** New transactions */
  added: number;
  /** Imports merged into a transaction the user had typed in */
  matched: number;
  /** New transactions linked to their other side in another account */
  transfers: number;
  /** Already imported earlier */
  duplicates: number;
  /** In another currency than the account's */
  otherCurrency: number;
};
