# Decisions

Numbered M1, M2… to keep them apart from the Enable Banking decisions (D1–D29), which they build
on.

## M1 — An account in another currency can be on budget, account by account

Until now accounts in another currency were always off budget (Enable Banking D11): their income
counts when it's exchanged into the budget currency (D24). That fits someone who changes their pay
into the budget currency before spending it, but not someone who spends from the foreign account.
Both are supported: each account in another currency is on or off budget, like any other account.
New ones still start off budget, so an imported account doesn't change the budget until the user
says so.

## M2 — The budget currency is stored on the server

Conversions happen on the server: bank sync runs at startup without a browser, and reports add up
converted amounts. So the budget currency is stored with the budget (`budget_settings.currency`)
instead of only as a preference on each device. The Preferences setting writes it; the device
preference stays as the display fallback until the server has one, and a client that finds none
on the server sends its own once.

Changing it re-labels accounts so their money stays what it is: accounts in the new budget
currency become "the budget's" (`currency` null), and accounts that were in the budget's currency
get the old code. Every conversion is then recomputed (including amounts typed by hand, which were
in the old currency).

## M3 — Each transaction keeps the rate it was converted at

`transactions.fx_rate` holds the rate from the account's currency to the budget's, and
`transactions.fx_source` where it came from. The value in the budget currency is
`round(amount × fx_rate)`, rounded half away from zero (SQLite's `round`), computed in SQL, so
editing the amount keeps the rate. The rate is fixed when the transaction is converted (historical
cost), so past months don't change when rates move. Where it comes from, in this order:

1. `manual`: the user typed the amount in the budget currency (or the rate).
2. `exchange`: the transaction is one side of an exchange whose other side is in the budget
   currency. The rate is the exact one implied by the two amounts, so the converted value equals
   what arrived (`|other| / |amount|`; `round(x × (y / x)) = y` for any cents a budget holds).
3. `rate`: the latest daily rate on or before the transaction's date, at most 7 days older (the
   ECB doesn't publish on weekends and holidays).

Split parts use their parent's rate. Transactions in the budget currency have no rate. A
transaction with no rate available has no value in the budget currency: it stays out of the budget
and the reports, as before this change, and the budget says how many are waiting.

## M4 — Daily rates, downloaded only if the user turns it on

Rates live in `exchange_rates`, one row per currency pair and date, with a deterministic id
(`<base><quote>:<date>`) so two devices storing the same rate store the same row. Rows come from:

- **The European Central Bank, through [Frankfurter](https://frankfurter.dev)** (open source, free,
  no key; about 30 currencies). FlyBudget is local-first and doesn't call third parties unasked, so
  downloading is off until the user turns it on (`budget_settings.download_rates`). The request
  carries only the currency codes and dates, never amounts or account details. It runs at startup,
  after an account's currency or budget status changes, after a bank sync, after any other write
  that leaves a new transaction without a rate (adding, splitting, transfers, CSV import, paying
  or auto-creating a recurring item), and on demand; each run
  fills what's missing from the earliest transaction in each foreign currency to today.
- **The user**, for a date: it applies until the next rate. A rate typed in wins over a
  downloaded one for the same date, and downloads never overwrite it.

## M5 — One "value in the budget currency" for the budget and every report

`budgetValue` (`services/balances.ts`) is the amount for accounts in the budget currency, the
converted amount for others, and null when there's no rate. It replaces `transactions.amount` in
the budget and every income and spending report, and `hasBudgetValue` replaces the old
`inBudgetCurrency` filter. Off-budget accounts in another currency therefore appear in income and
spending reports once they have rates (like off-budget accounts in the budget currency always
did), and on-budget ones count in the budget too.

## M6 — Balances and net worth at the rate of the day

A balance is a stock, not a flow: its value is what it's worth now. An account in another currency
shows its balance in its own currency and, when a rate exists, its value at the latest rate
(`budgetBalance`, used by the sidebar and Accounts totals). Net worth values each such account at
the rate of each period's end. An account with no rate stays out of these totals, as before.

## M7 — Exchanging money between two budget accounts doesn't change the budget

To Be Budgeted is income minus what's assigned; starting balances and uncategorized transactions
don't count. A transfer between two budget accounts is uncategorized (D26), exchanges included, so
it doesn't change the budget either. The gain or loss between the rate when money was earned and
the rate it was exchanged at isn't recorded: the budget keeps the income at the rate it arrived.
Someone who wants it counted can categorize an adjustment. Recording realized exchange gains and
losses is listed under "Later".

## M8 — Switching an account on or off budget uncategorizes transfers that stop crossing

A transfer's category is only meaningful while it crosses the budget boundary (D26). If an
account's budget status changes, transfers between it and other accounts that no longer cross lose
their category, so money isn't counted twice: with the GBP account off budget, the EUR side of each
exchange is categorized as income; once the GBP account is on budget, its pay counts as income
itself. The account API reports how many it changed, and the dialog warns before saving.

## M9 — Rules, recurring items and bank matching keep the account's own amounts

Banks send amounts in the account's currency, and rules, recurring items and import matching
compare those, so a rule "amount is 500" on a GBP account means £500. Only budgeting and reporting
use converted values.

## M10 — The demo doesn't download rates

The in-browser demo can't make outside requests (its CSP allows only itself), so downloading is
refused there, like bank connections. Rates typed in by hand work.
