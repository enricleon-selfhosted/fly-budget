# HTTP contract

What the client relies on. Amounts are integer hundredths; "budget currency" is the budget's.

## `/api/currencies`

`GET /api/currencies` — the budget currency, the download setting and each currency accounts are
kept in:

```json
{
  "budgetCurrency": "EUR",
  "downloadRates": false,
  "ratesUpdatedAt": "2026-10-10T08:00:00.000Z",
  "ratesError": null,
  "currencies": [
    {
      "code": "GBP",
      "accounts": 1,
      "latest": { "rate": 1.1798, "date": "2026-10-09" },
      "waiting": 0
    }
  ]
}
```

- `budgetCurrency` is null until a client sends one (`PUT`). A client that finds null sends its
  own (M2).
- `ratesError`: null, `"unreachable"` (the last download failed), or `"unsupported:ARS,KES"`
  (currencies the ECB doesn't publish: enter their rates by hand).
- `latest`: the currency's latest rate to the budget's, any age; null when it has none.
- `waiting`: transactions in that currency without a rate (split parts not counted).

`PUT /api/currencies` with `{ "currency"?: "GBP", "downloadRates"?: true }` answers the same
shape. Changing the currency re-labels accounts (M2) and converts everything again. Turning
downloading on starts a download in the background. In the demo, `downloadRates: true` is refused
with 403.

`GET /api/currencies/:code/rates?limit=60` — that currency's rates to the budget's, newest first:
`[{ "id", "date", "base", "quote", "rate", "source": "ecb" | "manual" }]`.

`PUT /api/currencies/:code/rates/:date` with `{ "rate": 1.17 }` — a rate typed in (1 `code` =
`rate` budget currency). It applies from that date until the next rate. 409 before the budget has
a currency; 400 for the budget's own currency.

`DELETE /api/currencies/:code/rates/:date` — removes a rate typed in (204); 404 when that date has
none typed in (downloaded rates can't be removed).

`POST /api/currencies/download` — downloads missing rates now and answers
`{ "downloaded", "error", "unsupported", ...the GET shape }`. 409 while downloading is off; 403 in
the demo.

## Accounts

- An account in another currency can be on or off budget (`isOffBudget` is no longer forced). New
  ones start off budget unless `isOffBudget` is sent (M1).
- Accounts in another currency also have `budgetBalance` (their balance at the latest rate, null
  without one) and `budgetBalanceAsOf` (that rate's date). Accounts in the budget currency don't
  have these fields.
- `PUT /api/accounts/:id` also answers `transfersUncategorized`: how many transfers lost their
  category because the account moved on or off budget (M8).

## Transactions

- Every row has `fxRate` and `fxSource` (`"manual" | "exchange" | "rate" | null`).
- Rows in accounts in another currency (and their split parts) also have `budgetAmount`: the value
  in the budget currency, null while there's no rate. Rows in the budget currency don't have it.
- `PUT /api/transactions/:id` takes `budgetAmount`: a number sets the value typed in (same
  direction as the amount); `null` goes back to the automatic rate. Refused (400) in an account in
  the budget currency, on a split part, and on an exchange whose other side is in the budget
  currency.

## Budget

`GET /api/budget/:month/summary` also has `waitingForRate`: categorized transactions in budget
accounts in another currency, up to that month, without a rate (they don't count yet).

## Reports

Income, spending, cash flow and custom reports add up values in the budget currency (accounts in
another currency count once converted). Net worth counts accounts in another currency at the rate
of each period's end, and leaves out those without a rate.
