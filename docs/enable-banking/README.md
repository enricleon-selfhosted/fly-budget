# Enable Banking integration — development tracking

European bank sync for FlyBudget through [Enable Banking](https://enablebanking.com), a licensed
PSD2 aggregator (2,500+ banks in 29 countries). Plaid and SimpleFIN mostly cover the US; this
covers Spain, Germany, France, the Nordics and the rest of the EEA.

This folder tracks the work while it is in progress. When it is done, the user-facing parts move
to `website/docs/bank-sync.mdx` and the conventions to `CLAUDE.md` / `AGENTS.md`; this folder can
then stay as the design record.

| File                               | What it holds                                                           |
| ---------------------------------- | ----------------------------------------------------------------------- |
| [plan.md](plan.md)                 | Phases and tasks with their status — the checklist to follow            |
| [architecture.md](architecture.md) | Modules, interfaces, data model, flows and the security of the callback |
| [decisions.md](decisions.md)       | Decision log (why things are the way they are)                          |
| [api.md](api.md)                   | HTTP contract of `/api/enablebanking/*` (what the client relies on)     |
| [log.md](log.md)                   | Dated development log                                                   |

## Status

See [plan.md](plan.md). Branch: `feat/enable-banking`.

## Scope in one paragraph

Each user registers their **own** Enable Banking application (free "restricted production" mode
for personal use: it can only read accounts the user linked in Enable Banking's control panel)
and gives FlyBudget the application id and private key. FlyBudget then lets them pick a country
and bank, sends them to the bank to consent, and imports booked transactions of the accounts they
choose — every account can be imported as a new account, linked to an existing one, or ignored.
Imports behave like YNAB's: an imported transaction **matches** one the user already typed in
instead of duplicating it, and money moving between the user's own accounts becomes a
**transfer**. Each account remembers its currency; accounts in another currency than the budget's
are kept off budget and out of net worth totals.
