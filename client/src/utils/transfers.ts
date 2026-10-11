// Transfers across currencies (exchanges, D25) and across the budget boundary (D26). Pure: the
// server applies the same rules (server/src/utils/transferRules.ts), these only drive the screens.
import type { CreateTransferData } from '../api/transactions';
import type { Transaction } from '../types';
import { formatCurrency } from './currency';

/** What the transfer rules look at in an account */
export interface TransferAccount {
  /** null = the budget's */
  currency: string | null;
  isOffBudget: number;
}

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

/**
 * Whether "Link as transfer" can pair this transaction with another: a plain one, not already a
 * transfer, a split or one of its parts, a balance correction, or reconciled. The server refuses
 * the rest (linkableProblem in server/src/utils/transferRules.ts, used by linkTransfer in
 * services/transactionHelpers.ts).
 */
export function canLinkAsTransfer(
  tx: Pick<
    Transaction,
    'transferTransactionId' | 'reconciled' | 'isParent' | 'parentTransactionId' | 'isAdjustment'
  >,
): boolean {
  return (
    !tx.transferTransactionId &&
    tx.reconciled !== 1 &&
    tx.isParent !== 1 &&
    !tx.parentTransactionId &&
    !tx.isAdjustment
  );
}

/** A transfer typed in from one account's side (the register row or the add dialog) */
export interface TransferInput {
  /** The account the amount was typed in */
  accountId: string;
  /** The account on the other side */
  otherAccountId: string;
  /** The typed amount, from `accountId`'s side: negative when money leaves it */
  signedAmount: number;
  /** An exchange's other side: what the other account received or sent, in its currency */
  otherAmount?: number;
  /** The on-budget side's category, for a transfer with an off-budget account (D26) */
  categoryId?: string | null;
  date: string;
  notes?: string | null;
  id?: string;
}

/**
 * The request for a new transfer (POST /transactions/transfer). The server takes the sending side
 * first: `amount` is what left it and, for an exchange, `toAmount` what arrived (D25); within one
 * currency both sides move the same amount, so there's no `toAmount`. A category is sent only for
 * a transfer across the budget's edge, where the on-budget side may have one (D26).
 */
export function transferRequest(
  input: TransferInput,
  accounts: { self: TransferAccount; other: TransferAccount },
): CreateTransferData {
  const { self, other } = accounts;
  const typed = Math.abs(input.signedAmount);
  const otherAmount = input.otherAmount === undefined ? undefined : Math.abs(input.otherAmount);
  // Money leaves the typed account on an outflow; on an inflow the other account sends it
  const selfSends = input.signedAmount <= 0;
  const exchange = isExchange(self, other) && otherAmount !== undefined;
  const sent = exchange && !selfSends ? otherAmount : typed;
  const received = exchange ? (selfSends ? otherAmount : typed) : undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    fromAccountId: selfSends ? input.accountId : input.otherAccountId,
    toAccountId: selfSends ? input.otherAccountId : input.accountId,
    date: input.date,
    amount: sent,
    ...(received === undefined ? {} : { toAmount: received }),
    ...(crossesBudgetBoundary(self, other) && input.categoryId !== undefined
      ? { categoryId: input.categoryId }
      : {}),
    notes: input.notes ?? null,
  };
}
