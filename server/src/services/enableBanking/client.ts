import type { z } from 'zod';
import { readTextLimited } from '../safeFetch.js';
import { createJwtSigner } from './jwt.js';
import { EnableBankingError, errorFromResponse } from './errors.js';
import {
  applicationSchema,
  aspspsResponseSchema,
  balancesResponseSchema,
  errorSchema,
  sessionDetailsSchema,
  sessionResponseSchema,
  startAuthorizationResponseSchema,
  transactionsPageSchema,
  type EbApplication,
  type EbAspsp,
  type EbBalance,
  type EbSession,
} from './schemas.js';

// One function per Enable Banking endpoint FlyBudget uses. `fetch` and the clock are passed
// in, so tests exercise this through its interface with a fake server.

export const ENABLE_BANKING_API = 'https://api.enablebanking.com';
const TIMEOUT_MS = 30_000;

/** Headers telling the bank the user is present (PSD2 then doesn't count the read as unattended) */
export type PsuHeaders = Record<'Psu-Ip-Address' | 'Psu-User-Agent', string>;

export type StartAuthorization = {
  aspsp: { name: string; country: string };
  validUntil: string;
  state: string;
  redirectUrl: string;
  psuType: 'personal' | 'business';
};

export interface EnableBankingApi {
  getApplication(): Promise<EbApplication>;
  listAspsps(country: string): Promise<EbAspsp[]>;
  startAuthorization(req: StartAuthorization): Promise<{ url: string; authorizationId: string }>;
  createSession(code: string): Promise<EbSession>;
  /** uid of each account in the session, by identification_hash */
  getSessionAccounts(sessionId: string): Promise<Map<string, string>>;
  deleteSession(sessionId: string): Promise<void>;
  getBalances(accountUid: string, psu?: PsuHeaders): Promise<EbBalance[]>;
  getTransactions(
    accountUid: string,
    query: { dateFrom: string; continuationKey?: string },
    psu?: PsuHeaders,
  ): Promise<{ transactions: unknown[]; continuationKey: string | null }>;
}

export type ClientOptions = {
  applicationId: string;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
};

export function createEnableBankingClient(options: ClientOptions): EnableBankingApi {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? ENABLE_BANKING_API;
  const jwt = createJwtSigner(options.applicationId, options.privateKey, options.now);

  async function call<T extends z.ZodType>(
    schema: T,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    { body, psu }: { body?: unknown; psu?: PsuHeaders } = {},
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await doFetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${jwt()}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...psu,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new EnableBankingError(`Enable Banking unreachable: ${(err as Error).message}`);
    }

    let json: unknown;
    try {
      // The global and undici Response types differ only in typing
      const raw = await readTextLimited(
        response as unknown as Parameters<typeof readTextLimited>[0],
      );
      json = raw ? JSON.parse(raw) : {};
    } catch (err) {
      throw new EnableBankingError(
        `Unreadable response: ${(err as Error).message}`,
        response.status,
      );
    }

    if (!response.ok) {
      const parsed = errorSchema.safeParse(json);
      const code = parsed.success ? (parsed.data.error ?? null) : null;
      const message = parsed.success ? (parsed.data.message ?? '') : '';
      throw errorFromResponse(
        response.status,
        code,
        `${method} ${path}: ${response.status} ${code ?? ''} ${message}`.trim(),
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new EnableBankingError(`Unexpected response from ${method} ${path}`, response.status);
    return parsed.data;
  }

  const account = (uid: string) => `/accounts/${encodeURIComponent(uid)}`;

  return {
    getApplication: () => call(applicationSchema, 'GET', '/application'),

    async listAspsps(country) {
      const query = new URLSearchParams({ country, service: 'AIS' });
      return (await call(aspspsResponseSchema, 'GET', `/aspsps?${query}`)).aspsps;
    },

    async startAuthorization(req) {
      const res = await call(startAuthorizationResponseSchema, 'POST', '/auth', {
        body: {
          access: { valid_until: req.validUntil },
          aspsp: req.aspsp,
          state: req.state,
          redirect_url: req.redirectUrl,
          psu_type: req.psuType,
        },
      });
      return { url: res.url, authorizationId: res.authorization_id };
    },

    createSession: (code) => call(sessionResponseSchema, 'POST', '/sessions', { body: { code } }),

    async getSessionAccounts(sessionId) {
      const res = await call(
        sessionDetailsSchema,
        'GET',
        `/sessions/${encodeURIComponent(sessionId)}`,
      );
      return new Map((res.accounts_data ?? []).map((a) => [a.identification_hash, a.uid]));
    },

    async deleteSession(sessionId) {
      await call(errorSchema.partial(), 'DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
    },

    async getBalances(accountUid, psu) {
      return (await call(balancesResponseSchema, 'GET', `${account(accountUid)}/balances`, { psu }))
        .balances;
    },

    async getTransactions(accountUid, { dateFrom, continuationKey }, psu) {
      const query = new URLSearchParams({ date_from: dateFrom });
      if (continuationKey) query.set('continuation_key', continuationKey);
      const res = await call(
        transactionsPageSchema,
        'GET',
        `${account(accountUid)}/transactions?${query}`,
        { psu },
      );
      return { transactions: res.transactions, continuationKey: res.continuation_key ?? null };
    },
  };
}
