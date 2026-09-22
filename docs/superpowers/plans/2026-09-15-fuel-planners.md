# FUEL fee and duration planners

User authorized the next planner phase conditional on accuracy. Existing design:
`../specs/2026-09-15-fuel-more-workspace-design.md`.

## Scope and evidence

Implement inline in this existing non-Git workspace. Preserve independent activity
and market data. Source retrieval is blocked by explorer security challenges;
therefore do not implement locally copied reward, fee-split or penalty formulas.
Use deployed fee getters directly. Network gas remains unavailable without a
wallet transaction simulation. No transactions or wallet connection.

- [x] Run existing tests and compare the completed activity report with RPC state
  at its own block. Block 64048985: 23,212 active mints, global rank 23,213.
- [x] Probe mintFee, claimFee, batchFee, batchClaimFee and getCurrentAPY using RPC.
- [x] Add `src/lib/planner.ts`: validate integer batch sizes and decimal amounts;
  chain-check, pin all contract reads to a block, preserve individual failures,
  check block hash again; return block/time, gas observation and fee quotes.
- [x] Test rejected inputs, decimal precision, pinned reads, partial failures,
  wrong chain and changed block hash in `src/lib/planner.test.ts`.
- [x] Add a Planner navigation view and `src/components/FuelPlanner.tsx`: compare
  selected batch size with 1/10/25/50; distinguish protocol fees from total costs;
  clear old quotes when reloading; show quote age and date assumptions. Staking
  accepts amount/term for a hypothetical calendar plan; yield remains unavailable.
- [x] Add component regression checks for changed-input invalidation and absence
  of fabricated rewards. Verify desktop/mobile with the browser.
- [x] Run tests/lint/build and document evidence and remaining source limitations.

## Acceptance

No projected token rewards, net profit, penalties, or executable transaction totals
are asserted. Every fee number is a contract response at the displayed block for
the displayed gas-price input. Claim/remint is explicitly the sum of two fee
getters, not simulation. UI batch limit 50 is a planner limit. Calendar dates are
hypothetical and do not imply transaction eligibility. RPC failures show unavailable.

Implementation complete for the accuracy-limited fee/calendar scope above.
Full reward planners remain blocked on deployed-source verification.
