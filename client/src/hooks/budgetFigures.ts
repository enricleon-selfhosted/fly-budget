import type { QueryClient } from '@tanstack/react-query';

// The cached queries a write can move, in one place so every mutation refreshes the same set.

/**
 * Everything built from transactions' amounts in the budget: balances, the budget and reports. A
 * write that links or creates transfers (an exchange, or money entering or leaving the budget with
 * a category, D25/D26) or imports bank transactions refreshes them all.
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
