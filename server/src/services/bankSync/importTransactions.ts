import { createSqliteImportStore, type ImportStore } from './importStore.js';
import {
  MATCH_WINDOW_DAYS,
  TRANSFER_WINDOW_DAYS,
  pickManualMatch,
  pickTransferCounterpart,
} from './matching.js';
import type { ImportResult, ImportTarget, RemoteTransaction } from './types.js';

export type ImportContext = {
  /** SHA-256 of an IBAN → the user's account it belongs to, to recognize transfers */
  ownAccountsByIbanHash?: ReadonlyMap<string, string>;
  store?: ImportStore;
};

/**
 * Imports one account's bank transactions the way YNAB does (decisions D5, D6):
 *
 * 1. skip what was imported before (same imported id);
 * 2. merge into a transaction the user typed in (same amount, close date) instead of adding;
 * 3. otherwise add it, with rules and payees, through insertNewTransaction;
 * 4. then link each new transaction to its other side when money moved between the user's
 *    own accounts. This runs after every new row of the batch is in, so a second transaction
 *    of the same amount in this batch makes the pairing ambiguous rather than a guess.
 */
export function importTransactions(
  target: ImportTarget,
  remote: readonly RemoteTransaction[],
  ctx: ImportContext = {},
): ImportResult {
  const store = ctx.store ?? createSqliteImportStore();
  // One transaction: a failure part-way leaves nothing behind, so nothing imported misses the
  // transfer pairing below (the next sync would see it as a duplicate and never pair it)
  return store.transaction(() => importInto(store, target, remote, ctx));
}

function importInto(
  store: ImportStore,
  target: ImportTarget,
  remote: readonly RemoteTransaction[],
  ctx: ImportContext,
): ImportResult {
  const result: ImportResult = {
    added: 0,
    matched: 0,
    transfers: 0,
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

  // Transfers pair within one currency (null = the budget's)
  const ownCurrency = added.length ? store.storedCurrency(target.accountId) : null;
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
        currency: ownCurrency,
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
    if (other && store.linkTransfer(id, other)) result.transfers++;
  }

  return result;
}
