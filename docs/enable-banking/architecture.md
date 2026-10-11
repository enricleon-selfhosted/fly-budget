# Architecture

How the Enable Banking integration is put together. Decisions referenced as `D<n>` are in
[decisions.md](decisions.md); the HTTP contract is in [api.md](api.md).

## Layers

```
client (React)                     components/enablebanking/*, hooks/useEnableBanking.ts,
                                   api/enableBanking.ts
──────────── HTTP /api/enablebanking/* ───────────────────────────────────────────────
routes/enableBanking.ts            thin: Zod-validate, call a service, shape the answer
                                   + enableBankingCallback (mounted before the guards, D2)
──────────────────────────────────────────────────────────────────────────────────────
services/enableBanking/            provider adapter
  connectService.ts                start / complete / cancel a consent, disconnect
  rules.ts                         pure: planMapping, defaultSyncFrom / syncFromAfter,
                                   syncWindowStart, shouldSkipBackgroundSync, consentEnded,
                                   localDay (no database, no clock)
  accountMapping.ts                applies a mapping plan: create / link / ignore bank accounts
                                   (currency rules, D11)
  syncService.ts                   sync one connection / all (status, windows, balances)
  consent.ts                       pending consents keyed by state (in memory, single use;
                                   fail/complete check the attempt's id)
  dataSource.ts                    BankDataSource implementation over the API client
  client.ts                        one function per Enable Banking endpoint (fetch injected)
  jwt.ts                           RS256 application JWT (crypto injected clock)
  mapping.ts                       pure: Enable Banking JSON → normalized types
  schemas.ts                       Zod for every response (bank data is untrusted)
  errors.ts                        typed errors + safe messages for the UI
  store.ts                         the enable_banking_* tables
──────────────────────────────────────────────────────────────────────────────────────
services/bankSync/                 provider-agnostic core (D3)
  types.ts                         RemoteTransaction, RemoteBalance, BankDataSource
  matching.ts                      pure: manual-match and transfer-counterpart (same currency
                                   only) decisions
  importStore.ts                   ImportStore interface + SQLite implementation
  importTransactions.ts            dedup → match → insert (rules) → transfer, per account
──────────────────────────────────────────────────────────────────────────────────────
services/ruleService.ts            insertNewTransaction (rules, payees) — unchanged
services/transactionHelpers.ts     linkTransfer / unlinkTransfer (new, shared)
services/accountService.ts         createAccount, setBalanceTo, openAccount, accountSummary
                                   (shared with the accounts API)
utils/money.ts                     exact decimal string → hundredths (D12), shared
utils/text.ts                      cleanText for untrusted text (bank data, User-Agent), shared
```

Each module has one job and depends only on the layer below. The adapter knows Enable Banking;
the core knows FlyBudget's transactions; neither knows the other's internals.

## Interfaces

```ts
// services/bankSync/types.ts
type RemoteTransaction = {
  externalId: string; // stable within its account (entry_reference, else a content hash)
  date: string; // YYYY-MM-DD, booking date
  amount: number; // hundredths, signed: negative = money out
  currency: string; // ISO 4217
  payeeName: string; // cleaned counterparty name (fallback: remittance text, "Unknown")
  importedPayee: string; // raw text kept for rules
  notes: string | null; // remittance information
  counterpartyAccountHash: string | null; // SHA-256 of the counterparty IBAN (transfers, D6)
};
type RemoteBalance = { amount: number; currency: string; date: string | null };

interface BankDataSource {
  fetchTransactions(since: string): Promise<RemoteTransaction[]>; // booked only, any order
  fetchBalance(): Promise<RemoteBalance | null>;
}

// services/bankSync/importTransactions.ts
type ImportTarget = {
  accountId: string;
  importedIdPrefix: string; // e.g. "enablebanking:<identification_hash>:"
  currency: string; // the bank account's currency: transactions in another one are skipped
};
type ImportContext = {
  ownAccountsByIbanHash: Map<string, string>; // IBAN hash → local account id
  store?: ImportStore; // default: SQLite
};
function importTransactions(target, remote: RemoteTransaction[], ctx): ImportResult;
// ImportResult = { added, matched, transfers, duplicates, otherCurrency }
```

`ImportStore` is the only thing the import core uses to read or write the database (run one
account's import as a single transaction, look up an
imported id, find manual-match and transfer candidates, attach an import to a row, insert through
`insertNewTransaction`, link a transfer, read an account's stored currency). Transfer candidates
come back in any currency with their own; the decisions themselves (`pickManualMatch`, and
`pickTransferCounterpart`, which pairs only the same currency) are pure functions in
`matching.ts`.

## Data model (migration `0021_enable_banking`, hand-written like `0019`/`0020`)

```
accounts.currency            text, nullable — ISO 4217 when it differs from the budget's (D11)

enable_banking_config        one row, id = 'default'
  application_id             text            Enable Banking application id (kid)
  private_key                encryptedText   PEM (D13)
  redirect_url               text            must be one of the application's redirect URLs
  environment                text            PRODUCTION | SANDBOX (from GET /application)
  created_at, updated_at

enable_banking_connections   one per bank consent
  id                         text pk
  session_id                 encryptedText   (D13)
  aspsp_name, aspsp_country  text            the bank, as Enable Banking names it
  valid_until                text            consent end (RFC 3339)
  sync_status                text            good | syncing | error | reauth_required
  sync_error                 text            safe message only
  last_synced_at             text            every account synced without an error
  last_attempt_at            text            last read, failed or not: the 6-hour rule (D10)
  created_at

enable_banking_accounts      one per bank account in a connection
  id                         text pk
  connection_id              → enable_banking_connections (cascade)
  account_uid                text            per-session id used in API paths
  identification_hash        text            stable across sessions (D18); unique per connection
  account_id                 → accounts (set null)   null = not imported
  name                       text            bank's account name
  iban_mask, iban_hash       text            (D15)
  currency                   text            ISO 4217 from the bank
  cash_account_type          text            CACC | CARD | SVGS | LOAN | CASH | OTHR
  is_enabled                 integer         0 = ignored
  in_consent                 integer         0 = the latest consent leaves it out (D18)
  sync_from                  text            YYYY-MM-DD (D9)
  last_synced_at             text            this account's last import; null until its first (D9)
  opening_balance_pending    integer         1 until the first sync sets the opening balance (D7)
  bank_balance, bank_balance_at              last balance the bank reported (D7)
  created_at
```

Imported transactions get `imported_id = "enablebanking:<identification_hash>:<externalId>"`,
so a re-consent (new `account_uid`) keeps deduplicating.

## Flows

### Configure

1. User registers an application at enablebanking.com (production, restricted), downloads the
   `.pem`, registers the redirect URL FlyBudget suggests, links their accounts.
2. `PUT /config` with application id, key and redirect URL. The server parses the key, calls
   `GET /application` with a JWT signed by it (proves the pair works), checks the redirect URL is
   registered there, then stores it.

### Connect (and renew)

```
UI ── POST /authorizations {bank, country[, connectionId]} ──▶ server
                                     consent.begin(): state = 32 random bytes
                                     client.startAuth(valid_until = min(bank max, 180 d), state)
UI ◀── { id, url } ─────────────────
UI opens url in the system browser; polls GET /authorizations/:id every 3 s
browser ── bank login + SCA ──▶ bank ──▶ redirect_url?code&state
   a) redirect_url is FlyBudget's callback: GET /api/enablebanking/callback (state checked)
   b) otherwise the user pastes the address: POST /authorizations/:id/complete
server: consent.complete(state, code) — exactly once, concurrent-safe
        client.createSession(code) → session_id + accounts
        new: insert connection + accounts (unmapped)
        renew: replace session_id, re-bind accounts by identification_hash, add new ones,
               stop importing the ones it leaves out (D18)
UI ◀── poll: { status: complete, result: { connectionId, accounts } }
UI: mapping step → PUT /connections/:id/accounts → POST /connections/:id/sync
```

### Sync one account (inside a connection sync)

```
since = sync_from on the account's first sync, else max(sync_from, its last_synced_at − 10 days)  (D9)
remote = dataSource.fetchTransactions(since)        booked only, paginated
importTransactions(target, remote, ctx):          one database transaction
  for each remote tx, oldest first:
    in another currency than the account's      → skip (counted, and logged by the sync)
    imported id already in the account          → skip (duplicate)
    manual row, same amount, ±10 days            → attach import to it ("matched", D5)
    else insertNewTransaction (rules, payees)    → "added"
         then pickTransferCounterpart            → linkTransfer ("transfers", D6), same currency only
balance = dataSource.fetchBalance()
the account's last_synced_at = this sync's start
  opening_balance_pending → starting balance = balance − imported sum up to the balance's
                            date, clear the flag  (D7)
  always → store bank_balance / bank_balance_at
```

A whole connection sync: status `syncing` + `last_attempt_at` → per account → `good` +
`last_synced_at`, or `reauth_required` (expired/revoked session, consent past `valid_until`) or
`error` (safe message). Background syncs skip connections read in the last 6 hours, failed or not
(D10).

## Security

| Concern                                       | Handling                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback bypasses origin/token/session guards | Only `GET /api/enablebanking/callback`; registered after `hostGuard`, before the rest; authenticated by a single-use, 30-minute, 256-bit `state` looked up by its SHA-256 hash; rate limited; answers a static page that never echoes input |
| Code interception                             | The code is useless without the private key (Enable Banking requires the signed JWT to create the session) and expires quickly                                                                                                              |
| Credentials at rest                           | Private key and session id encrypted (`encryptedText`), plaintext rows encrypted at startup (`encryptStoredCredentials`); never in backups; never returned to the client                                                                    |
| Bank data is untrusted                        | Zod on every response; exact amount conversion; payee/notes stripped of control characters and capped; dates validated; page and size caps                                                                                                  |
| Outbound requests                             | Fixed host `https://api.enablebanking.com` (not user-supplied, so no `safeFetch`); 30 s timeout; response size cap                                                                                                                          |
| Rate limits                                   | Mutating routes behind `bankRateLimit`; PSD2 4/day respected (D10)                                                                                                                                                                          |
| Demo                                          | Routes refused with 403 (`NOT_IN_DEMO`), status stubbed as not configured                                                                                                                                                                   |
| Errors                                        | Typed errors map to safe messages; raw Enable Banking messages are logged, not sent                                                                                                                                                         |
