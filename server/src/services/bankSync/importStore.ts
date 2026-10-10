import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { addDays, format, parseISO } from 'date-fns';
import { db } from '../../db/index.js';
import { accounts, transactions } from '../../db/schema.js';
import { buildRuleContext, insertNewTransaction, loadRules } from '../ruleService.js';
import { linkTransfer } from '../transactionHelpers.js';
import { autoMatchImported } from '../matchingEngine.js';
import type { ExchangeCandidate, ManualCandidate, TransferCandidate } from './matching.js';

// Everything importTransactions reads or writes, so the import logic doesn't depend on
// how transactions are stored.

export type NewImport = {
  accountId: string;
  date: string;
  amount: number;
  payeeName: string;
  importedPayee: string;
  notes: string | null;
  importedId: string;
};

export interface ImportStore {
  /** A transaction with this imported id is already in the account */
  hasImported(accountId: string, importedId: string): boolean;
  /** Typed-in transactions (no imported id) of this amount around this date, that may merge */
  manualCandidates(
    accountId: string,
    amount: number,
    date: string,
    days: number,
  ): ManualCandidate[];
  /** Records that a typed-in transaction is this import (its own fields stay) */
  attachImport(transactionId: string, importedId: string, importedPayee: string): void;
  /** Adds a transaction (rules and payees apply); returns its id */
  insert(input: NewImport): string;
  /** Date and amount of a transaction that could still become one side of a transfer */
  linkable(transactionId: string): { date: string; amount: number } | null;
  /**
   * Imported transactions in the user's other open accounts with the same currency as this
   * account, of the opposite amount around this date, that could be the other side of a transfer
   */
  transferCandidates(
    accountId: string,
    amount: number,
    date: string,
    days: number,
  ): TransferCandidate[];
  /** Other unlinked transactions of this amount in this account around this date */
  countSiblings(
    accountId: string,
    excludeId: string,
    amount: number,
    date: string,
    days: number,
  ): number;
  /**
   * Imported, unlinked whole transactions in these accounts around this date, with their bank
   * text, that could be one side of a currency exchange
   */
  exchangeCandidates(
    accountIds: readonly string[],
    date: string,
    days: number,
  ): ExchangeCandidate[];
  /** Links two transactions as a transfer; false if they can't be linked */
  linkTransfer(aId: string, bId: string): boolean;
  /** Matches new transactions to recurring items where it's clear; returns how many */
  matchRecurring(transactionIds: readonly string[]): number;
}

const shift = (date: string, days: number) => format(addDays(parseISO(date), days), 'yyyy-MM-dd');

const around = (date: string, days: number) =>
  and(gte(transactions.date, shift(date, -days)), lte(transactions.date, shift(date, days)));

/** A whole transaction the user sees: not a split part, a balance correction or a transfer */
const plain = and(
  isNull(transactions.parentTransactionId),
  eq(transactions.isAdjustment, 0),
  isNull(transactions.transferTransactionId),
);

/** The store backed by the app's SQLite database. Rules load once per store. */
export function createSqliteImportStore(): ImportStore {
  let ruleOpts: Parameters<typeof insertNewTransaction>[1] | undefined;

  return {
    hasImported(accountId, importedId) {
      return (
        db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(eq(transactions.accountId, accountId), eq(transactions.importedId, importedId)),
          )
          .get() !== undefined
      );
    },

    manualCandidates(accountId, amount, date, days) {
      return db
        .select({
          id: transactions.id,
          date: transactions.date,
          amount: transactions.amount,
          createdAt: transactions.createdAt,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            eq(transactions.amount, amount),
            isNull(transactions.importedId),
            isNull(transactions.parentTransactionId),
            eq(transactions.isAdjustment, 0),
            eq(transactions.reconciled, 0),
            around(date, days),
          ),
        )
        .all();
    },

    attachImport(transactionId, importedId, importedPayee) {
      db.update(transactions)
        .set({ importedId, importedPayee })
        .where(eq(transactions.id, transactionId))
        .run();
    },

    insert(input) {
      ruleOpts ??= { rules: loadRules(), ctx: buildRuleContext() };
      const { transaction } = insertNewTransaction(
        { ...input, payeeId: null, categoryId: null },
        ruleOpts,
      );
      return transaction.id;
    },

    linkable(transactionId) {
      return (
        db
          .select({ date: transactions.date, amount: transactions.amount })
          .from(transactions)
          .where(
            and(
              eq(transactions.id, transactionId),
              plain,
              eq(transactions.isParent, 0),
              eq(transactions.reconciled, 0),
            ),
          )
          .get() ?? null
      );
    },

    transferCandidates(accountId, amount, date, days) {
      const own = db
        .select({ currency: accounts.currency })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!own) return [];
      return db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          date: transactions.date,
          amount: transactions.amount,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(
          and(
            ne(transactions.accountId, accountId),
            isNull(accounts.closedAt),
            // Same currency: both the budget's (null), or the same code
            sql`${accounts.currency} is ${own.currency}`,
            eq(transactions.amount, -amount),
            isNotNull(transactions.importedId),
            plain,
            eq(transactions.isParent, 0),
            eq(transactions.reconciled, 0),
            around(date, days),
          ),
        )
        .all();
    },

    countSiblings(accountId, excludeId, amount, date, days) {
      return db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            ne(transactions.id, excludeId),
            eq(transactions.amount, amount),
            plain,
            around(date, days),
          ),
        )
        .all().length;
    },

    exchangeCandidates(accountIds, date, days) {
      if (!accountIds.length) return [];
      return db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          date: transactions.date,
          amount: transactions.amount,
          text: sql<string>`coalesce(${transactions.importedPayee}, ${transactions.payeeName}, '') || ' ' || coalesce(${transactions.notes}, '')`,
        })
        .from(transactions)
        .where(
          and(
            inArray(transactions.accountId, [...accountIds]),
            isNotNull(transactions.importedId),
            plain,
            eq(transactions.isParent, 0),
            eq(transactions.reconciled, 0),
            around(date, days),
          ),
        )
        .all();
    },

    linkTransfer(aId, bId) {
      return linkTransfer(aId, bId).ok;
    },

    matchRecurring(transactionIds) {
      return autoMatchImported(transactionIds);
    },
  };
}
