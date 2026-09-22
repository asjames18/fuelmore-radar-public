# Public and personal Radar editions

Status: design for review. User approved the product split; no implementation or new deployment is included in this document.

## Intent
Preserve the complete personal dashboard for its owner while providing a simpler, read-only, open-source public dashboard. Improve RPC reliability, wallet-read progress and truthful freshness. Success means separate access boundaries, no owner defaults in public artifacts, useful public pages and recoverable reads without fabricated results.

## Edition boundaries
Keep the existing private repository and full personal application. Protect the personal production Worker and its preview routes with Cloudflare Access restricted to the owner's chosen identity. Verify unauthenticated requests cannot reach its assets or APIs. Identity configuration is a release prerequisite; do not guess an allowed email.

Create a separate public repository with clean history, MIT licensing for original project code, retained third-party notices, public documentation and no personal addresses/configuration. Review licensing before publication. Share neutral chain adapters and components through versioned source modules; the personal repository consumes the public core while private cockpit modules and owner settings remain private. Do not expose private modules merely by hiding navigation. Public and personal builds have separate deployment configuration, caches for user preferences and release checks.

## Public pages
- Overview: keep markets, protocol and activity. Remove source-count diagnostics and risk panels. Retain compact coverage time, delayed and unavailable labels.
- Cockpit: accept a visitor's wallet, with no initial owner address or reset-to-owner action. Remove risk profile, environment/mix explanations, direction signals, action bias/weights and Risk War. Retain remaining inventory, maturity and claim/value panels, subject to validation and explicit non-executable valuation labels.
- Markets: separate selectable token price charts and optional normalized percentage comparison. Preserve real flat prices, gaps and observation times. Current browser-session observations are not historical candles; no synthetic history.
- Protocol: preserve verified statistics and fee flow; remove risk signals.
- Positions: retain lookup, validation, pinned pagination and distinct empty/partial/error states. Visitor preferences stay local to their browser.
- Planner: publish only calculations verified against deployed rules and tests. Initially expose a Coming soon page publicly until the fee/date flows pass release validation; preserve the personal planner.
- Contracts: keep every central registry identity, roles and truthful metadata status; remove risk signals. Unreachable metadata is not unverified source and verification is not an audit.

## RPC recommendation
Keep Cloudflare for static assets and the read-only API gateway. Use a managed Alchemy Robinhood mainnet endpoint as the proposed primary, with archive reads for indexing. An independent supported provider is an optional secondary after capability verification. No paid subscription or account creation is authorized by this spec.

Evidence: https://docs.robinhood.com/chain/connecting/ explicitly discourages production use of its public rate-limited endpoint, recommends Alchemy and lists independent providers. Current Worker and Node collector hard-code the public endpoint.

Put provider URLs and keys exclusively in backend secrets, never VITE variables, browser bundles, logs, Git or public documentation. Make the Node collector and Worker use configured upstreams. Check chain ID 4663, required historical blocks, eth_getLogs range limits, batched eth_call and block hash consistency before enabling a provider. Archive access and plan limits must be verified with the actual endpoint, not inferred from the provider name.

The gateway keeps read-only method restrictions and adds payload/range limits, bounded concurrency, per-client quotas, a total retry budget, exponential backoff with jitter and Retry-After handling. Cache/deduplicate identical public reads by chain, method, parameters and block identity; cap latest-block cache age and never mix pinned snapshots. Errors are not zero values. Provider failover requires matching chain and pinned block hash; otherwise stop the snapshot and offer restart. Contract reverts are not retried as transport outages.

## Collection and loading
Preserve the Node collector and its reorg-safe logic. First make its upstream configurable. Then decouple scheduled collection from committing data and redeploying the site: a single authenticated publisher writes complete reports to shared storage only after validation. Retain the last good report and original coverage time. Hosting this long-running publisher is a separate operational decision after measuring workload; do not move the entire app or reintroduce approximate edge counting.

Public traffic reads cached protocol/activity snapshots. Wallet-specific reads use bounded pages, cancel superseded requests, preserve one block/hash across pages and show completed/total progress. Explain that large wallets may take several minutes; do not promise an unmeasured finish time. Define timeouts and retry actions so a failed scan cannot spin forever. FUEL amounts and market valuations retain their separate observation times.

Operational checks measure chain lag, collection age, success/error rates and latency. Keep detailed diagnostics private, with meaningful freshness summaries public. No guarantee of uninterrupted upstream availability; degraded operation must remain honest and usable. External alerts or subscriptions require separately configured destinations and authorization.

## Verification and rollout
1. Characterize endpoint capabilities and latency with read-only representative requests; record plan constraints without exposing secrets.
2. Add regression tests for isolation, no owner defaults, provider timeout/429 recovery, snapshot hash mismatch, stale reports, partial pages and chart gaps/scales.
3. Run npm test, npm run lint and npm run build; inspect public artifacts for private settings and credentials.
4. Test all public navigation on desktop and 390px mobile, invalid/empty/large wallets, cancellation, partial failures, stale results and console errors.
5. Verify all registry addresses retain their documented roles. Cross-check representative protocol and wallet outputs at their pinned blocks. Publish no unsupported planner calculations.
6. Stage separate deployments. Test private Access including preview routes and ensure public APIs expose no owner-specific state.
7. Publish the clean public repository only after artifact/licensing review; verify each deployed edition and collector recovery. Preserve the current deployment for rollback until the split is verified.

## Exclusions
No wallet connections, approvals, signing, transactions, price predictions or new trading recommendations. No paid infrastructure purchase, access-policy mutation or new public repository is performed during design review.
