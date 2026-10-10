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
