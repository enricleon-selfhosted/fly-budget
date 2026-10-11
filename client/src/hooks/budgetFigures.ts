import type { QueryClient } from '@tanstack/react-query';

// The cached queries a write can move, in one place so every mutation refreshes the same set.

/**
 * Everything built from transactions' amounts in the budget: balances, the budget, reports and
 * the Currencies overview (its "waiting for a rate" counts). A write that changes a transaction's
 * account, date, amount, category, transfer link or converted value, an account's currency or
 * budget status, the budget's currency or a rate (docs/multi-currency M5, M8) refreshes them all.
 */
const BUDGET_FIGURES = [
  'accounts',
  'transactions',
  'budget',
  'budget-summary',
  'category-history',
  'reports',
  'dashboards',
  'goals',
  'currencies',
] as const;

/** Recurring items and their occurrences, which imports and transfers can pay or match */
const RECURRING = [
  'schedules',
  'schedule-occurrences',
  'schedule-summary',
  'match-suggestions',
] as const;

export function refreshBudgetFigures(qc: QueryClient) {
  for (const key of BUDGET_FIGURES) qc.invalidateQueries({ queryKey: [key] });
}

export function refreshRecurring(qc: QueryClient) {
  for (const key of RECURRING) qc.invalidateQueries({ queryKey: [key] });
}
