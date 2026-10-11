import { Router } from 'express';
import { db } from '../db/index.js';
import { transactions, payees, accounts, categories } from '../db/schema.js';
import { eq, and, or, like, gte, lte, sql, isNull, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  createTransfer,
  deleteTransactionRow,
  linkTransfer,
  resolvePayee,
  transferCandidates,
  unlinkTransfer,
  updateTransferSide,
  type TransferRefusal,
} from '../services/transactionHelpers.js';
import { buildRuleContext, insertNewTransaction, loadRules } from '../services/ruleService.js';
import { afterTransactionsWritten } from '../services/transactionFx.js';
import { isoDate } from '../utils/validation.js';
import { convertCents } from '../services/fx/conversion.js';
import {
  convertTransactions,
  foreignCurrencies,
  setBudgetAmount,
} from '../services/fx/fxService.js';

export const transactionsRouter = Router();

/** The status a refused transfer write answers with */
function transferStatus(reason: TransferRefusal): 400 | 403 | 404 {
  if (reason === 'not_found') return 404;
  if (reason === 'reconciled') return 403;
  return 400;
}

/** Thrown inside an edit's database transaction to roll it back and answer with this status */
class EditRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const id = z.string().min(1).max(64);
// Amounts are integer cents; the cap keeps sums far inside Number.MAX_SAFE_INTEGER
const cents = z.number().int().min(-1e13).max(1e13);

// A transaction saved on a device while offline carries its own random id. Sending it again
// (the connection dropped before the answer arrived, or two tabs sent it) returns the saved one
// instead of creating a duplicate.
const clientId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const createSchema = z.object({
  id: clientId.optional(),
  accountId: id,
  date: isoDate,
  amount: cents,
  payeeId: id.nullable().optional(),
  payeeName: z.string().max(500).nullable().optional(),
  categoryId: id.nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
  /** A balance correction (reconciliation, "Update value"), left out of income and spending */
  adjustment: z.boolean().optional(),
  splits: z
    .array(
      z.object({
        categoryId: id.nullable(),
        amount: cents,
        notes: z.string().max(5_000).nullable().optional(),
      }),
    )
    .max(100)
    .optional(),
});

const updateSchema = createSchema
  .omit({ id: true, splits: true, adjustment: true })
  .partial()
  // In an account in another currency: its value in the budget's currency, typed in (null goes
  // back to the day's rate; docs/multi-currency M3)
  .extend({ budgetAmount: cents.nullable().optional() });

const transferSchema = z
  .object({
    id: clientId.optional(),
    fromAccountId: id,
    toAccountId: id,
    date: isoDate,
    amount: cents.positive(),
    /** What arrives in the other account when its currency differs (an exchange, D25) */
    toAmount: cents.positive().optional(),
    /** Only for the on-budget side of a transfer with an off-budget account (D26) */
    categoryId: id.nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
  })
  .refine((t) => t.fromAccountId !== t.toAccountId, 'Choose two different accounts');

// Imported files are untrusted: validate dates and cap sizes
const importRowSchema = z.object({
  date: isoDate,
  amount: cents,
  payeeName: z.string().max(500).nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
  importedId: z.string().max(500),
});
const importRowsSchema = z.array(importRowSchema).max(100_000);

// GET /transactions — excludes split children; attaches children array to parents
/**
 * Transactions in any of these categories. The list shows split parents (their parts are
 * nested under them), so a split with a part in one of them counts too.
 */
function inCategories(ids: string[]) {
  const parentsWithPart = db
    .select({ id: transactions.parentTransactionId })
    .from(transactions)
    .where(inArray(transactions.categoryId, ids));
  return or(inArray(transactions.categoryId, ids), inArray(transactions.id, parentsWithPart))!;
}

transactionsRouter.get('/', (req, res) => {
  const {
    account_id,
    month,
    from,
    to,
    category_id,
    category_ids,
    category_group_id,
    search,
    reconciled,
  } = req.query as Record<string, string>;

  let query = db.select().from(transactions).$dynamic();

  const conditions: ReturnType<typeof eq>[] = [isNull(transactions.parentTransactionId)];
  if (account_id) conditions.push(eq(transactions.accountId, account_id));
  if (month) {
    conditions.push(gte(transactions.date, `${month}-01`));
    conditions.push(lte(transactions.date, `${month}-31`));
  }
  if (from) conditions.push(gte(transactions.date, from));
  if (to) conditions.push(lte(transactions.date, to));
  if (category_ids) {
    const ids = category_ids.split(',').filter(Boolean);
    if (ids.length) conditions.push(inCategories(ids));
  } else if (category_id) {
    conditions.push(inCategories([category_id]));
  }
  if (category_group_id) {
    const catIds = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.groupId, category_group_id))
      .all()
      .map((r) => r.id);
    if (catIds.length) conditions.push(inCategories(catIds));
  }
  if (search) conditions.push(like(transactions.payeeName, `%${search}%`));
  if (reconciled === '0' || reconciled === '1')
    conditions.push(eq(transactions.reconciled, Number(reconciled)));

  query = query.where(and(...conditions));

  const page = z
    .object({
      limit: z.coerce.number().int().min(1).max(1000).default(200),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({ limit: req.query.limit, offset: req.query.offset });
  if (!page.success) return res.status(400).json({ error: page.error.flatten() });
  const { limit, offset } = page.data;

  const rows = query
    .orderBy(sql`${transactions.date} desc`)
    .limit(limit)
    .offset(offset)
    .all();

  const parentIds = rows.filter((r) => r.isParent === 1).map((r) => r.id);
  const childrenMap = new Map<string, typeof rows>();
  if (parentIds.length) {
    const children = db
      .select()
      .from(transactions)
      .where(inArray(transactions.parentTransactionId, parentIds))
      .all();
    for (const child of children) {
      const pid = child.parentTransactionId!;
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(child);
    }
  }

  // A transfer's other side: its account (is it on budget? which currency?) and amount, which
  // differs from this side's in an exchange
  const otherIds = rows.map((r) => r.transferTransactionId).filter((v): v is string => !!v);
  const others = new Map(
    otherIds.length
      ? db
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            amount: transactions.amount,
          })
          .from(transactions)
          .where(inArray(transactions.id, otherIds))
          .all()
          .map((o) => [o.id, o])
      : [],
  );

  // In accounts in another currency, each row's value in the budget's currency (null while it
  // has no rate); rows in the budget's currency don't have one
  const foreign = foreignCurrencies();
  const withBudgetAmount = <T extends (typeof rows)[number]>(r: T) =>
    foreign.has(r.accountId)
      ? { ...r, budgetAmount: r.fxRate === null ? null : convertCents(r.amount, r.fxRate) }
      : r;

  const result = rows.map((r) => {
    const other = r.transferTransactionId ? others.get(r.transferTransactionId) : undefined;
    return {
      ...withBudgetAmount(r),
      ...(r.isParent === 1
        ? { children: (childrenMap.get(r.id) ?? []).map(withBudgetAmount) }
        : {}),
      ...(other ? { transferAccountId: other.accountId, transferAmount: other.amount } : {}),
    };
  });

  res.json(result);
});

/** A transaction created earlier with this id, shaped like the create response (null if none) */
function alreadyCreated(txId: string) {
  const row = db.select().from(transactions).where(eq(transactions.id, txId)).get();
  if (!row) return null;
  if (row.transferTransactionId) {
    const other = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, row.transferTransactionId))
      .get();
    return other ? [row, other] : [row];
  }
  const children = db
    .select()
    .from(transactions)
    .where(eq(transactions.parentTransactionId, txId))
    .all();
  return children.length ? { ...row, children } : row;
}

// POST /transactions — supports optional splits array
transactionsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { id: txId, payeeName, payeeId, splits, adjustment, ...rest } = parsed.data;
  const existing = txId && alreadyCreated(txId);
  if (existing) return res.status(200).json(existing);

  if (splits && splits.length > 0) {
    const payee = resolvePayee(payeeName, payeeId);
    const finalPayeeId = payee.payeeId;
    const splitSum = splits.reduce((sum, s) => sum + s.amount, 0);
    if (splitSum !== rest.amount) {
      return res.status(400).json({ error: 'Split amounts must equal transaction total' });
    }

    const parentId = txId ?? nanoid();
    const parent = {
      id: parentId,
      ...rest,
      categoryId: null,
      payeeId: finalPayeeId,
      payeeName: payee.payeeName,
      reconciled: 0,
      isParent: 1,
      transferTransactionId: null,
      parentTransactionId: null,
      importedId: null,
      createdAt: new Date().toISOString(),
    };
    const childRows = splits.map((s) => ({
      id: nanoid(),
      accountId: rest.accountId,
      date: rest.date,
      amount: s.amount,
      payeeId: finalPayeeId,
      payeeName: payee.payeeName,
      categoryId: s.categoryId,
      notes: s.notes ?? null,
      reconciled: 0,
      isParent: 0,
      transferTransactionId: null,
      parentTransactionId: parentId,
      importedId: null,
      createdAt: new Date().toISOString(),
    }));
    db.transaction((tx) => {
      tx.insert(transactions).values(parent).run();
      for (const child of childRows) tx.insert(transactions).values(child).run();
    });
    afterTransactionsWritten([parentId]);

    return res.status(201).json({ ...parent, children: childRows });
  }

  // Rules run on manual entries too, but never replace a category or notes the user entered
  const name =
    payeeName ??
    (payeeId ? (db.select().from(payees).where(eq(payees.id, payeeId)).get()?.name ?? null) : null);
  const { transaction, children } = insertNewTransaction(
    {
      accountId: rest.accountId,
      date: rest.date,
      amount: rest.amount,
      payeeId: payeeId ?? null,
      payeeName: name,
      importedPayee: null,
      notes: rest.notes ?? null,
      categoryId: rest.categoryId ?? null,
      importedId: null,
      id: txId,
      isAdjustment: adjustment,
    },
    { keepUserCategory: true, keepUserNotes: true },
  );
  res.status(201).json(children.length ? { ...transaction, children } : transaction);
});

// POST /transactions/transfer — creates linked pair in two accounts
transactionsRouter.post('/transfer', (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = parsed.data.id && alreadyCreated(parsed.data.id);
  if (existing) return res.status(200).json(existing);
  const created = createTransfer(parsed.data);
  if (!created.ok) return res.status(transferStatus(created.reason)).json({ error: created.error });
  res.status(201).json(created.rows);
});

// POST /transactions/import/preview — check for duplicates before importing
transactionsRouter.post('/import/preview', (req, res) => {
  const parsed = z
    .object({ accountId: z.string().max(64), rows: importRowsSchema })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { accountId, rows } = parsed.data;
  const importedIds = rows.map((r) => r.importedId);
  const existingSet = new Set<string | null>();

  if (importedIds.length) {
    const existing = db
      .select({ importedId: transactions.importedId })
      .from(transactions)
      .where(
        and(eq(transactions.accountId, accountId), inArray(transactions.importedId, importedIds)),
      )
      .all();
    for (const e of existing) existingSet.add(e.importedId);
  }

  res.json(rows.map((row) => ({ ...row, isDuplicate: existingSet.has(row.importedId) })));
});

// POST /transactions/import/confirm — insert non-duplicate rows
transactionsRouter.post('/import/confirm', (req, res) => {
  const parsed = z
    .object({ accountId: z.string().max(64), rows: importRowsSchema })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { accountId, rows } = parsed.data;
  if (!db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get()) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const inserted: string[] = [];
  // Rules load once, and rows in another currency are converted together at the end
  const insertOpts = { rules: loadRules(), ctx: buildRuleContext(), deferFx: true };

  // One transaction: all rows or none, and far faster than a commit per row
  db.transaction(() => {
    for (const row of rows) {
      const dup = db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.accountId, accountId), eq(transactions.importedId, row.importedId)),
        )
        .get();
      if (dup) continue;

      const { transaction } = insertNewTransaction(
        {
          accountId,
          date: row.date,
          amount: row.amount,
          payeeId: null,
          payeeName: row.payeeName || null,
          importedPayee: row.payeeName || null,
          notes: row.notes ?? null,
          categoryId: null,
          importedId: row.importedId,
        },
        insertOpts,
      );
      inserted.push(transaction.id);
    }
    afterTransactionsWritten(inserted);
  });

  res.json({ imported: inserted.length, skipped: rows.length - inserted.length });
});

// PUT /transactions/:id
// A split's parts and a transfer's other side are separate rows: keep them in step with
// the row being edited, so budgets and both accounts agree on dates and amounts.
transactionsRouter.put('/:id', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = db.select().from(transactions).where(eq(transactions.id, req.params.id)).get();
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.reconciled === 1)
    return res.status(403).json({ error: 'Cannot modify a reconciled transaction' });

  const { budgetAmount, ...data } = parsed.data;
  const changes = (key: keyof typeof data) =>
    data[key] !== undefined && data[key] !== existing[key];
  if (
    existing.parentTransactionId &&
    (changes('accountId') || changes('date') || changes('amount'))
  ) {
    return res
      .status(400)
      .json({ error: "Change the split transaction's account, date or amount instead of a part" });
  }
  if (existing.isParent === 1 && (changes('amount') || data.categoryId)) {
    return res.status(400).json({ error: 'Edit the parts of a split transaction instead' });
  }
  try {
    db.transaction((tx) => {
      // A transfer's other side keeps step, and the pair must stay valid (D25, D26)
      const side = updateTransferSide(tx, existing, data);
      if (!side.ok) throw new EditRefused(transferStatus(side.reason), side.error);
      if (Object.keys(data).length) {
        tx.update(transactions).set(data).where(eq(transactions.id, existing.id)).run();
      }
      if (existing.isParent === 1) {
        const shared = {
          accountId: data.accountId,
          date: data.date,
          payeeId: data.payeeId,
          payeeName: data.payeeName,
        };
        if (Object.values(shared).some((v) => v !== undefined)) {
          tx.update(transactions)
            .set(shared)
            .where(eq(transactions.parentTransactionId, existing.id))
            .run();
        }
      }
      convertTransactions([existing.id]);
      // Checked against the transaction as edited: a new amount or account decides what's valid
      if (budgetAmount !== undefined) {
        const set = setBudgetAmount(existing.id, budgetAmount);
        if (!set.ok) throw new EditRefused(set.status, set.error);
      }
    });
  } catch (err) {
    if (err instanceof EditRefused) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const updated = db.select().from(transactions).where(eq(transactions.id, req.params.id)).get();
  res.json(updated);
});

// GET /transactions/:id/transfer-candidates — what "Link as transfer" offers: transactions in
// the user's other open accounts that could be this one's other side (D25), closest date first
transactionsRouter.get('/:id/transfer-candidates', (req, res) => {
  const candidates = transferCandidates(req.params.id);
  if (!candidates) return res.status(404).json({ error: 'Not found' });
  res.json(candidates);
});

// POST /transactions/:id/link-transfer — two existing transactions become one transfer (or an
// exchange, between accounts in different currencies), e.g. one bank sync didn't recognize
transactionsRouter.post('/:id/link-transfer', (req, res) => {
  const parsed = z.object({ otherId: id }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const outcome = linkTransfer(req.params.id, parsed.data.otherId);
  if (!outcome.ok) return res.status(transferStatus(outcome.reason)).json({ error: outcome.error });
  res.json(db.select().from(transactions).where(eq(transactions.id, req.params.id)).get());
});

// POST /transactions/:id/unlink-transfer — two ordinary transactions again (e.g. bank sync
// recognized a transfer that wasn't one)
transactionsRouter.post('/:id/unlink-transfer', (req, res) => {
  const outcome = unlinkTransfer(req.params.id);
  if (!outcome.ok) return res.status(transferStatus(outcome.reason)).json({ error: outcome.error });
  res.json(db.select().from(transactions).where(eq(transactions.id, req.params.id)).get());
});

// DELETE /transactions/:id — handles transfer unlinking and split cascade
transactionsRouter.delete('/:id', (req, res) => {
  const existing = db.select().from(transactions).where(eq(transactions.id, req.params.id)).get();
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.reconciled === 1)
    return res.status(403).json({ error: 'Cannot modify a reconciled transaction' });

  deleteTransactionRow(existing);
  res.status(204).send();
});
