import { Router } from 'express';
import { db } from '../db/index.js';
import { accounts, transactions } from '../db/schema.js';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logoSchema } from '../utils/logo.js';
import { accountTypeSchema } from '../utils/accountTypes.js';
import { currencyCode } from '../utils/currency.js';
import { format } from 'date-fns';
import { convertCents } from '../services/fx/conversion.js';
import { latestRate } from '../services/fx/fxService.js';
import { inAccountBalance } from '../services/balances.js';
import {
  accountBalance,
  createAccount,
  updateAccount,
  type Account,
} from '../services/accountService.js';

export const accountsRouter = Router();

const fields = {
  name: z.string().trim().min(1).max(200),
  type: accountTypeSchema,
  startingBalance: z.number().int(),
  isOffBudget: z.number().int().min(0).max(1),
  /** Only for an account in another currency than the budget's (see utils/currency.ts) */
  currency: currencyCode.nullable(),
};

const createSchema = z.object({
  ...fields,
  startingBalance: fields.startingBalance.default(0),
  isOffBudget: fields.isOffBudget.optional(),
  currency: fields.currency.optional(),
});

// Built without defaults: Zod applies `.default()` even inside `.partial()`, so an update
// that only renames an account would otherwise reset its starting balance to 0
const updateSchema = z.object(fields).partial().extend({ logo: logoSchema.optional() });

/**
 * An account with its balance and, in another currency, that balance's value in the budget's
 * currency at the latest rate (docs/multi-currency M6; null without a rate) and the rate's date.
 */
function withBudgetBalance(account: Account, balance: number, today: string) {
  if (!account.currency) return { ...account, balance };
  const rate = latestRate(account.currency, today);
  return {
    ...account,
    balance,
    budgetBalance: rate ? convertCents(balance, rate.rate) : null,
    budgetBalanceAsOf: rate?.date ?? null,
  };
}

const today = () => format(new Date(), 'yyyy-MM-dd');

/** An account that was just written, with its balance */
function withBalance(account: Account) {
  return withBudgetBalance(account, accountBalance(account.id)!, today());
}

accountsRouter.get('/', (_req, res) => {
  const rows = db
    .select()
    .from(accounts)
    .where(isNull(accounts.closedAt))
    .orderBy(accounts.sortOrder)
    .all();
  if (!rows.length) return res.json([]);

  const sums = db
    .select({
      accountId: transactions.accountId,
      sum: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .where(inAccountBalance)
    .groupBy(transactions.accountId)
    .all();

  const sumMap = Object.fromEntries(sums.map((s) => [s.accountId, s.sum]));
  const day = today();
  res.json(rows.map((a) => withBudgetBalance(a, a.startingBalance + (sumMap[a.id] ?? 0), day)));
});

accountsRouter.get('/balances-ago', (_req, res) => {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const cutoff = oneMonthAgo.toISOString().slice(0, 10);

  const rows = db.select().from(accounts).where(isNull(accounts.closedAt)).all();
  const sums = db
    .select({
      accountId: transactions.accountId,
      sum: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .where(and(sql`${transactions.date} < ${cutoff}`, inAccountBalance))
    .groupBy(transactions.accountId)
    .all();

  const sumMap = Object.fromEntries(sums.map((s) => [s.accountId, s.sum]));
  const result: Record<string, number> = {};
  for (const a of rows) {
    result[a.id] = a.startingBalance + (sumMap[a.id] ?? 0);
  }
  res.json(result);
});

accountsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = createAccount({
    ...parsed.data,
    isOffBudget: parsed.data.isOffBudget as 0 | 1 | undefined,
  });
  res.status(201).json(withBalance(account));
});

accountsRouter.put('/reorder', (req, res) => {
  const parsed = z.object({ ids: z.array(z.string().max(64)).max(10_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  db.transaction((tx) => {
    parsed.data.ids.forEach((id, i) => {
      tx.update(accounts).set({ sortOrder: i }).where(eq(accounts.id, id)).run();
    });
  });
  res.json({ ok: true });
});

accountsRouter.put('/:id/reconcile', (req, res) => {
  const parsed = z
    .object({ transactionIds: z.array(z.string().max(64)).min(1).max(100_000) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Only this account's transactions
  const result = db
    .update(transactions)
    .set({ reconciled: 1 })
    .where(
      and(
        eq(transactions.accountId, req.params.id),
        inArray(transactions.id, parsed.data.transactionIds),
        ne(transactions.reconciled, 1),
      ),
    )
    .run();

  res.json({ reconciled: result.changes });
});

accountsRouter.put('/:id', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = updateAccount(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  // transfersUncategorized: transfers whose category stopped making sense (M8)
  res.json({
    ...withBalance(updated.account),
    transfersUncategorized: updated.transfersUncategorized,
  });
});

accountsRouter.delete('/:id', (req, res) => {
  db.update(accounts)
    .set({ closedAt: new Date().toISOString() })
    .where(eq(accounts.id, req.params.id))
    .run();
  res.status(204).send();
});
