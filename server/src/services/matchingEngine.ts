import { db } from '../db/index.js';
import {
  schedules,
  scheduleOccurrences,
  scheduleMatchDismissals,
  transactions,
} from '../db/schema.js';
import { eq, and, gte, lte, isNull, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { format, parseISO, addDays, subDays } from 'date-fns';
import { pickImportMatches, scoreMatch } from './scheduleMatching.js';

export function linkOccurrenceToTransaction(
  occurrenceId: string,
  transactionId: string,
  matchType: 'automatic' | 'manual',
  confidence: number,
): void {
  const occ = db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.id, occurrenceId))
    .get();
  if (!occ) return;

  const now = format(new Date(), 'yyyy-MM-dd');

  db.update(scheduleOccurrences)
    .set({
      status: 'paid',
      matchedTransactionId: transactionId,
      matchType,
      matchConfidence: confidence,
      paidAt: now,
    })
    .where(eq(scheduleOccurrences.id, occurrenceId))
    .run();

  db.update(transactions)
    .set({ scheduleId: occ.scheduleId })
    .where(eq(transactions.id, transactionId))
    .run();
}

export function unlinkOccurrence(occurrenceId: string): void {
  const occ = db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.id, occurrenceId))
    .get();
  if (!occ) return;

  if (occ.matchedTransactionId) {
    db.update(transactions)
      .set({ scheduleId: null })
      .where(eq(transactions.id, occ.matchedTransactionId))
      .run();
  }

  db.update(scheduleOccurrences)
    .set({
      status: 'pending',
      matchedTransactionId: null,
      matchType: null,
      matchConfidence: null,
      paidAt: null,
    })
    .where(eq(scheduleOccurrences.id, occurrenceId))
    .run();
}

export function unlinkOccurrenceByTransactionId(transactionId: string): void {
  const occ = db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.matchedTransactionId, transactionId))
    .get();

  if (!occ) return;

  db.update(scheduleOccurrences)
    .set({
      status: 'pending',
      matchedTransactionId: null,
      matchType: null,
      matchConfidence: null,
      paidAt: null,
    })
    .where(eq(scheduleOccurrences.id, occ.id))
    .run();
}

export interface MatchSuggestion {
  occurrenceId: string;
  scheduleId: string;
  scheduleName: string;
  scheduledDate: string;
  expectedDate: string;
  expectedAmount: number;
  candidates: {
    transactionId: string;
    /** Amounts are in this account's currency */
    accountId: string;
    date: string;
    amount: number;
    payeeName: string | null;
    score: number;
  }[];
}

export function getMatchSuggestions(): MatchSuggestion[] {
  const windowStart = format(subDays(new Date(), 14), 'yyyy-MM-dd');
  const windowEnd = format(addDays(new Date(), 7), 'yyyy-MM-dd');

  const pendingOccs = db
    .select({
      occ: scheduleOccurrences,
      schedule: schedules,
    })
    .from(scheduleOccurrences)
    .innerJoin(schedules, eq(scheduleOccurrences.scheduleId, schedules.id))
    .where(
      and(
        eq(scheduleOccurrences.status, 'pending'),
        eq(schedules.status, 'active'),
        gte(scheduleOccurrences.expectedDate, windowStart),
        lte(scheduleOccurrences.expectedDate, windowEnd),
      ),
    )
    .all();

  const suggestions: MatchSuggestion[] = [];

  for (const { occ, schedule } of pendingOccs) {
    const nearbyTxns = db
      .select()
      .from(transactions)
      .where(
        and(
          isNull(transactions.scheduleId),
          isNull(transactions.transferTransactionId),
          gte(
            transactions.date,
            format(subDays(parseISO(occ.expectedDate), schedule.dateFlexibility), 'yyyy-MM-dd'),
          ),
          lte(
            transactions.date,
            format(addDays(parseISO(occ.expectedDate), schedule.dateFlexibility), 'yyyy-MM-dd'),
          ),
        ),
      )
      .all();

    const candidateTxns: MatchSuggestion['candidates'] = [];

    for (const tx of nearbyTxns) {
      if (schedule.amount < 0 && tx.amount > 0) continue;
      if (schedule.amount > 0 && tx.amount < 0) continue;

      const dismissed = db
        .select()
        .from(scheduleMatchDismissals)
        .where(
          and(
            eq(scheduleMatchDismissals.occurrenceId, occ.id),
            eq(scheduleMatchDismissals.transactionId, tx.id),
          ),
        )
        .get();
      if (dismissed) continue;

      const { score } = scoreMatch(tx, occ, schedule);
      if (score >= 40) {
        candidateTxns.push({
          transactionId: tx.id,
          accountId: tx.accountId,
          date: tx.date,
          amount: tx.amount,
          payeeName: tx.payeeName,
          score,
        });
      }
    }

    if (candidateTxns.length > 0) {
      candidateTxns.sort((a, b) => b.score - a.score);
      suggestions.push({
        occurrenceId: occ.id,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        scheduledDate: occ.scheduledDate,
        expectedDate: occ.expectedDate,
        expectedAmount: occ.expectedAmount,
        candidates: candidateTxns,
      });
    }
  }

  return suggestions;
}

export function dismissMatchSuggestion(occurrenceId: string, transactionId: string): void {
  try {
    db.insert(scheduleMatchDismissals)
      .values({
        id: nanoid(),
        occurrenceId,
        transactionId,
      })
      .run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE constraint failed')) return;
    throw e;
  }
}

/**
 * Matches just-imported transactions to pending occurrences of active recurring items when it
 * is clear (decision D29, pickImportMatches). Returns how many were matched.
 */
export function autoMatchImported(transactionIds: readonly string[]): number {
  if (!transactionIds.length) return 0;
  const txs = db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.id, [...transactionIds]),
        isNull(transactions.scheduleId),
        isNull(transactions.transferTransactionId),
        isNull(transactions.parentTransactionId),
      ),
    )
    .all();
  if (!txs.length) return 0;
  const dates = txs.map((t) => t.date).sort();
  // The widest date flexibility allowed is 14 days
  const from = format(subDays(parseISO(dates[0]), 14), 'yyyy-MM-dd');
  const to = format(addDays(parseISO(dates[dates.length - 1]), 14), 'yyyy-MM-dd');
  const accountIds = [...new Set(txs.map((t) => t.accountId))];

  const pending = db
    .select({ occ: scheduleOccurrences, schedule: schedules })
    .from(scheduleOccurrences)
    .innerJoin(schedules, eq(scheduleOccurrences.scheduleId, schedules.id))
    .where(
      and(
        eq(scheduleOccurrences.status, 'pending'),
        eq(schedules.status, 'active'),
        inArray(schedules.accountId, accountIds),
        gte(scheduleOccurrences.expectedDate, from),
        lte(scheduleOccurrences.expectedDate, to),
      ),
    )
    .all()
    .map(({ occ, schedule }) => ({
      id: occ.id,
      expectedDate: occ.expectedDate,
      expectedAmount: occ.expectedAmount,
      schedule,
    }));

  const matches = pickImportMatches(txs, pending);
  for (const m of matches) {
    linkOccurrenceToTransaction(m.occurrenceId, m.transactionId, 'automatic', m.score);
  }
  return matches.length;
}
