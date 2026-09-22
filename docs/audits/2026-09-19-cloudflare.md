# Cloudflare reliability and data-integrity audit — 2026-09-19

Scope: current main (5194213), public read-only HTTP observations of
https://fuelmore-radar.asjames18.workers.dev/, Worker routes, activity pipeline,
checkpoint workflow and stale-data rendering. This is not a Solidity/security
certification or a guarantee that no other bugs exist. Prior uncommitted feature
work remains in the pre-update stash and was not included.

## Reproduced findings and local fixes

1. **High: stale KV overrides newer publisher data.** Live `/api/fuel-activity`
   returned KV block 66668964 while `/fuel-activity.json` served block 67230190.
   `loadReport` previously returned the first usable KV value without checking
   assets. It now reads both independently and selects the newer valid publisher
   block; KV failures do not block the assets fallback.
2. **High: edge indexing violates wallet/maturity definitions.** The live edge
   report showed September 19 mintWallets=100 for 100 mint starts. The newer
   sender-resolved publisher report had 583 starts and 12 minting wallets. Code
   used indexed proxy users and `max(seedCount, addedUsers)` rather than a union
   of transaction senders. It also carried old maturity data under an advanced
   report timestamp and had no snapshot hash/reorg validation. Removed this
   independent aggregate writer. Production collection remains in the existing
   Node publisher, which resolves senders and validates maturity. Legacy
   edge-incremental reports are rejected. Worker cron/refresh now only copies
   complete publisher snapshots; request traffic no longer starts RPC scans.
3. **High: stale API responses disappear in the UI.** The Worker emits `stale`,
   while FuelActivity accepted only ready/loading/error. Reproduced the live
   unavailable-feed message and a failing component regression. The frontend now
   retains stale reports with the supplied warning and original block/time.
4. **Medium: checkpoint cache never advances.** GitHub cache keys were constant;
   exact hits are immutable. Changed to run/attempt-specific keys and newest
   matching restore prefix. Full deployment and workflow execution remain needed
   to validate delivery cadence end to end.
5. **Medium: Worker RPC response handling.** Reproduced invalid empty batches
   being forwarded, mixed read/write denial returning a single unmatchable null
   ID, unsupported API requests falling through to SPA HTML, and copied gzip/
   length headers after materializing upstream response text. Added validation,
   bounded batch size, per-ID denial responses, explicit route errors, sanitized
   headers and a 10-second upstream timeout. Writes remain denied.
6. **Coverage gap:** normal npm test omitted rpc-allowlist tests and all Worker
   handler tests. It now explicitly includes both suites alongside the existing server tests.
7. **Medium: failed transfer reads look empty.** Browser QA showed both explorer
   transfer sources unavailable while Recent activity said no transfers returned.
   ActivityTable now receives source coverage, labels failed/partial reads, and
   reserves the empty message for successful responses from both sources.

## Files

- server/activity-edge.mjs and its test: publisher selection, validation, KV sync.
- server/worker.mjs and new worker.test.mjs: route/RPC behavior.
- src/components/FuelActivity.tsx and new test: stale status support and coverage copy.
- src/components/ActivityTable.tsx, its new test, and src/App.tsx: transfer coverage.
- .github/workflows/refresh-activity.yml: checkpoint cache key lifecycle.
- package.json: include all server regression tests.
- README.md, docs/PROJECT_OVERVIEW.md, docs/product-context.md: current behavior and evidence.

## Verification and release boundary

Tests were first run failing against the affected behavior, then passed after
fixes. Captured production report fixtures were replayed through the fixed
selector: legacy KV rejected, publisher asset accepted, block 67230190 selected.
Wrangler deploy --dry-run successfully bundled the Worker and resolved the
ACTIVITY/ASSETS bindings without publishing.

Local Worker QA ran with Wrangler 4.135.0 and Node 24.21.0 (the older installed
Wrangler cannot run this compatibility date; current Wrangler requires Node 22+).
Desktop and 390-pixel mobile activity loads, wallet/count toggle, and Protocol
navigation worked. Mobile document width was 390 with no page overflow. Console
error inspection returned no errors. Market and protocol data loaded; explorer
metadata/holders/transfers remained unavailable and the dashboard reported partial
coverage. Stale-report behavior was tested with a component regression fixture;
the local browser received a valid publisher report with delayed-data labeling.
The local scheduled-event endpoint completed successfully and logged
`publisher-synced` at block 67312066, writing only the emulated local KV namespace.

Final regression run: `npm test` passed 104 tests (70 frontend, 34 server);
`npm run lint` and `npm run build` passed. Vite still reports the existing large
main-bundle warning (996.23 kB minified). The transfer-source regression first failed against the
old rendering and then passed with coverage-aware rendering.
After rebuilding, a clean browser reload showed the corrected transfer-unavailable
message on the final build; console error inspection again returned no errors.

No production deployment, GitHub push, workflow dispatch or production KV write
was performed. Therefore the live site still runs the old code until release.
Activity freshness depends on successful scheduled collection and Workers Builds;
it is deliberately reported as stale when that pipeline lags. The large frontend
bundle warning remains outside this focused repair.

References:
- https://developers.cloudflare.com/kv/concepts/how-kv-works/ — eventual consistency;
  KV is not an atomic aggregation database.
- https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
  — existing cache contents cannot be replaced under the same key.
