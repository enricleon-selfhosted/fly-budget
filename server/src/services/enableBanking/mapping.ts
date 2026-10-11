import { createHash } from 'crypto';
import { decimalToCents } from '../../utils/money.js';
import { cleanText } from '../../utils/text.js';
import { isRealDate } from '../../utils/validation.js';
import type { AccountType } from '../../utils/accountTypes.js';
import type { RemoteBalance, RemoteTransaction } from '../bankSync/types.js';
import type { EbAccount, EbBalance, EbTransaction } from './schemas.js';

// Pure translation from Enable Banking's JSON to FlyBudget's normalized types.

const PAYEE_MAX = 200;
const NOTES_MAX = 500;
/** PSD2 consents last at most 180 days, banks may allow less */
const MAX_CONSENT_SECONDS = 180 * 24 * 60 * 60;

const normalizeIban = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();

/** SHA-256 of an IBAN: lets transfers be recognized without storing the IBAN */
export function ibanHash(iban: string | null | undefined): string | null {
  const normalized = iban ? normalizeIban(iban) : '';
  return normalized.length >= 8 ? createHash('sha256').update(normalized).digest('hex') : null;
}

/** "ES12 •••• 3456" */
export function maskIban(iban: string | null | undefined): string | null {
  const normalized = iban ? normalizeIban(iban) : '';
  return normalized.length >= 8 ? `${normalized.slice(0, 4)} •••• ${normalized.slice(-4)}` : null;
}

export function suggestAccountType(cashAccountType: string | null | undefined): AccountType {
  switch (cashAccountType) {
    case 'SVGS':
      return 'savings';
    case 'CARD':
      return 'credit';
    case 'LOAN':
      return 'loan';
    default:
      return 'checking';
  }
}

export function accountName(account: EbAccount): string {
  return (
    cleanText(account.name, PAYEE_MAX) ||
    cleanText(account.product, PAYEE_MAX) ||
    cleanText(account.details, PAYEE_MAX) ||
    maskIban(account.account_id?.iban) ||
    'Bank account'
  );
}

/** valid_until for a new consent: as long as the bank allows, at most 180 days, minus a minute */
export function consentValidUntil(maxConsentSeconds: number | null | undefined, nowMs: number) {
  const seconds = Math.min(maxConsentSeconds ?? MAX_CONSENT_SECONDS, MAX_CONSENT_SECONDS);
  return new Date(nowMs + (seconds - 60) * 1000).toISOString();
}

/** The balance that matches booked transactions best, in the order banks usually offer them */
const BALANCE_PREFERENCE = ['CLBD', 'ITBD', 'OPBD', 'XPCD', 'ITAV', 'CLAV', 'OPAV', 'FWAV'];

export function pickBalance(balances: readonly EbBalance[]): RemoteBalance | null {
  const rank = (type: string) => {
    const i = BALANCE_PREFERENCE.indexOf(type);
    return i === -1 ? BALANCE_PREFERENCE.length : i;
  };
  const best = [...balances].sort((a, b) => rank(a.balance_type) - rank(b.balance_type))[0];
  if (!best) return null;
  try {
    return {
      amount: decimalToCents(best.balance_amount.amount),
      currency: best.balance_amount.currency,
      date: best.reference_date && isRealDate(best.reference_date) ? best.reference_date : null,
    };
  } catch {
    return null;
  }
}

type Normalized = Omit<RemoteTransaction, 'externalId'> & { reference: string | null };

/**
 * One booked transaction in FlyBudget's terms, or null when it shouldn't be imported
 * (pending, no usable date, amount that isn't a plain decimal).
 */
export function normalizeTransaction(tx: EbTransaction): Normalized | null {
  if (tx.status !== 'BOOK') return null;
  const date = [tx.booking_date, tx.value_date, tx.transaction_date].find(
    (d): d is string => !!d && isRealDate(d),
  );
  if (!date) return null;

  let cents: number;
  try {
    // The amount should be unsigned with the direction in the indicator; some banks sign it anyway
    cents = Math.abs(decimalToCents(tx.transaction_amount.amount.trim()));
  } catch {
    return null;
  }
  const outflow = tx.credit_debit_indicator === 'DBIT';
  const counterparty = outflow ? tx.creditor : tx.debtor;
  const counterpartyAccount = outflow ? tx.creditor_account : tx.debtor_account;

  const remittance = cleanText((tx.remittance_information ?? []).join(' '), NOTES_MAX);
  const name = cleanText(counterparty?.name, PAYEE_MAX);
  const bankText =
    name ||
    cleanText(remittance, PAYEE_MAX) ||
    cleanText(tx.bank_transaction_code?.description, PAYEE_MAX) ||
    cleanText(tx.note, PAYEE_MAX);

  return {
    reference: cleanText(tx.entry_reference, 200) || null,
    date,
    amount: outflow ? -cents || 0 : cents,
    currency: tx.transaction_amount.currency,
    payeeName: bankText || 'Unknown',
    importedPayee: bankText || 'Unknown',
    // When the payee came from the remittance text, don't repeat it as notes
    notes: name && remittance ? remittance : null,
    counterpartyAccountHash: ibanHash(counterpartyAccount?.iban),
  };
}

/**
 * Gives each transaction an id that stays the same on every fetch: the bank's entry_reference
 * (unique and immutable per account), else a hash of what the bank says about it, numbered
 * when identical transactions repeat on one day.
 */
export function withExternalIds(normalized: readonly Normalized[]): RemoteTransaction[] {
  const occurrences = new Map<string, number>();
  return normalized.map(({ reference, ...tx }) => {
    if (reference) return { ...tx, externalId: `ref:${reference}` };
    const content = createHash('sha256')
      .update(
        JSON.stringify([
          tx.date,
          tx.amount,
          tx.currency,
          tx.importedPayee,
          tx.notes,
          tx.counterpartyAccountHash,
        ]),
      )
      .digest('hex')
      .slice(0, 32);
    const n = (occurrences.get(content) ?? 0) + 1;
    occurrences.set(content, n);
    return { ...tx, externalId: `hash:${content}:${n}` };
  });
}
