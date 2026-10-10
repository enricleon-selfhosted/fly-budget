import { format, isValid, subDays } from 'date-fns';
import type {
  Account,
  AccountType,
  EnableBankingAccount,
  EnableBankingMappingAction,
  EnableBankingSyncResult,
} from '../../types';
import { accountTypeInfo } from '../../utils/accountTypes';
import { accountCurrency } from '../../utils/budgetCurrency';

// Pure logic for the Enable Banking screens: no requests, no store, no clock (the caller
// passes `now`), so it can be tested directly and re-run anywhere.

/** Countries Enable Banking covers in Europe (EEA), by name */
export const EEA_COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IS', name: 'Iceland' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
];

const FALLBACK_COUNTRY = 'ES';

/** History a new account imports unless the user picks an earlier date (D9) */
export const DEFAULT_IMPORT_DAYS = 90;

/** Show a renewal warning when consent ends within this many days */
export const RENEW_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The country to start with: the region of the browser's language when it is in the list
 * ("de-DE" → DE), else Spain.
 */
export function defaultCountry(language: string | undefined): string {
  const region = language
    ?.split('-')
    .slice(1)
    .find((part) => /^[a-z]{2}$/i.test(part))
    ?.toUpperCase();
  return EEA_COUNTRIES.some((c) => c.code === region) ? region! : FALLBACK_COUNTRY;
}

export function countryName(code: string): string {
  return EEA_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** A local calendar date as YYYY-MM-DD (the format the API takes) */
export function isoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function daysAgoIso(days: number, now: Date): string {
  return isoDate(subDays(now, days));
}

export function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

/** The personal/business choices a bank offers; a bank listing neither is taken as personal */
export function psuOptions(psuTypes: string[]): ('personal' | 'business')[] {
  const options = psuTypes.filter(
    (t): t is 'personal' | 'business' => t === 'personal' || t === 'business',
  );
  return options.length > 0 ? [...new Set(options)] : ['personal'];
}

/** The currency a bank account's amounts are in (the budget's when the bank doesn't say) */
export function bankCurrency(account: Pick<EnableBankingAccount, 'currency'>, budget: string) {
  return accountCurrency(account, budget);
}

/** The default for "Off budget": cash and credit accounts are on budget, the rest off */
export function defaultOffBudget(type: AccountType, foreign: boolean): boolean {
  return foreign || !accountTypeInfo(type).onBudget;
}

export type MappingAction = 'create' | 'link' | 'skip';

/** One bank account's choice in the mapping form */
export interface MappingRow {
  action: MappingAction;
  /** New account: its name */
  name: string;
  /** New account: its type */
  type: AccountType;
  /** New account: off budget (always, for another currency) */
  offBudget: boolean;
  /** Existing account: the FlyBudget account ('' = none chosen yet) */
  accountId: string;
  /** Import from (YYYY-MM-DD). On an existing account, '' means the default (D9) */
  syncFrom: string;
}

/** Starting values for one bank account. Already imported → its account; ignored → skip; else new. */
export function initialMappingRow(
  account: EnableBankingAccount,
  budget: string,
  now: Date,
): MappingRow {
  const foreign = bankCurrency(account, budget) !== budget;
  const base = {
    name: account.name,
    type: account.suggestedType,
    offBudget: defaultOffBudget(account.suggestedType, foreign),
  };
  if (account.accountId) {
    return {
      ...base,
      action: 'link',
      accountId: account.accountId,
      syncFrom: account.syncFrom ?? '',
    };
  }
  if (!account.isEnabled) {
    return {
      ...base,
      action: 'skip',
      accountId: '',
      syncFrom: daysAgoIso(DEFAULT_IMPORT_DAYS, now),
    };
  }
  return {
    ...base,
    action: 'create',
    accountId: '',
    syncFrom: daysAgoIso(DEFAULT_IMPORT_DAYS, now),
  };
}

/** The date to start from when an existing account is picked for this bank account */
function linkSyncFrom(account: EnableBankingAccount, accountId: string): string {
  return accountId !== '' && accountId === account.accountId ? (account.syncFrom ?? '') : '';
}

/** The row after the user picks another action, with the date that action starts from */
export function withAction(
  row: MappingRow,
  account: EnableBankingAccount,
  action: MappingAction,
  now: Date,
): MappingRow {
  if (action === row.action) return row;
  if (action === 'create') {
    const syncFrom = row.action === 'create' ? row.syncFrom : daysAgoIso(DEFAULT_IMPORT_DAYS, now);
    return { ...row, action, syncFrom };
  }
  if (action === 'link') {
    return { ...row, action, syncFrom: linkSyncFrom(account, row.accountId) };
  }
  return { ...row, action };
}

/** The row after the user picks another existing account */
export function withLinkedAccount(
  row: MappingRow,
  account: EnableBankingAccount,
  accountId: string,
): MappingRow {
  return { ...row, accountId, syncFrom: linkSyncFrom(account, accountId) };
}

/** An existing account a bank account can be imported into: open, in the same currency, not taken */
export function linkOptions(
  accounts: readonly Account[],
  currency: string,
  budget: string,
  taken: ReadonlySet<string>,
  selectedId: string,
): Account[] {
  return accounts.filter(
    (a) =>
      a.id === selectedId ||
      (!a.closedAt && accountCurrency(a, budget) === currency && !taken.has(a.id)),
  );
}

/**
 * The API action for one bank account, or null when the row isn't complete (a new account
 * without a name, or an existing one not chosen yet).
 */
export function mappingAction(
  account: EnableBankingAccount,
  row: MappingRow,
  budget: string,
): EnableBankingMappingAction | null {
  if (row.action === 'skip') return { id: account.id, action: 'skip' };
  if (row.action === 'link') {
    if (!row.accountId) return null;
    return {
      id: account.id,
      action: 'link',
      accountId: row.accountId,
      syncFrom: row.syncFrom || undefined,
    };
  }
  const accountName = row.name.trim();
  if (!accountName) return null;
  const foreign = bankCurrency(account, budget) !== budget;
  return {
    id: account.id,
    action: 'create',
    accountName,
    accountType: row.type,
    isOffBudget: foreign || row.offBudget ? 1 : 0,
    syncFrom: row.syncFrom || undefined,
  };
}

/** Days left on a bank consent, or null when the end date isn't a valid time */
export function accessLeft(
  validUntil: string,
  now: Date,
): { expired: boolean; days: number } | null {
  const end = new Date(validUntil);
  if (!isValid(end)) return null;
  const ms = end.getTime() - now.getTime();
  return { expired: ms <= 0, days: Math.floor(ms / DAY_MS) };
}

/** "1 account", "2 accounts" */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What a sync brought in, one line per kind that happened */
export function describeSync(
  result: Pick<EnableBankingSyncResult, 'added' | 'matched' | 'transfers'> & { recurring?: number },
): string[] {
  const lines = [`${plural(result.added, 'new transaction')} imported`];
  if (result.matched > 0) {
    lines.push(`${plural(result.matched, 'transaction')} matched to ones you entered`);
  }
  // Optional: older callers and results don't carry it
  const recurring = result.recurring ?? 0;
  if (recurring > 0) {
    const item = recurring === 1 ? 'a recurring item' : 'recurring items';
    lines.push(`${plural(recurring, 'transaction')} matched to ${item}`);
  }
  if (result.transfers > 0) {
    lines.push(`${plural(result.transfers, 'transfer')} linked between your accounts`);
  }
  return lines;
}
