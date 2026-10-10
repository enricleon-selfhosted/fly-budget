// What makes two transactions a valid transfer, and how its sides behave (decisions D25, D26).
// Pure: callers pass the rows and their accounts.

export type TransferAccount = { id: string; currency: string | null; isOffBudget: number };
export type TransferSide = { amount: number; account: TransferAccount };

/** Accounts in one currency (null = the budget's): a transfer between them moves one amount */
export function sameCurrency(a: TransferAccount, b: TransferAccount): boolean {
  return a.currency === b.currency;
}

/**
 * Why two transactions can't be the two sides of one transfer, or null if they can: different
 * accounts, money out on one side and in on the other, and — within one currency — the same
 * amount. Across currencies (an exchange) each side keeps its own amount.
 */
export function transferPairProblem(a: TransferSide, b: TransferSide): string | null {
  if (a.account.id === b.account.id) return 'Both sides are in the same account';
  if (a.amount === 0 || b.amount === 0 || Math.sign(a.amount) === Math.sign(b.amount))
    return 'A transfer takes money out of one account and puts it into the other';
  if (sameCurrency(a.account, b.account) && a.amount !== -b.amount)
    return 'Both sides of a transfer in one currency have the same amount';
  return null;
}

/**
 * Whether this side of a transfer can have a category: only the on-budget side of a transfer
 * with an off-budget account, because only then does money enter or leave the budget.
 */
export function sideTakesCategory(self: TransferAccount, other: TransferAccount): boolean {
  return self.isOffBudget === 0 && other.isOffBudget === 1;
}

/** Whether editing one side's amount changes the other's (not for exchanges) */
export function mirrorsAmount(a: TransferAccount, b: TransferAccount): boolean {
  return sameCurrency(a, b);
}
