import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, enableBankingAccounts, transactions } from '../../db/schema.js';
import { createAccount } from '../accountService.js';
import { planMapping, type MappingRequest, type TargetSide } from './rules.js';
import { enableBankingStore } from './store.js';

// Which FlyBudget account each bank account imports into (decisions D9, D11): a new one, an
// existing one, or none. The rules are pure, in rules.ts; this applies them.

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
      db.transaction(() => {
        // Its balance is set from the bank's on the first sync (D7)
        const account = createAccount({ ...plan.account, startingBalance: 0 });
        enableBankingStore.updateAccount(bank.id, {
          isEnabled: 1,
          accountId: account.id,
          syncFrom: plan.syncFrom,
          openingBalancePending: 1,
        });
      });
      result.created++;
    }
  }
  return result;
}
