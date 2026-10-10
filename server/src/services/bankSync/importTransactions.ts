import { createSqliteImportStore, type ImportStore } from './importStore.js';
import {
  EXCHANGE_WINDOW_DAYS,
  MATCH_WINDOW_DAYS,
  TRANSFER_WINDOW_DAYS,
  looksLikeExchange,
  pickExchangeCounterpart,
  pickManualMatch,
  pickTransferCounterpart,
} from './matching.js';
import type { ImportResult, ImportTarget, RemoteTransaction } from './types.js';

export type ImportContext = {
  /** SHA-256 of an IBAN → the user's account it belongs to, to recognize transfers */
  ownAccountsByIbanHash?: ReadonlyMap<string, string>;
  /** The user's other accounts at the same bank, with their currencies, to recognize exchanges */
  exchangePartners?: ReadonlyMap<string, string>;
  store?: ImportStore;
};

/**
 * Imports one account's bank transactions the way YNAB does (decisions D5, D6):
 *
 * 1. skip what was imported before (same imported id);
 * 2. merge into a transaction the user typed in (same amount, close date) instead of adding;
 * 3. otherwise add it, with rules and payees, through insertNewTransaction;
 * 4. then link each new transaction to its other side when money moved between the user's
 *    own accounts — or was changed into another currency at the same bank (D27; counted in
 *    `transfers`). This runs after every new row of the batch is in, so a second transaction
 *    of the same amount in this batch makes the pairing ambiguous rather than a guess;
 * 5. and match new transactions to recurring items where it's clear (D29).
 */
export function importTransactions(
  target: ImportTarget,
  remote: readonly RemoteTransaction[],
  ctx: ImportContext = {},
): ImportResult {
  const store = ctx.store ?? createSqliteImportStore();
  const result: ImportResult = {
    added: 0,
    matched: 0,
    transfers: 0,
    recurring: 0,
    duplicates: 0,
    otherCurrency: 0,
  };
  const seen = new Set<string>();
  const added: { id: string; counterpartyAccountHash: string | null }[] = [];

  const oldestFirst = [...remote].sort(
    (a, b) => a.date.localeCompare(b.date) || a.externalId.localeCompare(b.externalId),
  );
  for (const tx of oldestFirst) {
    if (tx.currency !== target.currency) {
      result.otherCurrency++;
      continue;
    }
    const importedId = target.importedIdPrefix + tx.externalId;
    if (seen.has(importedId) || store.hasImported(target.accountId, importedId)) {
      result.duplicates++;
      continue;
    }
    seen.add(importedId);

    const match = pickManualMatch(
      tx,
      store.manualCandidates(target.accountId, tx.amount, tx.date, MATCH_WINDOW_DAYS),
    );
    if (match) {
      store.attachImport(match, importedId, tx.importedPayee);
      result.matched++;
      continue;
    }

    const id = store.insert({
      accountId: target.accountId,
      date: tx.date,
      amount: tx.amount,
      payeeName: tx.payeeName,
      importedPayee: tx.importedPayee,
      notes: tx.notes,
      importedId,
    });
    added.push({ id, counterpartyAccountHash: tx.counterpartyAccountHash });
    result.added++;
  }

  for (const { id, counterpartyAccountHash } of added) {
    // Rules may have split it; only whole, unlinked transactions pair up
    const row = store.linkable(id);
    if (!row) continue;
    const named = counterpartyAccountHash
      ? (ctx.ownAccountsByIbanHash?.get(counterpartyAccountHash) ?? null)
      : null;
    const other = pickTransferCounterpart(
      {
        accountId: target.accountId,
        date: row.date,
        amount: row.amount,
        counterpartyAccountId: named === target.accountId ? null : named,
        siblings: store.countSiblings(
          target.accountId,
          id,
          row.amount,
          row.date,
          TRANSFER_WINDOW_DAYS,
        ),
      },
      store.transferCandidates(target.accountId, row.amount, row.date, TRANSFER_WINDOW_DAYS),
    );
    if (other && store.linkTransfer(id, other)) {
      result.transfers++;
      continue;
    }
    if (ctx.exchangePartners?.size && linkExchange(id, row, target, ctx.exchangePartners, store))
      result.transfers++;
  }

  // 5. Recurring items (bills, pay) recognized without asking when it's clear (D29)
  result.recurring = store.matchRecurring(added.map((a) => a.id));
  return result;
}

/** Links a new transaction to its other side in a currency exchange at the same bank (D27) */
function linkExchange(
  id: string,
  row: { date: string; amount: number },
  target: ImportTarget,
  partners: ReadonlyMap<string, string>,
  store: ImportStore,
): boolean {
  const here = store.exchangeCandidates([target.accountId], row.date, EXCHANGE_WINDOW_DAYS);
  const self = here.find((c) => c.id === id);
  if (!self) return false;
  // Another transaction here that also looks like an exchange makes it a guess
  const siblings = here.filter(
    (c) =>
      c.id !== id &&
      Math.sign(c.amount) === Math.sign(row.amount) &&
      looksLikeExchange(c.text, target.currency, partners),
  ).length;
  const others = [...partners.keys()].filter((accountId) => accountId !== target.accountId);
  const other = pickExchangeCounterpart(
    {
      accountId: target.accountId,
      currency: target.currency,
      date: row.date,
      amount: row.amount,
      text: self.text,
      partners,
      siblings,
    },
    store.exchangeCandidates(others, row.date, EXCHANGE_WINDOW_DAYS),
  );
  return !!other && store.linkTransfer(id, other);
}
