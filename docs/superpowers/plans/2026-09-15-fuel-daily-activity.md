# FUEL daily activity implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Execute inline in the existing non-Git workspace.

**Goal:** Compare daily FUEL mint starts and reward claims, with unique sending wallets and event counts.

**Architecture:** A local Node HTTP service scans FUEL contract events over a bounded rolling seven-day window. It persists completed scans to disk and resolves transaction senders so batch proxy addresses do not inflate wallet counts. A React panel fetches the daily report and displays coverage explicitly.

**Tech Stack:** Existing React, TypeScript, Recharts, viem; Node built-in HTTP and filesystem modules.

**Spec:** ../specs/2026-09-15-fuel-more-workspace-design.md, narrowed by the user's September 15 request for daily minting versus claiming.

## Global constraints

- Robinhood Chain 4663; FUEL address from the existing registry.
- Counts represent wallets, not verified human identities.
- Mint starts use RankClaimed; reward claims use MintClaimed.
- UTC calendar days; today is incomplete. Claim amounts are separate from mint starts.
- Missing coverage is never rendered as zero. Exclude the latest 64 blocks, and rebuild the rolling window each scan to avoid accumulating stale logs.
- Read public chain data only; no wallet signature.

### Task 1: event report and local collector

Files: server/activity.mjs, server/index.mjs, server/activity.test.mjs.

Interface: aggregateActivity(events, fromTimestamp, throughTimestamp) returns days containing date, mintWallets, claimWallets, mints, claims, claimedFuel; event records have id, timestamp, sender, kind and amount (decimal raw-unit string).

- [x] Test repeated proxy events in one transaction count as several mints but one sender; separate UTC days and claim/remint count independently. Use Node's test runner.
- [x] Implement a seven-day UTC range, block timestamp binary search, bounded log windows, exact event decoding, transaction sender lookup, and duplicate-log removal.
- [x] Serve GET /api/fuel-activity with report, progress, scan timestamp and errors. Keep the last completed report during refresh failure. Persist using atomic rename; validate chain and window when loading. Bind to loopback and allow only the app's same-origin Vite proxy.
- [x] Exercise real RPC fetching; never manufacture live counts when the provider fails.

### Task 2: daily comparison panel

Files: src/components/FuelActivity.tsx, src/styles.css, src/App.tsx, vite.config.ts, package.json.

Interface: GET /api/fuel-activity returns status, progress, error and report (days, fromTimestamp, throughTimestamp, throughBlock, generatedAt).

- [x] Add grouped bars for minting/claiming wallets, toggle to individual event counts, and a daily table including claimed FUEL.
- [x] Label UTC, incomplete current day, transaction-sender methodology and last scanned block/time. Display collection and unavailable states distinctly.
- [x] Mount in Overview and Protocol. Proxy /api to loopback service; add one-command service/frontend startup.
- [x] Run source tests, server tests, lint, build and browser verification. Limit test/lint discovery to application code, excluding existing browser profiles.

### Verification

Run `npm test`, `npm run lint`, `npm run build`. Use the local application to switch the comparison metric and verify chart/table content. Include deterministic aggregation tests for empty days, duplicates, batch events, claim/remint, UTC boundaries, and claimed bigint precision. Record live scan completion or its exact blocker.


## Completed verification — 2026-09-15

- 13 tests pass: 8 frontend utility tests and 5 aggregation/provider-limit tests.
- ESLint and production build pass. Vite reports the existing large bundle warning.
- Real chain scan completed through block 64013177 (2026-09-15 22:37:30 UTC).
- September 14: 35 minting wallets, 17,611 mint starts, zero claim events.
- September 15 through coverage time: 26 minting wallets, 5,550 starts, zero claims.
- Total mint-start events (23,161) match the observed activeMinters read at QA time.
- Desktop and 390×844 mobile views inspected. Mint / claim counts switches the
  chart series from wallets to events; exact values remain available in the table.
- Browser console had no errors before the intentional service-restart check.
- Restarted through npm run dev; the API served the persisted completed report
  immediately while a fresh scan began. Default viewport restored afterward.
- Full wallet execution, MORE analytics, planners, and long-term indexed history
  remain separate milestones; this delivery is the requested daily FUEL comparison.
