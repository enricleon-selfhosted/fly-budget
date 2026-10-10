import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { budgetSettings } from '../../db/schema.js';

// The budget's own settings, stored with the budget (docs/multi-currency M2). One row.

const ID = 'budget';

export type BudgetSettings = {
  currency: string | null;
  downloadRates: boolean;
  ratesUpdatedAt: string | null;
  ratesError: string | null;
};

export function getBudgetSettings(): BudgetSettings {
  const row = db.select().from(budgetSettings).where(eq(budgetSettings.id, ID)).get();
  return {
    currency: row?.currency ?? null,
    downloadRates: row?.downloadRates === 1,
    ratesUpdatedAt: row?.ratesUpdatedAt ?? null,
    ratesError: row?.ratesError ?? null,
  };
}

/** The budget's currency, null until a client has sent it */
export const budgetCurrency = () => getBudgetSettings().currency;

export function saveBudgetSettings(patch: Partial<BudgetSettings>) {
  const values: Partial<typeof budgetSettings.$inferInsert> = {};
  if (patch.currency !== undefined) values.currency = patch.currency;
  if (patch.downloadRates !== undefined) values.downloadRates = patch.downloadRates ? 1 : 0;
  if (patch.ratesUpdatedAt !== undefined) values.ratesUpdatedAt = patch.ratesUpdatedAt;
  if (patch.ratesError !== undefined) values.ratesError = patch.ratesError;
  db.insert(budgetSettings)
    .values({ id: ID, ...values })
    .onConflictDoUpdate({ target: budgetSettings.id, set: values })
    .run();
}
