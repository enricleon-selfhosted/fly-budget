# Development log

## 2026-10-10

- Analysis of Enable Banking (API, restricted production mode, PSD2 limits, Spain/Redsys
  specifics) and of the existing Plaid/SimpleFIN code; findings folded into
  [decisions.md](decisions.md) and [architecture.md](architecture.md).
- Requirements from the product owner: follow repo conventions, decoupled single-responsibility
  modules behind interfaces, tests against interfaces; accounts can be ignored; transfers between
  related accounts; YNAB as the reference for behavior; multi-currency awareness.
- Branch `feat/enable-banking` created from `main` (`b0dcef9`); baseline: server 263 tests and
  client tests green.
- Phase 0 (money, account currency, transfer link helpers, migration `0021`), Phase 1 (bank-sync
  core with contract suite) and Phase 2–3 (adapter, services, routes, callback before the guards,
  startup sync, encryption, backup re-link, demo stubs, reports leave out foreign currencies) done
  by the lead, with tests through public interfaces.
- Client data layer (types, API, hooks, consent polling with paste fallback, `currencyCode`,
  `formatCurrency(cents, currency)`) by the lead.
- Delegated to low-cost agents (Haiku, extra-high effort), on disjoint files, reviewed by the
  lead before committing: per-account currency in the UI + "Unlink transfer" (done; the lead added
  `currency` to the accounts API types and to account undo/redo), user guide pages (done; the lead
  corrected the PSU-header claim), Enable Banking UI (in progress), remaining currency displays and
  stale provider mentions (in progress).
- Repo docs: `CLAUDE.md`/`AGENTS.md` (also fixed: `insertNewTransaction` lives in `ruleService.ts`,
  `autoCategory()` no longer exists) and `SECURITY.md`.
- Review of the delegated work found and fixed: the welcome screen's Enable Banking button looping
  back to `/welcome` for a budget without accounts; a consent start that could finish after its
  dialog closed; the bank tab opening after an `await` (popup blockers); manual transfers between
  accounts in different currencies (now refused by the server and hidden in the picker); amount
  fields that still showed the budget symbol on foreign-currency accounts.
- e2e: Enable Banking setup, welcome entry, the whole connect flow (with `/api/enablebanking`
  stubbed in the browser), the connection card, currency rules and unlinking a transfer; the phone
  overflow check now visits the Enable Banking tab.
- Final checks: server 376 tests (baseline 263), client 121 (baseline 85), e2e 122 (all projects),
  `tsc` clean in client and server, Prettier clean, client, demo and server bundle builds succeed.
- Not verified against the real Enable Banking API (needs a registered application and a linked
  bank account): the request/response shapes follow the API reference, and the fakes in the tests
  follow the same reference.
