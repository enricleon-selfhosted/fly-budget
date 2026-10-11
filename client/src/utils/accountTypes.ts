import { ACCOUNT_TYPES, type AccountType, type AccountTypeInfo } from '../types';

const BY_TYPE = new Map(ACCOUNT_TYPES.map((t) => [t.value, t]));

/** Unknown types (e.g. from a newer version's backup) are treated as other assets */
export function accountTypeInfo(type: string): AccountTypeInfo {
  return BY_TYPE.get(type as AccountTypeInfo['value']) ?? BY_TYPE.get('other_asset')!;
}

export function isLiabilityType(type: string): boolean {
  return accountTypeInfo(type).liability;
}

export function accountTypeLabel(type: string): string {
  return BY_TYPE.get(type as AccountTypeInfo['value'])?.label ?? type;
}

/**
 * Whether a new account starts off budget: cash and credit accounts start on budget, the rest
 * off, and so does any account in another currency (docs/multi-currency M1). It's only where the
 * box starts: the user can tick it either way. The server applies the same default when a request
 * leaves `isOffBudget` out (its `startsOffBudget`).
 */
export function startsOffBudget(type: AccountType, foreign: boolean): boolean {
  return foreign || !accountTypeInfo(type).onBudget;
}
