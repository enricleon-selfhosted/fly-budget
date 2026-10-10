import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { addDays, format, parseISO, subDays } from 'date-fns';
import { nanoid } from 'nanoid';
import { db } from '../../db/index.js';
import { accounts, enableBankingAccounts, transactions } from '../../db/schema.js';
import { defaultOffBudget, type AccountType } from '../../utils/accountTypes.js';
import { accountCurrency, offBudgetFor, storedCurrency } from '../../utils/currency.js';
import { cleanText, suggestAccountType } from './mapping.js';
import { enableBankingStore, type BankAccountRow } from './store.js';

// Which FlyBudget account each bank account imports into (decisions D9, D11): a new one, an
// existing one, or none. The rules are pure (planMapping, syncFrom defaults); applyMappings
// writes the result.

/** How far back a new account's history starts unless the user picks a date */
export const DEFAULT_HISTORY_DAYS = 90;

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

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

export function defaultSyncFrom(today: string): string {
  return iso(subDays(parseISO(today), DEFAULT_HISTORY_DAYS));
}

/** For an existing account: right after its newest imported transaction (CSV or bank) */
export function syncFromAfter(newestImported: string | null, today: string): string {
  if (!newestImported) return defaultSyncFrom(today);
  const next = iso(addDays(parseISO(newestImported), 1));
  return next > today ? today : next;
}

type BankSide = Pick<BankAccountRow, 'name' | 'currency' | 'cashAccountType'>;
type TargetSide = { currency: string | null; closedAt: string | null; alreadyImportedBy: boolean };

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
    const requested = (request.isOffBudget ?? defaultOffBudget(type)) as 0 | 1;
    return {
      action: 'create',
      account: {
        name: cleanText(request.accountName, 200) || bank.name,
        type,
        isOffBudget: offBudgetFor(currency, requested),
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

export type MappingResult = {
  created: number;
  linked: number;
  skipped: number;
  errors: { id: string; error: string }[];
};

function linkTarget(accountId: string, bankAccountId: string): TargetSide | null {
  const account = db
    .select({ currency: accounts.currency, closedAt: accounts.closedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) return null;
  const importer = db
    .select({ id: enableBankingAccounts.id })
    .from(enableBankingAccounts)
    .where(
      and(
        eq(enableBankingAccounts.accountId, accountId),
        eq(enableBankingAccounts.isEnabled, 1),
        ne(enableBankingAccounts.id, bankAccountId),
      ),
    )
    .get();
  return { ...account, alreadyImportedBy: !!importer };
}

function newestImported(accountId: string): string | null {
  return (
    db
      .select({ date: sql<string | null>`max(${transactions.date})` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.importedId)))
      .get()?.date ?? null
  );
}

/** Applies the user's choices for a connection's accounts; each one succeeds or fails alone */
export function applyMappings(
  connectionId: string,
  requests: readonly MappingRequest[],
  budgetCurrency: string,
  today: string,
): MappingResult {
  const bankAccounts = new Map(enableBankingStore.listAccounts(connectionId).map((a) => [a.id, a]));
  const result: MappingResult = { created: 0, linked: 0, skipped: 0, errors: [] };

  for (const request of requests) {
    const bank = bankAccounts.get(request.id);
    if (!bank) {
      result.errors.push({ id: request.id, error: 'Unknown bank account.' });
      continue;
    }
    const plan = planMapping(request, bank, {
      budgetCurrency,
      today,
      target: request.action === 'link' ? linkTarget(request.accountId, bank.id) : undefined,
      newestImported: request.action === 'link' ? newestImported(request.accountId) : undefined,
    });
    if ('error' in plan) {
      result.errors.push({ id: request.id, error: plan.error });
      continue;
    }

    if (plan.action === 'skip') {
      enableBankingStore.updateAccount(bank.id, {
        isEnabled: 0,
        accountId: null,
        openingBalancePending: 0,
      });
      result.skipped++;
    } else if (plan.action === 'link') {
      enableBankingStore.updateAccount(bank.id, {
        isEnabled: 1,
        accountId: plan.accountId,
        syncFrom: plan.syncFrom,
        openingBalancePending: 0,
      });
      result.linked++;
    } else {
      const accountId = nanoid();
      db.transaction(() => {
        db.insert(accounts)
          .values({
            id: accountId,
            ...plan.account,
            startingBalance: 0,
            sortOrder: 0,
            createdAt: new Date().toISOString(),
          })
          .run();
        enableBankingStore.updateAccount(bank.id, {
          isEnabled: 1,
          accountId,
          syncFrom: plan.syncFrom,
          openingBalancePending: 1,
        });
      });
      result.created++;
    }
  }
  return result;
}
