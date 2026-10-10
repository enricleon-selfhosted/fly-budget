# Plan

Status: ☐ to do · ◐ in progress · ☑ done.

| #    | Task                                                                                                 | Owner | Status |
| ---- | ---------------------------------------------------------------------------------------------------- | ----- | ------ |
| 7.1  | Schema: `budget_settings`, `exchange_rates`, `transactions.fx_rate` / `fx_source` (migration `0023`) | lead  | ☑      |
| 7.2  | Pure conversion module: converting, rate lookup, choosing a transaction's rate, missing ranges       | lead  | ☑      |
| 7.3  | Budget currency on the server: settings route, changing currency                                     | lead  | ☑      |
| 7.4  | Rates: store, Frankfurter client, download service, rates routes                                     | lead  | ☑      |
| 7.5  | Conversion service wired into every write path; amount in the budget currency typed by hand          | lead  | ☑      |
| 7.6  | Accounts: on budget in another currency, value at today's rate, transfers that stop crossing         | lead  | ☑      |
| 7.7  | Budget, reports and net worth on converted values; transactions waiting for a rate                   | lead  | ☑      |
| 7.8  | Client: budget currency from the server; Settings → Currencies (download, rates by hand)             | agent | ☑      |
| 7.9  | Client: accounts on budget, converted balances and totals; converted amounts on transactions; banner | agent | ☑      |
| 7.10 | Guide, repo docs, `SECURITY.md`; e2e                                                                 | lead  | ☑      |

## Later

- ⏸ Record realized exchange gains and losses (M7).
- ⏸ A foreign account in the demo budget, with rates in the sample data.
- ⏸ Card payments in a third currency: use the rate the bank reports.
- ⏸ An amount in the budget currency on the add-transaction form (today: the day's rate, editable
  afterwards in the detail panel).
- ⏸ Creating or deleting a transaction refreshes budget figures only when their pages reload
  (as before this work); updates refresh them right away.
