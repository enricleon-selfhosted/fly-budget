import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, transactions } from '../../db/schema.js';
import {
  impliedRate,
  latestRateOn,
  pickFxRate,
  rateOn,
  type DailyRate,
  type FxChoice,
} from './conversion.js';
import { pairRates } from './ratesStore.js';
import { getBudgetSettings, saveBudgetSettings } from './settings.js';

// The database side of converting transactions in accounts in another currency to the budget's
// (docs/multi-currency M3). Every write that can change a transaction's account, date, amount,
// transfer link or split calls convertTransactions; refreshFx('all') runs at startup and after a
// restore, so anything missed is caught up.

type Db = Pick<typeof db, 'select' | 'update'>;

/** Which transactions to (re)convert */
export type FxScope =
  'all' | { transactionIds: string[] } | { accountIds: string[] } | { currency: string };

const fxColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  date: transactions.date,
  amount: transactions.amount,
  parentTransactionId: transactions.parentTransactionId,
  transferTransactionId: transactions.transferTransactionId,
  fxRate: transactions.fxRate,
  fxSource: transactions.fxSource,
};
type FxRow = {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  parentTransactionId: string | null;
  transferTransactionId: string | null;
  fxRate: number | null;
  fxSource: string | null;
};

/** SQLite allows a limited number of variables per statement */
function chunks<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Accounts in another currency than the budget's: id → currency */
export function foreignCurrencies(tx: Db = db): Map<string, string> {
  const rows = tx
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(isNotNull(accounts.currency))
    .all();
  return new Map(rows.map((r) => [r.id, r.currency!]));
}

type IdColumn =
  | typeof transactions.id
  | typeof transactions.accountId
  | typeof transactions.parentTransactionId
  | typeof transactions.transferTransactionId;

function selectWhere(tx: Db, column: IdColumn, values: readonly string[]): FxRow[] {
  return chunks(values).flatMap((part) =>
    tx.select(fxColumns).from(transactions).where(inArray(column, part)).all(),
  );
}

/** The rows in scope, plus their split parts and the other side of their transfers */
function loadScope(tx: Db, scope: FxScope, foreign: Map<string, string>): FxRow[] {
  if (scope === 'all') {
    const inForeign = foreign.size ? inArray(transactions.accountId, [...foreign.keys()]) : sql`0`;
    return tx
      .select(fxColumns)
      .from(transactions)
      .where(or(isNotNull(transactions.fxRate), inForeign))
      .all();
  }
  let base: FxRow[];
  if ('transactionIds' in scope) base = selectWhere(tx, transactions.id, scope.transactionIds);
  else if ('accountIds' in scope) base = selectWhere(tx, transactions.accountId, scope.accountIds);
  else {
    const ids = [...foreign].filter(([, c]) => c === scope.currency).map(([id]) => id);
    base = selectWhere(tx, transactions.accountId, ids);
  }
  const byId = new Map(base.map((r) => [r.id, r]));
  const ids = [...byId.keys()];
  const related = [
    ...selectWhere(tx, transactions.parentTransactionId, ids),
    ...selectWhere(tx, transactions.transferTransactionId, ids),
  ];
  for (const r of related) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

const stored = (r: FxRow): FxChoice =>
  r.fxRate !== null && r.fxSource !== null
    ? { rate: r.fxRate, source: r.fxSource as NonNullable<FxChoice>['source'] }
    : null;

/**
 * Works out the rate of every transaction in scope (M3) and stores the ones that changed.
 * `resetManual` drops amounts typed in, for when the budget currency changes. Returns how many
 * transactions changed.
 */
export function refreshFx(scope: FxScope = 'all', opts: { resetManual?: boolean } = {}): number {
  const budget = getBudgetSettings().currency;
  // Without the budget's currency nothing can be converted; the first client to connect sends it
  if (!budget) return 0;
  let changed = 0;
  db.transaction((tx) => {
    const foreign = foreignCurrencies(tx);
    const rows = loadScope(tx, scope, foreign);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Parents and transfer sides outside the scope are read, not changed
    const outside = new Map<string, FxRow>();
    const wanted = new Set<string>();
    for (const r of rows) {
      for (const id of [r.parentTransactionId, r.transferTransactionId]) {
        if (id && !byId.has(id)) wanted.add(id);
      }
    }
    for (const r of selectWhere(tx, transactions.id, [...wanted])) outside.set(r.id, r);

    const rateCache = new Map<string, DailyRate[]>();
    const lookup = (currency: string) => (date: string) => {
      if (!rateCache.has(currency)) rateCache.set(currency, pairRates(currency, budget));
      return rateOn(rateCache.get(currency)!, date);
    };

    const chosen = new Map<string, FxChoice>();
    const choose = (r: FxRow): FxChoice => {
      if (chosen.has(r.id)) return chosen.get(r.id)!;
      const currency = foreign.get(r.accountId);
      let choice: FxChoice = null;
      if (currency) {
        const current = opts.resetManual
          ? { rate: null, source: null }
          : { rate: r.fxRate, source: r.fxSource };
        if (r.parentTransactionId) {
          const inScope = byId.get(r.parentTransactionId);
          const parentRow = inScope ?? outside.get(r.parentTransactionId);
          const parent = inScope ? choose(inScope) : parentRow ? stored(parentRow) : null;
          choice = pickFxRate({
            amount: r.amount,
            date: r.date,
            current,
            parent,
            lookup: lookup(currency),
          });
        } else {
          const otherId = r.transferTransactionId;
          const other = otherId ? (byId.get(otherId) ?? outside.get(otherId)) : undefined;
          // An exchange into the budget's currency: exact (other sides in another currency use rates)
          const exchangeOther = other && !foreign.has(other.accountId) ? other.amount : null;
          choice = pickFxRate({
            amount: r.amount,
            date: r.date,
            current,
            exchangeOther,
            lookup: lookup(currency),
          });
        }
      }
      chosen.set(r.id, choice);
      return choice;
    };

    for (const r of rows) {
      const choice = choose(r);
      const fxRate = choice?.rate ?? null;
      const fxSource = choice?.source ?? null;
      if (fxRate === r.fxRate && fxSource === r.fxSource) continue;
      tx.update(transactions).set({ fxRate, fxSource }).where(eq(transactions.id, r.id)).run();
      changed++;
    }
  });
  return changed;
}

/**
 * Converts transactions that were just added or changed (with their split parts and the other
 * side of a transfer). Cheap when the budget has no account in another currency.
 */
export function convertTransactions(ids: readonly string[]): number {
  if (!ids.length || foreignCurrencies().size === 0) return 0;
  return refreshFx({ transactionIds: [...ids] });
}

export type FxOutcome = { ok: true } | { ok: false; status: number; error: string };

/**
 * Whether a transaction's value in the budget currency can be typed in: it's in an account in
 * another currency, not a split part (parts follow their parent), not an exchange into the
 * budget's currency (exact already), and in the same direction as its amount.
 */
export function checkBudgetAmount(id: string, budgetAmount: number | null): FxOutcome {
  const row = db.select(fxColumns).from(transactions).where(eq(transactions.id, id)).get();
  if (!row) return { ok: false, status: 404, error: 'Transaction not found' };
  const foreign = foreignCurrencies();
  if (!foreign.has(row.accountId)) {
    return { ok: false, status: 400, error: 'This account is in the budget’s currency' };
  }
  if (row.parentTransactionId) {
    return { ok: false, status: 400, error: 'Split parts use the rate of the whole transaction' };
  }
  if (budgetAmount === null) return { ok: true };
  if (row.transferTransactionId) {
    const other = db
      .select({ accountId: transactions.accountId })
      .from(transactions)
      .where(eq(transactions.id, row.transferTransactionId))
      .get();
    if (other && !foreign.has(other.accountId)) {
      return { ok: false, status: 400, error: 'The amount comes from the exchange' };
    }
  }
  if (
    impliedRate(row.amount, budgetAmount) === null ||
    Math.sign(budgetAmount) !== Math.sign(row.amount)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'Enter an amount in the same direction as the transaction',
    };
  }
  return { ok: true };
}

/** Sets a transaction's value in the budget currency by hand; `null` goes back to the day's rate */
export function setBudgetAmount(id: string, budgetAmount: number | null): FxOutcome {
  const problem = checkBudgetAmount(id, budgetAmount);
  if (!problem.ok) return problem;
  const amount = db
    .select({ amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get()!.amount;
  const set =
    budgetAmount === null
      ? { fxRate: null, fxSource: null }
      : { fxRate: impliedRate(amount, budgetAmount), fxSource: 'manual' };
  db.update(transactions).set(set).where(eq(transactions.id, id)).run();
  refreshFx({ transactionIds: [id] });
  return { ok: true };
}

/**
 * Changes the budget's currency (M2): accounts in the new currency become the budget's, accounts
 * that were in the budget's currency get the old code, and every conversion is worked out again.
 */
export function changeBudgetCurrency(next: string): { accountsChanged: number } {
  const prev = getBudgetSettings().currency;
  if (prev === next) return { accountsChanged: 0 };
  let accountsChanged = 0;
  db.transaction((tx) => {
    if (prev) {
      accountsChanged += tx
        .update(accounts)
        .set({ currency: prev })
        .where(isNull(accounts.currency))
        .run().changes;
    }
    accountsChanged += tx
      .update(accounts)
      .set({ currency: null })
      .where(eq(accounts.currency, next))
      .run().changes;
    saveBudgetSettings({ currency: next });
  });
  // Amounts typed in were in the old currency
  refreshFx('all', { resetManual: prev !== null });
  return { accountsChanged };
}

/** A currency's latest rate to the budget's on or before `date` (any age), null when none */
export function latestRate(currency: string, date: string) {
  const budget = getBudgetSettings().currency;
  if (!budget) return null;
  return latestRateOn(pairRates(currency, budget), date);
}

/** Transactions in accounts in another currency that have no rate yet, by currency */
export function waitingForRates(): { currency: string; count: number }[] {
  return db
    .select({ currency: sql<string>`${accounts.currency}`, count: sql<number>`count(*)` })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        isNotNull(accounts.currency),
        isNull(transactions.fxRate),
        isNull(transactions.parentTransactionId),
      ),
    )
    .groupBy(accounts.currency)
    .all();
}
