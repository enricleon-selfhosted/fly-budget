# Budgeting across currencies — development tracking

Lets an account in another currency count in the budget, converted to the budget's currency, for
people who spend from it. Accounts in another currency can still stay off budget, where income
counts when it's exchanged into the budget currency (see
[Enable Banking D24](../enable-banking/decisions.md#d24--income-in-another-currency-counts-when-it-becomes-the-budgets-currency)).
The choice is per account.

| File                         | What it holds                                  |
| ---------------------------- | ---------------------------------------------- |
| [plan.md](plan.md)           | Tasks and their status                         |
| [decisions.md](decisions.md) | Decision log (why things are the way they are) |
| [api.md](api.md)             | HTTP contract the client relies on             |
| [log.md](log.md)             | Dated development log                          |

## Status

In progress on `feat/multi-currency-budget`, which starts from `feat/enable-banking`.

## Scope in one paragraph

The budget currency moves to the server. Each transaction in an account in another currency keeps
the exchange rate used to convert it: exact when it's one side of an exchange into the budget
currency, otherwise the day's rate from a table of daily rates (downloaded from the European
Central Bank through Frankfurter if the user turns that on, or entered by hand), or an amount the
user typed in. The budget and every income and spending report add up these converted amounts;
balances and net worth value those accounts at the rate of the day. Transactions without a rate
stay out, as before, and the budget says how many are waiting.
