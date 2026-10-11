import type { EnableBankingApi } from './client.js';
import type { ConsentRegistry } from './consent.js';
import { EnableBankingError, NotFoundError, ReauthRequiredError } from './errors.js';
import { accountName, consentValidUntil, ibanHash, maskIban } from './mapping.js';
import type { EbAspsp } from './schemas.js';
import { enableBankingStore, type BankAccountInfo } from './store.js';

// Connecting a bank: send the user to consent, turn the bank's answer into a connection (or
// renew one in place, decision D18), and disconnecting.

export type ConsentInfo = {
  aspsp: { name: string; country: string };
  /** The connection to renew; null adds a new one */
  connectionId: string | null;
};
export type ConsentResult = { connectionId: string; renewed: boolean };

export type ConnectDeps = {
  api: EnableBankingApi;
  now: () => number;
  consents: ConsentRegistry<ConsentInfo, ConsentResult>;
  redirectUrl: string;
  listBanks: (country: string) => Promise<EbAspsp[]>;
};

export type StartConsentInput = {
  aspspName: string;
  country: string;
  psuType?: 'personal' | 'business';
  connectionId?: string;
};

export async function startConsent(input: StartConsentInput, deps: ConnectDeps) {
  let aspsp = { name: input.aspspName, country: input.country };
  let connectionId: string | null = null;
  if (input.connectionId) {
    const connection = enableBankingStore.getConnection(input.connectionId);
    if (!connection) throw new NotFoundError('That connection doesn’t exist anymore.');
    aspsp = { name: connection.aspspName, country: connection.aspspCountry };
    connectionId = connection.id;
  } else {
    // One connection per bank: a new consent replaces the old one at many banks anyway
    connectionId = enableBankingStore.findConnectionByBank(aspsp.name, aspsp.country)?.id ?? null;
  }

  const bank = (await deps.listBanks(aspsp.country)).find((b) => b.name === aspsp.name);
  if (!bank) throw new NotFoundError('Enable Banking doesn’t list this bank. Pick it again.');
  const psuType =
    input.psuType === 'business' && bank.psu_types?.includes('business') ? 'business' : 'personal';

  const { id, state } = deps.consents.begin({ aspsp, connectionId });
  try {
    const { url } = await deps.api.startAuthorization({
      aspsp,
      validUntil: consentValidUntil(bank.maximum_consent_validity, deps.now()),
      state,
      redirectUrl: deps.redirectUrl,
      psuType,
    });
    return { id, url };
  } catch (err) {
    deps.consents.cancel(id);
    throw err;
  }
}

/** Exchanges the code the bank sent back for a session and records its accounts */
export async function finishConsent(
  info: ConsentInfo,
  code: string,
  api: EnableBankingApi,
  now: () => number = Date.now,
): Promise<ConsentResult> {
  const session = await api.createSession(code);
  const uids = session.accounts.every((a) => a.uid)
    ? new Map<string, string>()
    : await api.getSessionAccounts(session.session_id);

  const accounts: BankAccountInfo[] = [];
  for (const a of session.accounts) {
    const accountUid = a.uid ?? uids.get(a.identification_hash);
    if (!accountUid) continue;
    accounts.push({
      accountUid,
      identificationHash: a.identification_hash,
      name: accountName(a),
      ibanMask: maskIban(a.account_id?.iban),
      ibanHash: ibanHash(a.account_id?.iban),
      currency: a.currency,
      cashAccountType: a.cash_account_type ?? null,
    });
  }
  if (!accounts.length)
    throw new EnableBankingError('No accounts in session', 200, 'NO_ACCOUNTS_ADDED');

  const validUntil = session.access.valid_until;
  const at = new Date(now()).toISOString();
  const existing = info.connectionId ? enableBankingStore.getConnection(info.connectionId) : null;
  if (existing) {
    const previous = enableBankingStore.getSessionId(existing.id);
    enableBankingStore.renewConnection(existing.id, { sessionId: session.session_id, validUntil });
    enableBankingStore.bindAccounts(existing.id, accounts, at);
    // Best effort: many banks already ended it when the new consent was given
    if (previous && previous !== session.session_id) api.deleteSession(previous).catch(() => {});
    return { connectionId: existing.id, renewed: true };
  }

  const connectionId = enableBankingStore.insertConnection(
    {
      sessionId: session.session_id,
      aspspName: session.aspsp.name,
      aspspCountry: session.aspsp.country,
      validUntil,
    },
    at,
  );
  enableBankingStore.bindAccounts(connectionId, accounts, at);
  return { connectionId, renewed: false };
}

/**
 * Ends the session at Enable Banking first, then forgets the connection. If Enable Banking
 * can't be reached the connection stays, so the user can try again; a session that already
 * ended is simply forgotten. Imported accounts and transactions stay.
 */
export async function disconnect(connectionId: string, api: EnableBankingApi) {
  const sessionId = enableBankingStore.getSessionId(connectionId);
  if (sessionId === null) throw new NotFoundError('That connection doesn’t exist anymore.');
  try {
    await api.deleteSession(sessionId);
  } catch (err) {
    if (!(err instanceof ReauthRequiredError)) throw err;
  }
  enableBankingStore.deleteConnection(connectionId);
}

/** The code and state from the address of the page the bank sent the user to */
export function parseRedirect(address: string): { code?: string; state?: string; error?: string } {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return {};
  }
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  return { code: get('code'), state: get('state'), error: get('error') };
}
