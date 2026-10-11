import { addDays, format, parseISO, subDays } from 'date-fns';
import { defaultOffBudget, type AccountType } from '../../utils/accountTypes.js';
import { accountCurrency, startsOffBudget, storedCurrency } from '../../utils/currency.js';
import { cleanText } from '../../utils/text.js';
import { suggestAccountType } from './mapping.js';

// The pure rules behind choosing accounts (decisions D9, D11) and syncing them (D9, D10). No
// database or clock: callers pass the day or the time, so the same rules can run anywhere.
// accountMapping.ts and syncService.ts apply them.

/** How far back a new account's history starts unless the user picks a date */
export const DEFAULT_HISTORY_DAYS = 90;
/** Background syncs (server start) skip connections synced more recently than this (D10) */
export const BACKGROUND_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Later syncs read again this many days before the last one, for late bookings (D9) */
export const RESYNC_OVERLAP_DAYS = 10;

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/** The calendar day at this time, in the server's time zone like the rest of the server */
export function localDay(nowMs: number): string {
  return format(nowMs, 'yyyy-MM-dd');
}

export function defaultSyncFrom(today: string): string {
  return iso(subDays(parseISO(today), DEFAULT_HISTORY_DAYS));
}

/** For an existing account: right after its newest imported transaction (CSV or bank) */
export function syncFromAfter(newestImported: string | null, today: string): string {
  if (!newestImported) return defaultSyncFrom(today);
  const next = iso(addDays(parseISO(newestImported), 1));
  return next > today ? today : next;
}

export type MappingRequest =
  | {
      id: string;
      action: 'create';
      accountName?: string;
      accountType?: AccountType;
      isOffBudget?: number;
      syncFrom?: string;
    }
  | { id: string; action: 'link'; accountId: string; syncFrom?: string }
  | { id: string; action: 'skip' };

export type MappingPlan =
  | {
      action: 'create';
      account: { name: string; type: AccountType; isOffBudget: 0 | 1; currency: string | null };
      syncFrom: string;
    }
  | { action: 'link'; accountId: string; syncFrom: string }
  | { action: 'skip' };

type BankSide = { name: string; currency: string | null; cashAccountType: string | null };
export type TargetSide = {
  currency: string | null;
  closedAt: string | null;
  alreadyImportedBy: boolean;
};

/**
 * What a mapping request means for one bank account, or why it can't be done.
 * `target` is the existing account for a link (null if it doesn't exist).
 */
export function planMapping(
  request: MappingRequest,
  bank: BankSide,
  context: {
    budgetCurrency: string;
    today: string;
    target?: TargetSide | null;
    newestImported?: string | null;
  },
): MappingPlan | { error: string } {
  if (request.action === 'skip') return { action: 'skip' };
  if (request.syncFrom && request.syncFrom > context.today)
    return { error: 'The import date can’t be in the future.' };

  if (request.action === 'create') {
    const currency = storedCurrency(bank.currency, context.budgetCurrency);
    const type = request.accountType ?? suggestAccountType(bank.cashAccountType);

    return {
      action: 'create',
      account: {
        name: cleanText(request.accountName, 200) || bank.name,
        type,
        isOffBudget: startsOffBudget(
          currency,
          request.isOffBudget as 0 | 1 | undefined,
          defaultOffBudget(type),
        ),
        currency,
      },
      syncFrom: request.syncFrom ?? defaultSyncFrom(context.today),
    };
  }

  const target = context.target;
  if (!target || target.closedAt) return { error: 'That account doesn’t exist anymore.' };
  if (target.alreadyImportedBy)
    return { error: 'Another bank account already imports into that account.' };
  const targetCurrency = accountCurrency(target.currency, context.budgetCurrency);
  if (bank.currency && bank.currency !== targetCurrency)
    return {
      error: `That account is in ${targetCurrency} and the bank account in ${bank.currency}.`,
    };
  return {
    action: 'link',
    accountId: request.accountId,
    syncFrom: request.syncFrom ?? syncFromAfter(context.newestImported ?? null, context.today),
  };
}

/** The first day to read: `syncFrom` on the first sync, else a little before the last one */
export function syncWindowStart(
  syncFrom: string | null,
  lastSyncedAt: string | null,
  today: string,
): string {
  const floor = syncFrom ?? defaultSyncFrom(today);
  if (!lastSyncedAt) return floor;
  const overlap = iso(subDays(parseISO(lastSyncedAt), RESYNC_OVERLAP_DAYS));
  return overlap > floor ? overlap : floor;
}

/** A background sync leaves a connection synced less than 6 hours ago alone (D10: PSD2 limits) */
export function shouldSkipBackgroundSync(lastSyncedAt: string | null, nowMs: number): boolean {
  return lastSyncedAt !== null && nowMs - Date.parse(lastSyncedAt) < BACKGROUND_SYNC_INTERVAL_MS;
}

/** The consent's access has run out: the user has to renew it at their bank */
export function consentEnded(validUntil: string, nowMs: number): boolean {
  return Date.parse(validUntil) <= nowMs;
}
