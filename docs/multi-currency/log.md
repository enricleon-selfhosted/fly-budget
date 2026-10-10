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
