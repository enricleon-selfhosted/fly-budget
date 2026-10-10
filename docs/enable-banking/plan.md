# Plan

Status: ☐ to do · ◐ in progress · ☑ done · ⏸ deferred. Owner: **lead** (main session) or
**agent** (delegated, reviewed by lead). Update this file in the same commit as the work.

## Phase 0 — Foundations

| #   | Task                                                                                 | Owner | Status |
| --- | ------------------------------------------------------------------------------------ | ----- | ------ |
| 0.1 | Tracking docs (`docs/enable-banking/`)                                               | lead  | ☑      |
| 0.2 | `utils/money.ts`: exact decimal → hundredths, shared; SimpleFIN uses it              | lead  | ☐      |
| 0.3 | Migration `0021_enable_banking` + schema (+ drizzle snapshot)                        | lead  | ☐      |
| 0.4 | `accounts.currency` in the accounts API (create/update/list)                         | lead  | ☐      |
| 0.5 | `linkTransfer` / `unlinkTransfer` helpers + `POST /transactions/:id/unlink-transfer` | lead  | ☐      |

## Phase 1 — Bank-sync core (`services/bankSync/`)

| #   | Task                                                        | Owner | Status |
| --- | ----------------------------------------------------------- | ----- | ------ |
| 1.1 | `types.ts` (normalized types, `BankDataSource`)             | lead  | ☐      |
| 1.2 | `matching.ts` pure decisions + property tests               | lead  | ☐      |
| 1.3 | `importStore.ts` (interface + SQLite)                       | lead  | ☐      |
| 1.4 | `importTransactions.ts` + tests through its public function | lead  | ☐      |
| 1.5 | `BankDataSource` contract test suite                        | lead  | ☐      |

## Phase 2 — Enable Banking adapter (`services/enableBanking/`)

| #   | Task                                                               | Owner | Status |
| --- | ------------------------------------------------------------------ | ----- | ------ |
| 2.1 | `jwt.ts` + tests                                                   | lead  | ☐      |
| 2.2 | `schemas.ts`, `errors.ts`                                          | lead  | ☐      |
| 2.3 | `client.ts` (fetch injected) + tests                               | lead  | ☐      |
| 2.4 | `mapping.ts` pure + property tests                                 | lead  | ☐      |
| 2.5 | `dataSource.ts` + contract suite                                   | lead  | ☐      |
| 2.6 | `consent.ts` + tests                                               | lead  | ☐      |
| 2.7 | `store.ts`                                                         | lead  | ☐      |
| 2.8 | `connectService.ts`, `accountMapping.ts`, `syncService.ts` + tests | lead  | ☐      |

## Phase 3 — Server wiring

| #   | Task                                                   | Owner | Status |
| --- | ------------------------------------------------------ | ----- | ------ |
| 3.1 | `routes/enableBanking.ts` + route tests                | lead  | ☐      |
| 3.2 | Callback mounted before the guards + security tests    | lead  | ☐      |
| 3.3 | `encryptStoredCredentials`, backup re-link, demo stubs | lead  | ☐      |
| 3.4 | Startup sync (6-hour rule)                             | lead  | ☐      |
| 3.5 | Net worth leaves out foreign-currency accounts         | lead  | ☐      |

## Phase 4 — Client

| #   | Task                                                                                                  | Owner | Status |
| --- | ----------------------------------------------------------------------------------------------------- | ----- | ------ |
| 4.1 | Types, `api/enableBanking.ts`, `hooks/useEnableBanking.ts` (+ consent polling hook)                   | lead  | ☐      |
| 4.2 | Settings → Connected Banks: provider tab, config form, connection card                                | agent | ☐      |
| 4.3 | Connect modal: country → bank → consent (paste fallback) → mapping → sync → summary                   | agent | ☐      |
| 4.4 | Currency: `currencyCode` preference, `formatCurrency(cents, currency)`, account views, account modals | agent | ☐      |
| 4.5 | "Unlink transfer" in the transaction detail panel                                                     | agent | ☐      |
| 4.6 | Demo: `NotInDemo` wording, `ConnectedAccountsDemo`                                                    | agent | ☐      |

## Phase 5 — Docs and checks

| #   | Task                                                                                      | Owner | Status |
| --- | ----------------------------------------------------------------------------------------- | ----- | ------ |
| 5.1 | `website/docs/bank-sync.mdx` (setup guide), `settings.mdx`, `privacy.mdx`, `security.mdx` | agent | ☐      |
| 5.2 | `SECURITY.md`, `CLAUDE.md` + `AGENTS.md`                                                  | lead  | ☐      |
| 5.3 | Typecheck, tests, Prettier, client build                                                  | lead  | ☐      |
| 5.4 | e2e: Settings shows the Enable Banking tab without page errors                            | lead  | ☐      |

## Later (not in this branch)

- ⏸ Migrate SimpleFIN and Plaid onto the bank-sync core (matching + transfers for them too).
- ⏸ Relay page on the project website so desktop installs get an automatic https callback.
- ⏸ Exchange rates; number formats per locale (`1.234,56 €`).
- ⏸ Bank logos (server fetches once, stores a data URL).
- ⏸ Periodic background sync in server mode (respecting D10).
- ⏸ Consent-expiry reminder on the dashboard.
