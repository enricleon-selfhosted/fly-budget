# Decision log

Newest last. Each entry: the decision, why, and what it rules out. Change a decision by adding a
new entry that supersedes the old one (don't rewrite history).

## D1 — Bring your own Enable Banking application

Each user registers their own application in Enable Banking's control panel, in **production,
restricted mode** ("Activate by linking accounts"): free for individual non-commercial use, and
it can only read the accounts the user linked there. FlyBudget stores the application id and the
private key, exactly like it stores a user's own Plaid keys or SimpleFIN token.

- Why: FlyBudget is local-first and has no cloud; a FlyBudget-owned application would need a
  contract with Enable Banking and a server holding everyone's consents. Actual Budget and
  Firefly III do the same.
- Cost: setup has more steps (register app, keep the `.pem`, register the redirect URL, link the
  accounts). The in-app form and the guide must walk through them.

## D2 — The consent callback is authenticated by a single-use `state`

After consenting, the bank sends the browser to the redirect URL with `?code&state`. That request
can't pass the normal guards (`originGuard` rejects `Sec-Fetch-Site: cross-site`, the desktop
API token cookie lives only in the Electron window, the server-mode session cookie is
`SameSite=Strict`). So one route, `GET /api/enablebanking/callback`, is registered **before**
those guards (after `hostGuard`), and is authenticated only by `state`: 32 random bytes, kept in
memory, single use, expiring after 30 minutes, compared in constant time. It exchanges the code on
the server and answers with a static page; the app learns the outcome by polling, like Plaid
Hosted Link.

- Enable Banking requires **https** redirect URLs in production. Server mode behind HTTPS
  registers its own callback URL and everything is automatic.
- Desktop and plain-HTTP installs can't receive an https redirect, so the waiting screen also
  accepts **the address of the page the bank sent you to**, pasted by the user; the server takes
  `code` and `state` from it and checks them the same way.
- Rules out: custom protocol handlers (not registered, and Enable Banking wants https), and a
  relay page on the project website (possible later, see plan).

## D3 — A shared bank-sync core behind interfaces; Enable Banking is its first adapter

`server/src/services/bankSync/` holds the provider-agnostic part: normalized types
(`RemoteTransaction`, `RemoteBalance`), the `BankDataSource` interface, the pure matching
decisions, and the import service (dedup → match → insert → transfer). Providers only translate
their API into those types.

- Why: Plaid and SimpleFIN each duplicate dedup/insert/balance/status logic; a third copy would
  make transfer detection and matching provider-specific.
- Plaid and SimpleFIN are **not** migrated in this branch (separate PRs later), so this branch
  doesn't change their behavior.

## D4 — Provider-specific tables

New tables `enable_banking_config`, `enable_banking_connections`, `enable_banking_accounts`,
following the Plaid/SimpleFIN pattern, instead of a generic `bank_connections` table.

- Why: additive only (offline-sync guidance), existing tables untouched, and each provider's
  credentials have a different shape. The core never reads provider tables: callers pass it what
  it needs.

## D5 — Imports match transactions the user typed in (YNAB)

Before inserting an imported transaction, look in the same account for a transaction **without**
an `imported_id` (typed in by hand, including a manual transfer) with the same amount and a date
within ±10 days; the closest date wins (ties: the older row). The match keeps the user's date,
payee, category and notes and gets the bank's `imported_id` and `imported_payee`.

- Reconciled rows, split parts and adjustments are never matched.
- CSV-imported rows (which have an `imported_id`) are not matched; the default `sync_from` (D9)
  starts after them instead, so they don't overlap.

## D6 — Money between the user's own accounts becomes a transfer

After inserting an imported transaction, look for its other side: an **imported** transaction in
another account, same currency, opposite amount, within ±4 days, not already a transfer, split,
reconciled or adjustment. Link the pair when:

1. the bank names the counterparty account (IBAN) and it is one of the user's accounts — that
   account's candidate wins (if it is unique there), or
2. otherwise, there is exactly one candidate and no other unlinked transaction in this account
   with the same amount in the window (ambiguity in either direction means no link).

Linked rows look like manual transfers: `Transfer: <other account>` payee, no category,
`transfer_transaction_id` on both. A new "Unlink transfer" action undoes it (payees go back to
the bank text). Accounts in different currencies are never paired by amount.

## D7 — FlyBudget doesn't silently rewrite balances

- An account **created** from a bank gets its starting balance once, after its first sync:
  bank balance − sum of the imported transactions.
- After that, and always for **linked** existing accounts, the starting balance is never changed
  by sync. The latest bank balance is stored and the connection card shows it next to
  FlyBudget's, with the difference and a link to reconcile.
- Why: this is how YNAB works, and adjusting history behind the user's back hides missing or
  duplicated transactions. Plaid/SimpleFIN keep their current behavior for now.

## D8 — Booked transactions only

Only `status = BOOK` is imported; pending ones (`PDNG` and others) are skipped, like SimpleFIN.
Pending amounts and ids often change when they book, which would create duplicates.

## D9 — What to import, and from when

Every bank account is **imported as a new account**, **linked to an existing account**, or
**ignored**, when connecting and at any time later. Each imported account has a `sync_from`
date chosen when mapping:

- new account: 90 days back by default (the user can pick an earlier date; banks often only give
  more than 90 days right after consenting);
- linked account: the day after its newest imported transaction (CSV or bank), else 90 days back.

Later syncs read again from 10 days before the last sync (late bookings), never before
`sync_from`; dedup by `imported_id` makes that safe.

## D10 — Respect the PSD2 limit of 4 unattended reads a day

- Background syncs (server startup) skip a connection that synced in the last 6 hours.
- Syncs the user starts send the PSU headers (`Psu-Ip-Address`, `Psu-User-Agent`) so the bank
  treats them as user-present; banks that list `required_psu_headers` get all or none.

## D11 — Currency per account, no conversion (v1)

- `accounts.currency` (ISO 4217) is set **only** for accounts whose currency differs from the
  budget's; null means the budget currency. So the server can tell foreign accounts apart
  without knowing the budget currency.
- The budget currency is a client preference, `currencyCode`, next to `currencySymbol`.
- Foreign-currency accounts are forced **off budget** and left out of net worth sums (shown on
  their own); their amounts are shown in their own currency.
- No exchange rates: YNAB is single-currency too, and conversion needs a rate source (network,
  CSP, history). Revisit later.

## D12 — Amounts stay in hundredths for every currency

FlyBudget's invariant (integer "cents" = hundredths) is kept for all currencies. Bank amounts are
decimal strings converted exactly (string math, no floats) in a shared `utils/money.ts`, rounding
half away from zero after two decimals. Every EEA currency has 0 or 2 decimals, so nothing is
lost there.

## D13 — Credentials at rest

- `enable_banking_config.private_key` and `enable_banking_connections.session_id` are
  `encryptedText` (the session id grants access together with the key).
- The application id is not secret. The client only learns whether a key is stored.
- None of these tables are in backups.

## D14 — No JWT dependency

The RS256 JWT Enable Banking wants is signed with Node's `crypto.sign`, valid for 1 hour (the
maximum is 24 hours), and cached until shortly before it expires.

## D15 — IBANs are hashed

Only a SHA-256 of the normalized IBAN (for transfer detection) and a mask such as
`ES12 •••• 3456` (for display) are stored.

## D16 — Tests target interfaces

- Pure modules (mapping, matching, money, JWT claims) get property-based tests with fast-check,
  like the rest of the repo.
- The Enable Banking client and adapter are tested through their interfaces with an injected
  `fetch` (recorded-style responses); no `vi.mock` of module paths.
- A shared contract suite runs against every `BankDataSource` implementation.
- The import service is tested through its public function against `:memory:` SQLite: what goes
  in, what ends up in the database.

## D17 — No bank logos from Enable Banking's CDN

The CSP only allows images from `'self'`; banks are listed by name. (Later: the server could
fetch a logo once and store it as a data URL, like account logos.)

## D18 — Re-consenting replaces the session in place

Spanish banks (Redsys) keep one session per user and provider: a new consent invalidates the old
one. Renewing access updates the existing connection's session and re-binds its accounts by
Enable Banking's `identification_hash` (stable across sessions; the per-session `uid` is not).
Accounts that appear for the first time are added unmapped.

## D19 — Tracking docs in English

The repository's code and docs are in English, so these files are too.
