import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createEnableBankingClient } from './client.js';
import {
  ConfigurationError,
  EnableBankingError,
  RateLimitedError,
  ReauthRequiredError,
  enableBankingErrorMessage,
} from './errors.js';

// The client through its interface, against a fake Enable Banking: what it sends, what it
// returns, and which error each failure becomes.

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeServer(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    client: createEnableBankingClient({ applicationId: 'app-1', privateKey: pem, fetch }),
  };
}

describe('requests', () => {
  it('signs every request and starts a consent with the expected body', async () => {
    const { calls, client } = fakeServer(() => ({
      body: { url: 'https://auth.enablebanking.com/start?x=1', authorization_id: 'auth-1' },
    }));
    const started = await client.startAuthorization({
      aspsp: { name: 'BBVA', country: 'ES' },
      validUntil: '2026-06-01T00:00:00.000Z',
      state: 'state-123',
      redirectUrl: 'https://budget.example.com/api/enablebanking/callback',
      psuType: 'personal',
    });

    expect(started).toEqual({
      url: 'https://auth.enablebanking.com/start?x=1',
      authorizationId: 'auth-1',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.enablebanking.com/auth',
      body: {
        access: { valid_until: '2026-06-01T00:00:00.000Z' },
        aspsp: { name: 'BBVA', country: 'ES' },
        state: 'state-123',
        redirect_url: 'https://budget.example.com/api/enablebanking/callback',
        psu_type: 'personal',
      },
    });
    expect(calls[0].headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('pages transactions with the continuation key and passes PSU headers', async () => {
    const { calls, client } = fakeServer(() => ({
      body: { transactions: [{}], continuation_key: 'k2' },
    }));
    const psu = { 'Psu-Ip-Address': '203.0.113.9', 'Psu-User-Agent': 'Firefox' };
    const page = await client.getTransactions(
      'uid/1',
      { dateFrom: '2026-01-01', continuationKey: 'k1' },
      psu,
    );

    expect(page).toEqual({ transactions: [{}], continuationKey: 'k2' });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/accounts/uid%2F1/transactions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      date_from: '2026-01-01',
      continuation_key: 'k1',
    });
    expect(calls[0].headers).toMatchObject(psu);
  });

  it('refuses a consent page that is not https', async () => {
    const { client } = fakeServer(() => ({
      body: { url: 'http://evil.example/start', authorization_id: 'a' },
    }));
    await expect(
      client.startAuthorization({
        aspsp: { name: 'X', country: 'FI' },
        validUntil: 'x',
        state: 's',
        redirectUrl: 'https://x',
        psuType: 'personal',
      }),
    ).rejects.toThrow(EnableBankingError);
  });

  it('maps session accounts by their stable identification hash', async () => {
    const { client } = fakeServer(() => ({
      body: { status: 'AUTHORIZED', accounts_data: [{ uid: 'u1', identification_hash: 'h1' }] },
    }));
    expect(await client.getSessionAccounts('s')).toEqual(new Map([['h1', 'u1']]));
  });
});

describe('errors', () => {
  const failing = (status: number, body: unknown) =>
    fakeServer(() => ({ status, body })).client.getBalances('uid');

  it.each([
    [401, { error: 'EXPIRED_SESSION', message: 'gone' }, ReauthRequiredError],
    [400, { error: 'REVOKED_SESSION' }, ReauthRequiredError],
    [429, { message: 'slow down' }, RateLimitedError],
    [400, { error: 'ASPSP_RATE_LIMIT_EXCEEDED' }, RateLimitedError],
    [401, { error: 'UNAUTHORIZED_ACCESS' }, ConfigurationError],
    [400, { error: 'REDIRECT_URI_NOT_ALLOWED' }, ConfigurationError],
    [500, 'not json', EnableBankingError],
  ])('a %i %j becomes the right error type', async (status, body, type) => {
    await expect(failing(status, body)).rejects.toBeInstanceOf(type);
  });

  it('a network failure says Enable Banking could not be reached', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const client = createEnableBankingClient({ applicationId: 'a', privateKey: pem, fetch });
    const err = await client.getApplication().catch((e) => e);
    expect(err).toBeInstanceOf(EnableBankingError);
    expect(enableBankingErrorMessage(err, 'fallback')).toMatch(/Could not reach Enable Banking/);
  });

  it('a response that does not look like the API is an error, not data', async () => {
    await expect(
      fakeServer(() => ({ body: { balances: 'nope' } })).client.getBalances('u'),
    ).rejects.toThrow(EnableBankingError);
  });

  it('never puts the session id in an error message (they are logged)', async () => {
    const { client } = fakeServer(() => ({ status: 500, body: { error: 'ASPSP_ERROR' } }));
    const errors = await Promise.all([
      client.deleteSession('SECRET-SESSION-ID').catch((e) => e),
      client.getSessionAccounts('SECRET-SESSION-ID').catch((e) => e),
    ]);
    for (const err of errors) {
      expect(err).toBeInstanceOf(EnableBankingError);
      expect(String(err.message)).not.toContain('SECRET-SESSION-ID');
      expect(String(err.message)).toContain('/sessions/');
    }
  });

  it('never shows Enable Banking’s own wording to the user', async () => {
    const err = await failing(400, {
      error: 'WRONG_REQUEST_PARAMETERS',
      message: 'internal detail',
    }).catch((e) => e);
    expect(enableBankingErrorMessage(err, 'Sync failed')).toBe('Sync failed');
    expect(String(err.message)).toContain('internal detail');
  });
});
