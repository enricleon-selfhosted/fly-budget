# Development log

## 2026-10-10

- Product owner: should be flexible. They exchange their GBP pay into EUR and spend from the EUR
  account, but other people spend from accounts in another currency. So each foreign account can be
  on or off budget (M1), with conversion for on-budget ones.
- Read the budget math (`routes/budget.ts`: To Be Budgeted is categorized income minus assigned
  amounts; starting balances and uncategorized transactions don't count) and every report query;
  checked Frankfurter's API (`/v1/<from>..<to>?base=GBP&symbols=EUR` returns every ECB business day,
  including the last one before the start).
- Decisions M1–M10. Branch `feat/multi-currency-budget` from `feat/enable-banking` (`07d9e86`).
- Server (lead): schema and migration `0023`, pure `services/fx/conversion.ts` with property tests
  (rounding checked against SQLite itself), rates store, Frankfurter client, download service,
  conversion service wired into every write path, `/api/currencies`, `budgetValue` in the budget
  and every report, net worth and balances at the rate of the day, accounts on budget in another
  currency, transfers uncategorized when an account moves on or off budget (M8), backups.
- Review fixes: every new transaction started a rate download once the budget had any account in
  another currency (now only a transaction in another currency left without a rate does); a
  restore kept the installation's rates whenever the backup had none (now only for backups made
  before these tables existed, so the e2e database resets cleanly).
- Client (three agents, Haiku, extra-high effort, disjoint files, reviewed by the lead): Settings →
  Currencies and the budget currency on the server (`BudgetCurrencySync`); accounts on budget in
  another currency, converted balances and totals (`utils/accountValues.ts`), the budget's
  waiting-for-a-rate notice; converted amounts on transactions, day totals in the budget currency
  and the value typed in from the detail panel (`utils/fxDisplay.ts`). The lead replaced a
  query-cache subscription with the normal `useCurrencies()` hook by guarding `window` in
  `api/base.ts`.
- Guide (accounts, settings, budgeting, transactions, reports, recurring, bank sync, privacy, FAQ,
  tour), `CLAUDE.md` / `AGENTS.md`, `SECURITY.md`, website security page, demo README.
- e2e: an account in another currency on budget counted once a rate is typed in, a value typed in
  from the detail panel and back to the day's rate, putting an account on budget uncategorizing
  an exchange, the demo refusing downloads; the phone overflow check visits Settings → Currencies.
- Final checks: server 434 tests, client 194, e2e 128 (all projects), `tsc` clean in client and
  server, Prettier clean, client and demo builds succeed.
