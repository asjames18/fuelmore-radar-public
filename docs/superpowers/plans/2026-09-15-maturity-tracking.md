# FUEL maturity tracking implementation plan

Approved by the user's “proceed” after the maturity timeline, wallet calendar and
saved watchlist proposal. Implement in the current non-Git workspace.

## Scope and definitions

- Reconstruct mint lifecycles from RankClaimed and MintClaimed in canonical log
  order, starting at token genesis. Preserve historical scheduled maturities and
  only project still-active positions into the future.
- Derive event maturity as block timestamp + term × 86400. Compare sampled active
  positions with userMints at the report block; compare active event-derived count
  with activeMinters. If these checks fail, expose maturity data as unavailable;
  retain independent daily activity reporting.
- “Scheduled” is a derived maturity date, not a forecast of actual claims or sales.
- Wallet calendar uses direct maturityTs values from loaded positions, groups UTC
  dates, and classifies upcoming or past maturity. No penalty deadline or reward
  calculation is implied; overdue means past the scheduled maturity only.
- Watchlist is browser-local, address-only, deduplicated, with explicit failure
  handling when persistence is blocked. No wallet connection or notification
  subscription is involved.

## Tasks

- [x] Add tested event lifecycle reconstruction: canonical order, duplicates,
  claim/remint, older active positions, historical vs future bins, exact boundary.
- [x] Integrate complete-history scanner, count/sample checks, schema versioning,
  and maturity report coverage. Start a real scan for validation.
- [x] Add a scheduled-maturity chart next to actual daily mint/claim data, including
  next 7/30 days, future-date unknown actuals, source time and validation coverage.
- [x] Add tested wallet calendar aggregation and local watchlist persistence.
- [x] Integrate the calendar and saved addresses with existing paginated lookup;
  keep partial/failed coverage visible and provide a refresh path.
- [x] Run all tests, lint/build; verify live API results, chart toggle, watchlist,
  wallet calendar and responsive layout in browser. Document remaining limits.

Verified live at block 64032156: 23,167 active positions; three maturity samples matched.
30 tests, lint, build and browser interaction checks passed. See README for limits.
