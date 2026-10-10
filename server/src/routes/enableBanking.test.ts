import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { generateKeyPairSync } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../db/index.js';
import {
  accounts,
  enableBankingAccounts,
  enableBankingConfig,
  enableBankingConnections,
  transactions,
} from '../db/schema.js';
import { apiTokenGuard, hostGuard, originGuard } from '../middleware/security.js';
import type { EnableBankingApi, StartAuthorization } from '../services/enableBanking/client.js';
import { EnableBankingError, ReauthRequiredError } from '../services/enableBanking/errors.js';
import { ibanHash } from '../services/enableBanking/mapping.js';
import { createEnableBankingService } from '../services/enableBanking/service.js';
import { accountsRouter } from './accounts.js';
import {
  ENABLE_BANKING_CALLBACK_PATH,
  createEnableBankingCallback,
  createEnableBankingRouter,
} from './enableBanking.js';

// The whole Enable Banking feature through its HTTP interface, against a fake Enable Banking
// injected into the service. Its own file, so the database holds only this test's data.

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const REDIRECT = 'https://budget.example.com/api/enablebanking/callback';
const IBAN_CHECKING = 'ES9121000418450200051332';
const IBAN_SAVINGS = 'ES7921000813610123456789';

type RawTx = Record<string, unknown>;

/** A fake Enable Banking: what FlyBudget asked for, and what it answers */
function fakeEnableBanking() {
  const fake = {
    app: {
      name: 'Mine',
      kid: 'app-12345678',
      environment: 'PRODUCTION' as const,
      active: true,
      redirect_urls: [REDIRECT],
    },
    auths: [] as StartAuthorization[],
    /** code → the session it creates */
    codes: new Map<
      string,
      {
        id: string;
        accounts: { uid: string; hash: string; iban: string; name: string; currency?: string }[];
      }
    >(),
    transactions: new Map<string, RawTx[]>(),
    balances: new Map<string, string>(),
    deleted: [] as string[],
    failSync: null as Error | null,
    failDelete: null as Error | null,
    reads: 0,
  };
  const api: EnableBankingApi = {
    async getApplication() {
      return fake.app;
    },
    async listAspsps(country) {
      return [
        {
          name: 'BBVA',
          country,
          maximum_consent_validity: 90 * 86_400,
          psu_types: ['personal', 'business'],
        },
        { name: 'CaixaBank', country, beta: true },
      ];
    },
    async startAuthorization(req) {
      fake.auths.push(req);
      return {
        url: `https://auth.example/${fake.auths.length}`,
        authorizationId: `auth-${fake.auths.length}`,
      };
    },
    async createSession(code) {
      const session = fake.codes.get(code);
      if (!session) throw new EnableBankingError('bad code', 400, 'WRONG_AUTHORIZATION_CODE');
      return {
        session_id: session.id,
        aspsp: { name: 'BBVA', country: 'ES' },
        access: { valid_until: '2099-01-01T00:00:00Z' },
        accounts: session.accounts.map((a) => ({
          uid: a.uid,
          identification_hash: a.hash,
          account_id: { iban: a.iban },
          name: a.name,
          currency: a.currency ?? 'EUR',
          cash_account_type: 'CACC',
        })),
      };
    },
    async getSessionAccounts() {
      return new Map();
    },
    async deleteSession(id) {
      if (fake.failDelete) throw fake.failDelete;
      fake.deleted.push(id);
    },
    async getBalances(uid) {
      const amount = fake.balances.get(uid);
      return amount ? [{ balance_type: 'CLBD', balance_amount: { currency: 'EUR', amount } }] : [];
    },
    async getTransactions(uid, { dateFrom }) {
      fake.reads++;
      if (fake.failSync) throw fake.failSync;
      return {
        transactions: (fake.transactions.get(uid) ?? []).filter(
          (t) => String(t.booking_date) >= dateFrom,
        ),
        continuationKey: null,
      };
    },
  };
  return { fake, api };
}

let now = Date.parse('2026-03-20T10:00:00Z');
// One fake for the whole file: the tests below are one story (set up, connect, sync, disconnect)
const { fake, api } = fakeEnableBanking();
let server: Server;
let base: string;

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const service = createEnableBankingService({ makeApi: () => api, now: () => now });
  const app = express();
  app.use(express.json());
  // Same order as index.ts: host guard, the callback, then the other guards (desktop token on)
  app.use(hostGuard);
  app.get(ENABLE_BANKING_CALLBACK_PATH, createEnableBankingCallback(service));
  app.use(originGuard);
  app.use(apiTokenGuard('desktop-token'));
  app.use('/api/enablebanking', createEnableBankingRouter(service));
  app.use('/api/accounts', accountsRouter);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: 'flybudget_token=desktop-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** The browser coming back from the bank: cross-site, no app cookie */
const bankRedirect = (query: string) =>
  fetch(`${base}${ENABLE_BANKING_CALLBACK_PATH}?${query}`, {
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
  });

async function configure() {
  const res = await call('PUT', '/api/enablebanking/config', {
    applicationId: 'app-12345678',
    privateKey: pem,
    redirectUrl: REDIRECT,
  });
  expect(res.status).toBe(200);
}

/** Consents at the fake bank and comes back through the callback; returns the consent result */
async function connect(
  code: string,
  session: typeof fake.codes extends Map<string, infer S> ? S : never,
  extra = {},
) {
  fake.codes.set(code, session);
  const started = await call('POST', '/api/enablebanking/authorizations', {
    aspspName: 'BBVA',
    country: 'ES',
    ...extra,
  });
  expect(started.status).toBe(201);
  const state = fake.auths.at(-1)!.state;
  expect((await bankRedirect(`code=${code}&state=${state}`)).status).toBe(200);
  const polled = await call('GET', `/api/enablebanking/authorizations/${started.body.id}`);
  expect(polled.body.status).toBe('complete');
  return polled.body.result;
}

const booked = (
  ref: string,
  date: string,
  amount: string,
  dir: 'CRDT' | 'DBIT',
  extra: RawTx = {},
) => ({
  entry_reference: ref,
  transaction_amount: { currency: 'EUR', amount },
  credit_debit_indicator: dir,
  status: 'BOOK',
  booking_date: date,
  ...extra,
});

describe('setup', () => {
  it('checks the application before saving it and never returns or stores the key in clear', async () => {
    const before = await call('GET', '/api/enablebanking/status');
    expect(before.body).toMatchObject({ configured: false, applicationId: null });
    expect(before.body.suggestedRedirectUrl).toMatch(/\/api\/enablebanking\/callback$/);

    const badKey = await call('PUT', '/api/enablebanking/config', {
      applicationId: 'app-12345678',
      privateKey: 'not a key',
      redirectUrl: REDIRECT,
    });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error).toMatch(/private key/);

    const unregistered = await call('PUT', '/api/enablebanking/config', {
      applicationId: 'app-12345678',
      privateKey: pem,
      redirectUrl: 'https://elsewhere.example/cb',
    });
    expect(unregistered.status).toBe(400);
    expect(unregistered.body.error).toMatch(/redirect URL isn’t registered/);

    fake.app.active = false;
    const inactive = await call('PUT', '/api/enablebanking/config', {
      applicationId: 'app-12345678',
      privateKey: pem,
      redirectUrl: REDIRECT,
    });
    expect(inactive.body.error).toMatch(/Activate by linking accounts/);
    fake.app.active = true;

    await configure();
    const after = await call('GET', '/api/enablebanking/status');
    expect(after.body).toMatchObject({
      configured: true,
      applicationId: 'app-12345678',
      environment: 'PRODUCTION',
      redirectUrl: REDIRECT,
    });
    expect(JSON.stringify(after.body)).not.toContain('PRIVATE KEY');
    const raw = db.get<{ private_key: string }>(sql`select private_key from enable_banking_config`);
    expect(raw.private_key.startsWith('enc:v1:')).toBe(true);

    // Changing only the redirect URL keeps the stored key
    fake.app.redirect_urls.push('https://other.example/cb');
    const changed = await call('PUT', '/api/enablebanking/config', {
      applicationId: 'app-12345678',
      redirectUrl: 'https://other.example/cb',
    });
    expect(changed.body.redirectUrl).toBe('https://other.example/cb');
    await configure();
  });

  it('lists a country’s banks', async () => {
    const { body } = await call('GET', '/api/enablebanking/aspsps?country=ES');
    expect(body.aspsps).toEqual([
      {
        name: 'BBVA',
        country: 'ES',
        maximumConsentDays: 90,
        beta: false,
        psuTypes: ['personal', 'business'],
      },
      {
        name: 'CaixaBank',
        country: 'ES',
        maximumConsentDays: null,
        beta: true,
        psuTypes: ['personal'],
      },
    ]);
    expect((await call('GET', '/api/enablebanking/aspsps?country=spain')).status).toBe(400);
  });
});

describe('consent', () => {
  it('only the browser coming back from the bank with the right state gets past the guards', async () => {
    // The rest of the API refuses cross-site requests without the app's cookie
    const status = await fetch(`${base}/api/enablebanking/status`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(status.status).toBe(403);
    expect((await fetch(`${base}/api/enablebanking/status`)).status).toBe(401);

    const unknown = await bankRedirect('code=x&state=made-up');
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('This link has expired');
    // Nothing from the request is echoed into the page
    const echoed = await bankRedirect('code=%3Cscript%3E&state=%3Cscript%3Ealert(1)%3C/script%3E');
    expect(await echoed.text()).not.toContain('<script');
  });

  it('starts with the bank’s longest consent and the registered redirect, and connects once', async () => {
    const result = await connect('code-1', {
      id: 'session-1',
      accounts: [
        { uid: 'uid-chk', hash: 'h-chk', iban: IBAN_CHECKING, name: 'Cuenta Online' },
        { uid: 'uid-sav', hash: 'h-sav', iban: IBAN_SAVINGS, name: 'Ahorro' },
        {
          uid: 'uid-usd',
          hash: 'h-usd',
          iban: 'ES1000000000000000000001',
          name: 'Divisa',
          currency: 'USD',
        },
      ],
    });
    const auth = fake.auths[0];
    expect(auth).toMatchObject({
      aspsp: { name: 'BBVA', country: 'ES' },
      redirectUrl: REDIRECT,
      psuType: 'personal',
    });
    expect(auth.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const days = (Date.parse(auth.validUntil) - now) / 864e5;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);

    expect(result.renewed).toBe(false);
    expect(result.accounts).toMatchObject([
      {
        name: 'Cuenta Online',
        ibanMask: 'ES91 •••• 1332',
        currency: 'EUR',
        suggestedType: 'checking',
        accountId: null,
        isEnabled: true,
      },
      { name: 'Ahorro' },
      { name: 'Divisa', currency: 'USD' },
    ]);
    // The session is stored encrypted, and the IBAN only as a hash and a mask
    const raw = db.get<{ session_id: string }>(
      sql`select session_id from enable_banking_connections`,
    );
    expect(raw.session_id.startsWith('enc:v1:')).toBe(true);
    const stored = db.select().from(enableBankingAccounts).all();
    expect(JSON.stringify(stored)).not.toContain(IBAN_CHECKING);

    // The same redirect again just shows it worked; it doesn't create a second connection
    expect((await bankRedirect(`code=code-1&state=${auth.state}`)).status).toBe(200);
    expect(db.select().from(enableBankingConnections).all()).toHaveLength(1);
  });

  it('accepts the pasted address of the page the bank sent the user to', async () => {
    // A second consent at the same bank renews the connection in place (one per bank)
    fake.codes.set('code-2', {
      id: 'session-2',
      accounts: [
        { uid: 'uid-chk-2', hash: 'h-chk', iban: IBAN_CHECKING, name: 'Cuenta Online' },
        { uid: 'uid-sav-2', hash: 'h-sav', iban: IBAN_SAVINGS, name: 'Ahorro' },
        {
          uid: 'uid-usd-2',
          hash: 'h-usd',
          iban: 'ES1000000000000000000001',
          name: 'Divisa',
          currency: 'USD',
        },
      ],
    });
    const started = await call('POST', '/api/enablebanking/authorizations', {
      aspspName: 'BBVA',
      country: 'ES',
    });
    const state = fake.auths.at(-1)!.state;

    const wrong = await call(
      'POST',
      `/api/enablebanking/authorizations/${started.body.id}/complete`,
      {
        redirectedTo: 'https://localhost/flybudget-callback?code=code-2&state=someone-elses',
      },
    );
    expect(wrong.status).toBe(400);

    const ok = await call('POST', `/api/enablebanking/authorizations/${started.body.id}/complete`, {
      redirectedTo: `https://localhost/flybudget-callback?code=code-2&state=${state}`,
    });
    expect(ok.body).toMatchObject({ status: 'complete', result: { renewed: true } });
    expect(db.select().from(enableBankingConnections).all()).toHaveLength(1);
    // The old session is ended at Enable Banking
    expect(fake.deleted).toEqual(['session-1']);
    // Accounts are re-bound to the new session's ids
    expect(
      db
        .select({ uid: enableBankingAccounts.accountUid })
        .from(enableBankingAccounts)
        .all()
        .map((r) => r.uid)
        .sort(),
    ).toEqual(['uid-chk-2', 'uid-sav-2', 'uid-usd-2']);
  });

  it('reports a bank refusal and an expired code to the poller', async () => {
    const started = await call('POST', '/api/enablebanking/authorizations', {
      aspspName: 'BBVA',
      country: 'ES',
    });
    const state = fake.auths.at(-1)!.state;
    await bankRedirect(`error=access_denied&state=${state}`);
    const polled = await call('GET', `/api/enablebanking/authorizations/${started.body.id}`);
    expect(polled.body).toMatchObject({ status: 'error' });

    const again = await call('POST', '/api/enablebanking/authorizations', {
      aspspName: 'BBVA',
      country: 'ES',
    });
    await bankRedirect(`code=unknown-code&state=${fake.auths.at(-1)!.state}`);
    expect((await call('GET', `/api/enablebanking/authorizations/${again.body.id}`)).body).toEqual({
      status: 'error',
      error: 'The answer from your bank was not accepted. Connect again.',
    });
  });
});

describe('choosing accounts and syncing', () => {
  const connection = () => db.select().from(enableBankingConnections).get()!;
  const bankAccount = (hash: string) =>
    db
      .select()
      .from(enableBankingAccounts)
      .where(eq(enableBankingAccounts.identificationHash, hash))
      .get()!;

  it('creates, links and ignores accounts with the currency rules', async () => {
    const { body: existing } = await call('POST', '/api/accounts', {
      name: 'My savings',
      type: 'savings',
    });
    const res = await call('PUT', `/api/enablebanking/connections/${connection().id}/accounts`, {
      budgetCurrency: 'EUR',
      accounts: [
        {
          id: bankAccount('h-chk').id,
          action: 'create',
          accountName: 'BBVA Checking',
          syncFrom: '2026-03-01',
        },
        { id: bankAccount('h-sav').id, action: 'link', accountId: existing.id },
        { id: bankAccount('h-usd').id, action: 'link', accountId: existing.id },
      ],
    });
    expect(res.body).toMatchObject({ created: 1, linked: 1, skipped: 0 });
    // The USD account can't go into a EUR account (and that one is already taken)
    expect(res.body.errors).toHaveLength(1);

    const usd = await call('PUT', `/api/enablebanking/connections/${connection().id}/accounts`, {
      budgetCurrency: 'EUR',
      accounts: [{ id: bankAccount('h-usd').id, action: 'create' }],
    });
    expect(usd.body.created).toBe(1);
    const usdAccount = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, bankAccount('h-usd').accountId!))
      .get()!;
    expect(usdAccount).toMatchObject({ currency: 'USD', isOffBudget: 1, name: 'Divisa' });

    const created = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, bankAccount('h-chk').accountId!))
      .get()!;
    expect(created).toMatchObject({
      name: 'BBVA Checking',
      type: 'checking',
      currency: null,
      isOffBudget: 0,
    });
    expect(bankAccount('h-sav')).toMatchObject({ accountId: existing.id, syncFrom: '2025-12-20' });
  });

  it('imports booked transactions, sets a new account’s opening balance and links transfers', async () => {
    fake.transactions.set('uid-chk-2', [
      booked('c1', '2026-03-05', '45.10', 'DBIT', { creditor: { name: 'MERCADONA' } }),
      booked('c2', '2026-03-10', '500.00', 'DBIT', {
        creditor: { name: 'Me' },
        creditor_account: { iban: IBAN_SAVINGS },
      }),
      { ...booked('c3', '2026-03-12', '9.99', 'DBIT'), status: 'PDNG' },
      booked('c0', '2026-02-20', '1.00', 'DBIT'),
    ]);
    fake.transactions.set('uid-sav-2', [
      booked('s1', '2026-03-11', '500.00', 'CRDT', { debtor: { name: 'Me' } }),
    ]);
    fake.balances.set('uid-chk-2', '1000.00');
    fake.balances.set('uid-sav-2', '2500.00');

    const res = await call('POST', `/api/enablebanking/connections/${connection().id}/sync`);
    expect(res.body).toMatchObject({ added: 3, transfers: 1, status: 'good', errors: [] });

    const checking = bankAccount('h-chk');
    const rows = db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, checking.accountId!))
      .all();
    // Booked only, and only from the chosen start date
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([-50_000, -4_510]);
    const transfer = rows.find((r) => r.amount === -50_000)!;
    expect(transfer.payeeName).toBe('Transfer: My savings');
    // Opening balance: the bank's balance minus what was imported
    const account = db.select().from(accounts).where(eq(accounts.id, checking.accountId!)).get()!;
    expect(account.startingBalance + -54_510).toBe(100_000);
    // A linked existing account keeps its balance; the bank's is stored next to it
    expect(
      db
        .select()
        .from(accounts)
        .where(eq(accounts.id, bankAccount('h-sav').accountId!))
        .get()!.startingBalance,
    ).toBe(0);
    expect(bankAccount('h-sav').bankBalance).toBe(250_000);

    const { body: list } = await call('GET', '/api/enablebanking/connections');
    expect(list[0].accounts.find((a: { name: string }) => a.name === 'Ahorro')).toMatchObject({
      bankBalance: 250_000,
      balance: 50_000,
      accountName: 'My savings',
    });

    // Syncing again imports nothing twice
    const again = await call('POST', `/api/enablebanking/connections/${connection().id}/sync`);
    expect(again.body).toMatchObject({ added: 0, matched: 0 });
    // The opening balance is set once
    expect(
      db.select().from(accounts).where(eq(accounts.id, checking.accountId!)).get()!.startingBalance,
    ).toBe(account.startingBalance);
  });

  it('a background sync skips a connection synced in the last 6 hours', async () => {
    const service = createEnableBankingService({ makeApi: () => api, now: () => now });
    const reads = fake.reads;
    expect((await service.syncAll({ background: true }))[0].skipped).toBe(true);
    expect(fake.reads).toBe(reads);
    now += 7 * 60 * 60 * 1000;
    expect((await service.syncAll({ background: true }))[0].skipped).toBeUndefined();
    expect(fake.reads).toBeGreaterThan(reads);
  });

  it('asks to renew when the session has ended, and keeps the last sync date on errors', async () => {
    const before = connection().lastSyncedAt;
    fake.failSync = new EnableBankingError('bank down', 500, 'ASPSP_ERROR');
    const failed = await call('POST', `/api/enablebanking/connections/${connection().id}/sync`);
    expect(failed.body).toMatchObject({ status: 'error' });
    expect(failed.body.errors[0]).toMatch(/bank isn’t answering/);
    expect(connection().lastSyncedAt).toBe(before);

    fake.failSync = new ReauthRequiredError('expired', 401, 'EXPIRED_SESSION');
    const ended = await call('POST', `/api/enablebanking/connections/${connection().id}/sync`);
    expect(ended.body.status).toBe('reauth_required');
    expect(connection().syncStatus).toBe('reauth_required');
  });

  it('ignoring an account later keeps its transactions but stops importing it', async () => {
    const checking = bankAccount('h-chk');
    const count = () =>
      db.select().from(transactions).where(eq(transactions.accountId, checking.accountId!)).all()
        .length;
    const kept = count();
    await call('PUT', `/api/enablebanking/connections/${connection().id}/accounts`, {
      budgetCurrency: 'EUR',
      accounts: [{ id: checking.id, action: 'skip' }],
    });
    expect(bankAccount('h-chk')).toMatchObject({ isEnabled: 0, accountId: null });
    expect(
      db.select().from(transactions).where(eq(transactions.accountId, checking.accountId!)).all(),
    ).toHaveLength(kept);
  });
});

describe('disconnecting and removing the setup', () => {
  it('keeps the setup while banks are connected', async () => {
    expect((await call('DELETE', '/api/enablebanking/config')).status).toBe(409);
  });

  it('keeps the connection when Enable Banking can’t be reached, and forgets an ended one', async () => {
    const id = db.select().from(enableBankingConnections).get()!.id;
    fake.failDelete = new EnableBankingError('unreachable');
    expect((await call('DELETE', `/api/enablebanking/connections/${id}`)).status).toBe(502);
    expect(db.select().from(enableBankingConnections).all()).toHaveLength(1);

    fake.failDelete = new ReauthRequiredError('gone', 404, 'SESSION_DOES_NOT_EXIST');
    expect((await call('DELETE', `/api/enablebanking/connections/${id}`)).status).toBe(204);
    expect(db.select().from(enableBankingConnections).all()).toHaveLength(0);
    // Imported accounts and transactions stay
    expect(db.select().from(transactions).all().length).toBeGreaterThan(0);

    expect((await call('DELETE', '/api/enablebanking/config')).status).toBe(204);
    expect(db.select().from(enableBankingConfig).all()).toHaveLength(0);
  });
});
