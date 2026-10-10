// Transfers across currencies (exchanges, D25) and across the budget boundary (D26). Pure: the
// server applies the same rules (server/src/utils/transferRules.ts), these only drive the screens.
import { formatCurrency } from './currency';

/** Whether a transfer between two accounts is an exchange: their currencies differ (D25) */
export function isExchange(
  a: { currency: string | null },
  b: { currency: string | null },
): boolean {
  return (a.currency ?? null) !== (b.currency ?? null);
}

/**
 * Whether one account's side of a transfer may carry a category: it is on budget and the other
 * account is off budget, so the money enters or leaves the budget (D26).
 */
export function budgetSideTakesCategory(
  self: { isOffBudget: number },
  other: { isOffBudget: number },
): boolean {
  return self.isOffBudget === 0 && other.isOffBudget === 1;
}

/** Whether a transfer between these accounts crosses the budget boundary (exactly one is off budget) */
export function crossesBudgetBoundary(a: { isOffBudget: number }, b: { isOffBudget: number }) {
  return budgetSideTakesCategory(a, b) || budgetSideTakesCategory(b, a);
}

/** What the budget side's category means, from the direction of the money */
export function budgetSideHint(moneyComesIn: boolean): string {
  return moneyComesIn
    ? 'Money coming into your budget is usually income'
    : 'Money leaving your budget is spending';
}

/**
 * How much of the received currency one unit of the sent currency bought: |to| / |from|, rounded
 * to four decimals (1.1605 for GBP to EUR). Null when either amount is zero, or the rate would
 * round to zero (a rate of 0.0000 says nothing).
 */
export function exchangeRate(fromCents: number, toCents: number): number | null {
  const from = Math.abs(fromCents);
  const to = Math.abs(toCents);
  if (from === 0 || to === 0) return null;
  const rate = Math.round((to / from) * 10_000) / 10_000;
  return rate > 0 ? rate : null;
}

const rateFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * "GBP 500.00 → EUR 580.25 · 1 GBP = 1.1605 EUR": what was sent, what arrived and the rate. The
 * codes are the accounts' own currencies (pass the budget's code for accounts without one).
 */
export function exchangeLabel(
  sent: { cents: number; code: string },
  received: { cents: number; code: string },
): string {
  const amounts = `${formatCurrency(Math.abs(sent.cents), sent.code)} → ${formatCurrency(Math.abs(received.cents), received.code)}`;
  const rate = exchangeRate(sent.cents, received.cents);
  if (rate === null) return amounts;
  return `${amounts} · 1 ${sent.code} = ${rateFormat.format(rate)} ${received.code}`;
}
