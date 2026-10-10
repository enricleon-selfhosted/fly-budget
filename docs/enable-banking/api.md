# HTTP contract — `/api/enablebanking`

What the client relies on. All amounts are integer hundredths ("cents"), dates `YYYY-MM-DD`,
timestamps ISO 8601. Errors are `{ "error": string }` with a safe, user-facing message.
Mutating routes are behind `bankRateLimit` (20/minute). Everything except the callback goes
through the normal guards (and `requireSession` in server mode).

## Configuration

### `GET /status`

```json
{
  "configured": true,
  "applicationId": "5f0a…",
  "environment": "PRODUCTION",
  "redirectUrl": "https://budget.example.com/api/enablebanking/callback",
  "suggestedRedirectUrl": "https://budget.example.com/api/enablebanking/callback",
  "connectionCount": 1
}
```

`suggestedRedirectUrl` is this server's callback URL as the request reached it. Unconfigured:
`configured: false` and nulls.

### `PUT /config`

```json
{
  "applicationId": "uuid",
  "privateKey": "-----BEGIN PRIVATE KEY-----…",
  "redirectUrl": "https://…"
}
```

`privateKey` may be omitted when one is already stored (e.g. only changing the redirect URL).
The server checks the key, calls Enable Banking's `GET /application` with it and checks the
redirect URL is registered there. Answers the new `GET /status` body. `400` with a message for a
bad key, unknown application or unregistered redirect URL; `502` if Enable Banking can't be
reached.

### `DELETE /config`

`204`. `409` while connections exist (disconnect them first).

## Banks

### `GET /aspsps?country=ES`

```json
{
  "aspsps": [
    {
      "name": "BBVA",
      "country": "ES",
      "maximumConsentDays": 180,
      "beta": false,
      "psuTypes": ["personal", "business"]
    }
  ]
}
```

Cached per country for an hour.

## Consent

### `POST /authorizations`

```json
{
  "aspspName": "BBVA",
  "country": "ES",
  "psuType": "personal",
  "connectionId": "optional, to renew"
}
```

→ `{ "id": "opaque poll id", "url": "https://… bank or Enable Banking page" }`. The client opens
`url` in the system browser.

### `GET /authorizations/:id` (poll)

One of:

```json
{ "status": "pending" }
{ "status": "expired" }
{ "status": "error", "error": "The bank refused the consent." }
{ "status": "complete", "result": { "connectionId": "…", "renewed": false, "accounts": [DiscoveredAccount] } }
```

### `POST /authorizations/:id/complete`

`{ "redirectedTo": "https://the-page-the-bank-sent-you-to?code=…&state=…" }` — for installs whose
redirect URL isn't FlyBudget's callback. Same answer as the poll.

### `DELETE /authorizations/:id`

`204`. Cancels a pending consent.

### `GET /callback?code&state` (or `?error&state`)

Not called by the client: the bank's redirect lands here. Answers a small HTML page.

## Connections

### `GET /connections`

```json
[
  {
    "id": "…",
    "aspspName": "BBVA",
    "aspspCountry": "ES",
    "validUntil": "2027-04-08T10:00:00Z",
    "syncStatus": "good",
    "syncError": null,
    "lastSyncedAt": "…",
    "accounts": [
      {
        "id": "mapping id",
        "name": "Cuenta Online",
        "ibanMask": "ES12 •••• 3456",
        "currency": "EUR",
        "cashAccountType": "CACC",
        "suggestedType": "checking",
        "accountId": "local account id or null",
        "accountName": "BBVA Checking",
        "isEnabled": true,
        "syncFrom": "2026-07-12",
        "bankBalance": 123456,
        "bankBalanceAt": "…",
        "balance": 123000
      }
    ]
  }
]
```

`balance` is FlyBudget's balance of the linked account (null when not imported).

`DiscoveredAccount` (consent result) is the same account object.

### `PUT /connections/:id/accounts`

```json
{
  "budgetCurrency": "EUR",
  "accounts": [
    {
      "id": "mapping id",
      "action": "create",
      "accountName": "BBVA",
      "accountType": "checking",
      "isOffBudget": 0,
      "syncFrom": "2026-07-12"
    },
    { "id": "…", "action": "link", "accountId": "local id", "syncFrom": "2026-09-01" },
    { "id": "…", "action": "skip" }
  ]
}
```

→ `{ "created": 1, "linked": 1, "skipped": 1, "errors": [{ "id": "…", "error": "…" }] }`.

Rules (D11): an account in another currency than `budgetCurrency` is created off budget with its
currency stored; `link` needs the local account's currency (null = `budgetCurrency`) to equal the
bank account's. `syncFrom` defaults per D9. Changing an imported account to `skip` keeps its
transactions.

### `POST /connections/:id/sync` · `POST /sync-all`

```json
{
  "connectionId": "…",
  "aspspName": "BBVA",
  "added": 12,
  "matched": 3,
  "transfers": 2,
  "status": "good",
  "errors": []
}
```

`/sync-all` → `{ "results": [ …same… ] }`.

### `DELETE /connections/:id`

Ends the session at Enable Banking first, then deletes the connection (imported transactions and
accounts stay). `502` and nothing deleted if Enable Banking can't be reached; an already
expired/revoked session is deleted locally.

## Shared transaction route (new)

### `POST /api/transactions/:id/unlink-transfer`

Turns a transfer pair back into two ordinary transactions (payee back to the bank's text,
uncategorized). `200` with the updated row; `400` if it isn't a transfer; `403` if either side is
reconciled.
