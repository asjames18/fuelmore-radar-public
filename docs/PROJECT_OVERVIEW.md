# FUEL / MORE Radar

## Project overview and implementation handoff

**Canonical project folder:** `D:\fuelmore-radar`  
**Current version:** local read-only application  
**Primary network:** Robinhood Chain mainnet, chain ID `4663`  
**Document updated:** 2026-09-20 UTC

### Trading charts and cockpit transport — 2026-09-20 UTC

Price charts offer official Dexscreener USD candlesticks for each canonical pool,
plus a saved-observation USD overlay (FUEL left axis, MORE right axis) and optional
percentage comparison. The candle embeds are temporary: once the radar's own
collector history spans 7 days, they retire automatically and the chart defaults
to the own-history Compare USD view (external Dexscreener pool links remain).
Independent price axes are explicitly labeled. Liquidity
uses a filled USD comparison; no synthetic liquidity candles or trade history are
invented. The exact-observation dropdown was removed from both chart locations.
Candle history is hosted by Dexscreener and depends on its availability; local
comparison history remains limited to saved browser observations.

An existing 288-slot public wallet loaded once but failed on a repeat refresh.
A read-only production RPC probe observed transient HTTP 502 during a 634-request
inventory scan. Bursts also risk the existing 600/min gateway cap. Cockpit reads
now share a 200ms request scheduler, retry transient transport errors at most
three times, honor 429 cooldowns, and remain abortable. The proxy protection is
unchanged. Block/hash and chain checks are preserved; failed reads remain unknown.
A paced production RPC scan returned all 288 slots with sampleIncomplete=false.
Failure messages distinguish throttling and snapshot changes without raw URLs.

### Comparison charts and public presentation — 2026-09-20 UTC

Public visitors see only last sync time and the 5-minute cadence in the header.
Detailed sync controls, badges, and source timestamp diagnostics remain private.
Comparison charts default to FUEL and MORE together: price is percent change from
one shared nonzero observation; liquidity uses USD. Individual token views retain
absolute USD prices. UTC range filters and draggable zoom handles are available.
Missing values remain gaps; snapshots are not represented as OHLC candles.

The publisher accepts backend-only BLOCKSCOUT_API_KEY for Blockscout's documented
chain-4663 PRO API. Calls are spaced at four/second for the free plan; credentials
never enter saved dashboard data. The user-approved key is encrypted in the private GitHub repository. Actions run
35486574533 succeeded with all seven sources available at 2026-09-20T03:27:18.711Z:
110 FUEL holders, 177 MORE holders, transfer lists and contract metadata restored.
Protocol observations were pinned to block 67618018. Live holder data survived
reload; public desktop/390px comparison charts and console checks passed.
Public v0.1.3 commit d8f2bca deployed as c60186d3; private implementation b5e1dd1
deployed as 42e81a5c. Both preserve shared saved data. Chart history remains local
to each browser and uses observed points, not historical OHLC candles.

### Saved dashboard snapshots — 2026-09-20 UTC

The aggregate dashboard now uses a single scheduled Node publisher in the existing
15-minute activity workflow, writing dashboard-snapshot-v1 to shared ACTIVITY KV.
`server/publish-dashboard.mjs` reuses the TypeScript adapters via Vite's SSR loader;
its provider and storage credentials remain server-only. Source groups merge only
when complete. On failure, prior complete groups retain their observation time;
protocol groups retain their pinned block/hash together. No wallet data is stored.

GET /api/dashboard reads storage without calling upstream services. The browser
hydrates its edition-specific cache immediately, checks the endpoint every minute,
keeps data on fetch/storage failure, and rejects older syncs and invalid envelopes.
The public header shows only the last sync time and 5-minute cadence; detailed
source timestamps, diagnostics, manual refresh, and status badges remain private. Data older than 30 minutes is stale;
provider delays and GitHub scheduling can extend that age. Market history records
the observation timestamp, never each repeated cache read. Localhost retains direct
reads. The publisher failure is reported without preventing independent activity
collection. Live verification: Actions run 35485654439 successfully published the first shared
snapshot at 2026-09-20T03:05:30.540Z. Public API returned HTTP 200 and 17 protocol
values pinned to block 67605078 with its hash; activity separately reached 67605037.
Both live editions displayed saved data across reload and manual refresh. Desktop
and actual 390px views had no document overflow or captured console errors. Empty
explorer sources remained explicitly unavailable because Blockscout challenged
the publisher; a successful first observation is needed before those can be retained.
Anonymous access to the personal site still redirects to Access (HTTP 302).
Regression checks: 178 personal tests and 162 public tests passed, with lint and
both builds/isolation checks. Failure retention, exact bigint serialization,
invalid snapshots, original timestamps, and storage failure are covered by tests.
No deliberate production outage was induced. Existing bundle-size warning remains.

### Current release status — 2026-09-20 UTC

The personal Worker is deployed from the integrated release on `main` (4e6b1cf).
Live verification returned all 17 protocol reads and all seven source categories.
Cloudflare Access requires login for production and previews, with the exact-email
policy for asjames18@proton.me; an anonymous production request returned HTTP 302.

The scheduled GitHub publisher runs every 15 minutes using VALIDATION_RPC_URL and
2,000-block log ranges. Production run 35484751067 completed and published the
validated snapshot through block 67592507 to shared KV. The personal site displayed
that same block with fresh coverage. Scheduling can be delayed by GitHub Actions;
this is periodic collection, not a guaranteed real-time feed. Because GitHub drops
most schedule triggers (observed ~8-10 runs/day with gaps up to 7h), the Worker's
own reliable 5-minute cron runs a watchdog (`server/watchdog.mjs`): when either
pipeline snapshot in KV is older than 4 hours it forces a `workflow_dispatch` run
of the same workflow, with a 60-minute cooldown between forced runs. The watchdog
needs the `GITHUB_DISPATCH_TOKEN` Worker secret (fine-grained PAT, Actions: Read
and write on asjames18/fuelmore-radar); without it the pipeline runs at GitHub's
natural cadence and nothing else changes.

Public source v0.1.1 is at https://github.com/asjames18/fuelmore-radar-public.
The separate public Worker is live at
https://fuelmore-radar-public.asjames18.workers.dev/ (version 27456bb6,
public source commit 48b4d73). Its build uses only
the public repository, a separate limiter namespace, encrypted RPC_URL, and the
shared public activity report. The private repository and owner-only Worker remain
separate. Public inputs start blank. Public nav is seven views: Overview,
Cockpit, Markets, Protocol, Contracts, Guide, Planner. Cockpit and Positions
merged into the Cockpit view's tabs (Positions; Inventory & claims); each
content block renders in exactly one view. Planner stays public as a "coming
soon" placeholder for the future prediction-plan tool — if you do this, this is
the possibility, based on current and future numbers (the private app keeps its
full Planner).

Live verification: public activity API returned ready through block 67592507;
public RPC returned chain 4663. All six navigation routes passed desktop and
390px overflow checks, with no captured browser console errors (2026-09-21;
the 7th route, Planner, was restored to public nav as a coming-soon placeholder
after that check). Blockscout later
returned HTTP 403 with a Cloudflare challenge, so explorer holder/transfer/contract
metadata remained explicitly unavailable; upstream availability is not guaranteed.
No old Worker cron remains configured.

Public Cloudflare deploys use the dedicated `wrangler.public.jsonc`
(name `fuelmore-radar-public`, assets `./dist-public` from `npm run build:public`,
the */15 snapshot cron kept, no dev-only vars). Deploy command is
`npx wrangler deploy --config wrangler.public.jsonc`. The public source keeps its
portable placeholder. Runtime RPC_URL is encrypted; ACTIVITY and RPC_RATE_LIMITER
bindings were verified after redeployment. Non-production public builds are disabled.

Release validation on integrated commit 4e6b1cf: 162 tests, lint, personal build,
public build and isolation checks passed. Existing bundle-size warning remains.
Documentation-only release records followed those checks. Existing unrelated draft
PRs were not merged.

Historical implementation checkpoints below describe what was verified at each
stage; this current-status section supersedes their pending/deployment statements.

## 1. Executive summary

FUEL / MORE Radar is a responsive intelligence workspace for the FUEL and MORE
ecosystem on Robinhood Chain. It combines market data, public contract state,
contract provenance, protocol activity, wallet-position lookup, maturity tracking,
and fee/date planning in one dashboard.

The application is intentionally read-only today. A user can inspect public data
and enter a public wallet address, but the application does not connect a wallet,
request signatures, submit transactions, custody assets, or handle private keys.

The project began as a monitoring dashboard inspired by the public FUEL and MORE
applications. It has since grown into a tested local product with six primary
views, a small Node activity collector, explicit source-health reporting, and
defensive handling for incomplete or stale data.

## 2. The problem it solves

The FUEL and MORE ecosystem is spread across several surfaces:

- protocol applications;
- token and controller contracts;
- Robinhood Chain RPC state;
- explorer metadata and indexed transfers;
- Dexscreener market pages; and
- wallet-specific mint and stake records.

Radar consolidates those surfaces without pretending that every source has the
same freshness or evidentiary weight. It is designed to help a user answer:

- What is happening in the FUEL and MORE markets now?
- Is each configured contract reachable and explorer-verified?
- What does the FUEL protocol currently report?
- How many FUEL mint starts and reward claims occurred each UTC day?
- When are active FUEL mints scheduled to mature?
- What direct and BatchMinter positions are associated with a wallet?
- What MORE stake records are associated with a wallet?
- What fees do the deployed contracts currently quote for direct and batch flows?
- Which observations are live, partial, delayed, app-reported, or unverified?

## 3. Current product scope

### Overview

The Overview view provides the broadest snapshot:

- FUEL and MORE price, liquidity, market capitalization, volume, and trade counts;
- a browser-local market history chart for the current device;
- holder-concentration indicators;
- protocol risk signals;
- seven-day FUEL minting-versus-claiming activity;
- 7-day and 30-day FUEL maturity outlooks;
- protocol fee-flow presentation;
- grouped protocol statistics and a Blockscout first-page top-holder board;
- aggregate protocol metrics;
- configured-contract status; and
- recent explorer-indexed token transfers.

### Cockpit

The Cockpit view is the personal decision desk for the pinned owner wallet
(`0x36ccC887e2c98f710F789a1f9551e24c01aDE6F6`), with optional custom wallet
lookup:

- environment direction from market + mint-book signals;
- action bias for mint / buy / sell / wait (situational, not advice);
- risk war / profile across liquidity, turnover, claim penalty, inventory,
  holders, coverage, and verification;
- maturity buckets and full per-slot inventory grouped by UTC unlock day;
- per-day sell modeling: choose a day, size how many slots, optional liquid
  balance, USD notional, and liquidity-band framing. FUEL amounts
  (inventory, `getGrossReward`, late penalty) are on-chain RPC reads; USD
  price and pool depth come from Dexscreener, which itself mirrors on-chain
  pool reserves — still labeled third-party and never an executable quote.

### Markets

The Markets view focuses on the configured FUEL/WETH and MORE/WETH pools. It
shows market snapshots and links to the corresponding Dexscreener pages. Market
figures are third-party observations, not executable quotes.

Scheduled snapshots are collected every 5 minutes by the Worker's scheduled
handler into the `market-history-v1` KV key (90 days of points, all-or-nothing
per run: both pairs must fetch and validate or nothing is written).
`server/price-sources.mjs` tries price sources in ordered failover —
GeckoTerminal, then DexPaprika, then Dexscreener — first valid result wins per
pair. Each source runs strict identity validation (Robinhood Chain, expected
pool address, expected base token) and retries 429/5xx and network errors with
exponential backoff honoring the Retry-After header. As of 2026-09-21, all
three free REST sources intermittently return HTTP 429 for Cloudflare Workers
shared egress; the durable fallback under evaluation is direct on-chain price
reads via the public RPC.

### Protocol

The Protocol view combines public FUEL contract reads, burn-controller totals,
MintVault state, the daily activity report, maturity schedules, fee-flow context,
a view-only fee quote, a Blockscout first-page top-holder board, and calculated
risk indicators.

### Positions

The Positions view accepts a public EVM address and can read:

- FUEL token balance;
- direct FUEL mint state;
- direct FUEL stake state;
- paginated BatchMinter proxy slots and their FUEL mint state;
- a FUEL maturity calendar and agenda with due / late mint badges (penalty
  schedule only — no invented claim amounts);
- a view-only mint/claim fee quote panel (contract getters; no transaction);
- browser-local saved wallet addresses, up to 50; and
- paginated MORE stake inventory on Robinhood Chain.

FUEL batch and MORE stake pages load up to 25 records at a time. Reads use pinned
blocks where implemented so pagination does not silently mix changing snapshots.
An unavailable read is distinct from a confirmed empty result.

### Planner

The Planner reads current fee getters from deployed contracts and compares direct
and batch FUEL mint and claim fees. It includes batch sizes 1, 10, 25, 50, and the
user-entered size. It also exposes the raw current APY parameter, the maximum mint
term, and hypothetical calendar dates.

The planner does **not** calculate profitability, mint rewards, staking yield,
penalties, gas limits, future token prices, or total transaction cost. A displayed
contract fee is not a guarantee that a future transaction will succeed.

### Contracts

The Contracts view is a registry for the addresses used by the application. It
reports Blockscout reachability, source-verification metadata, proxy type, and the
first reported implementation address where available. Explorer verification is
not presented as a security audit.

## 4. Contract and market registry

These identities are foundational and must remain distinct.

| Role | Address |
| --- | --- |
| FUEL token | `0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3` |
| MORE token | `0xc0F1A40512114b25cc1F30b5DF0bb48691405555` |
| BatchMinter | `0xEaB771dB3883dC05DbEA1915F7e81910869bbc18` |
| FeeDistributor | `0x2f69ff61802d9738e562E438d1F6326389D95861` |
| MintVault / Pump Fund | `0x492d111487f097759340dc119DE5887d58c38bB0` |
| FUEL Buy & Burn controller | `0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2` |
| MORE Buy & Burn controller | `0x86f11A15E1793e7ce1F4264830d1973e80339A51` |
| MORE staking contract | `0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31` |
| FUEL/WETH pool | `0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69` |
| MORE/WETH pool identifier | `0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef` |
| Robinhood WETH (chain wrap; not a protocol role) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

Critical identity rule: `0xc0F1...5555` is the MORE token. `0x86f1...9A51`
is the MORE Buy & Burn controller and must never be relabeled as the token.

The source of truth used by the frontend is `src/lib/contracts.ts`. The MORE
staking address currently lives in `src/lib/more.ts`. Robinhood WETH is exported
as `ROBINHOOD_WETH` for identity documentation only and is not part of protocol
reads. Any address change requires identity verification, tests, and an update to
this document.

An independent 2026-09-19 cross-check against AxelCalloway/fuel-protocol-backup
and Willis5555/FUEL is recorded in `docs/provenance/REFERENCE_CROSSCHECK.md`.
Those repos are inspiration/secondary sources, not a substitute for Sourcify.

## 5. Data sources and claim boundaries

| Source | Used for | Important limitation |
| --- | --- | --- |
| Robinhood Chain RPC | Contract reads, balances, positions, fees, logs, blocks | Public node responses can fail or lag; some dashboard reads span multiple blocks |
| Dexscreener API | Pair price, liquidity, volume, transactions, price changes | Third-party mirror of on-chain pool state; not an executable swap quote |
| Blockscout API | Contract metadata, holder summaries, token transfers | Explorer indexing can lag; verification is not an audit |
| Local collector | FUEL daily activity and maturity reconstruction | First full-history scan may take several minutes |
| Browser local storage | Session market history and saved wallet watchlist | Device-local, not synchronized or a durable server index |

The dashboard reports source availability separately. Missing values are shown as
unknown rather than converted to zero. A successful response means the source was
available; it does not mean the value was independently audited or instantaneous.

Recent activity is based on token transfers. A transfer involving a pool is
labeled as a pool transfer, not asserted to be a verified swap. Mint and burn
labels use zero/dead-address transfer semantics and are not substitutes for a
complete protocol event interpretation.

The displayed 45/25/30 fee split is **source-verified** against
`FeeDistributor.sol` (Sourcify exact match on Robinhood Chain). See
`docs/provenance/CONTRACT_PROVENANCE.md`. Explorer verification is still not a
security audit.

## 6. FUEL activity and maturity methodology

The local collector in `server/` reads FUEL events from contract genesis through
a confirmed snapshot. It currently excludes the latest 64 blocks.

- `RankClaimed` is counted as a mint start.
- `MintClaimed` is counted as a reward claim.
- Daily wallet counts use unique transaction senders for each action.
- Claimed FUEL is the sum of decoded reward amounts using 18 decimals.
- Days are UTC days.

The counts describe lifecycle actions, not purchases, sales, or unique people.
Relayers can represent multiple users and one person can control multiple wallets.
Mint starts do not mean that tokens entered circulation that day.

For maturity tracking, the collector replays the event history and closes a mint
lifecycle when its claim event appears. Before publishing a maturity schedule, it
checks the reconstructed active count against `activeMinters` and samples active
records against `userMints`. If those checks fail, the schedule is withheld.

Reports are written atomically to `.radar-data/fuel-activity.json`. The collector
also persists `.radar-data/fuel-index.json` with decoded event records, per-block
hashes, and the confirmed tip so later refreshes can resume from the tip, rewind
to a common ancestor after a reorg, or rebuild from genesis if the checkpoint is
unusable. The collector keeps completed data usable if a later refresh fails, and
the UI exposes status, coverage time, and progress rather than presenting a
partial scan as complete.

## 7. Architecture

```text
Browser (React + TypeScript + Vite)
  |-- Dexscreener REST API
  |-- Blockscout REST API
  |-- same-origin /rpc → Robinhood Chain RPC via viem
  |-- localStorage: watchlist and session market history
  `-- GET /api/fuel-activity
          |
          `-- Node HTTP collector on 127.0.0.1:4174
                |-- Robinhood Chain logs, blocks, transactions, contract checks
                `-- .radar-data/fuel-activity.json
```

The Vite development server runs on `127.0.0.1:4173` and proxies `/api` to the
collector on `127.0.0.1:4174`. `npm run dev` launches both processes. The current
backend is local-only and binds to loopback.

The frontend refreshes its main data snapshot every 30 seconds. After two minutes,
an otherwise live snapshot is marked stale. The collector schedules a successful
full refresh every ten minutes and retries failures after 30 seconds.

## 8. Repository map

```text
D:\fuelmore-radar
|-- AGENTS.md                  Canonical instructions for AI agents
|-- AGENT.md                   Compatibility pointer to AGENTS.md
|-- README.md                  Quick start and implementation notes
|-- docs/
|   |-- PROJECT_OVERVIEW.md    This shareable project document
|   |-- product-context.md     Source history, identity evidence, and decisions
|   `-- superpowers/           Historical specs and implementation plans
|-- scripts/dev.mjs            Starts the frontend and collector together
|-- server/
|   |-- index.mjs              Local activity API, cache, and refresh loop
|   |-- activity.mjs           FUEL event collection and aggregation
|   |-- checkpoint.mjs         Incremental index parse, reorg rewind, merge
|   `-- maturity.mjs           Maturity reconstruction
|-- src/
|   |-- components/            Dashboard panels and workflows
|   |-- lib/                   Data adapters, validation, types, and utilities
|   |-- App.tsx                Navigation and view composition
|   |-- useRadarData.ts        Refresh and stale-state orchestration
|   `-- styles.css             Responsive visual system
|-- public/                    Static assets
`-- .radar-data/               Generated local collector cache; not source code
```

`dist/`, `node_modules/`, browser QA profiles, screenshots, generated TypeScript
artifacts, and `.radar-data/` are runtime or test artifacts. They are not the
canonical implementation.

## 9. Local operation

Requirements:

- Node.js 20 or compatible;
- npm; and
- internet access to the configured public APIs and RPC endpoint.

Install and run:

```powershell
Set-Location 'D:\fuelmore-radar'
npm install
npm run dev
```

Open `http://localhost:4173`. Keep the terminal running. The first FUEL history
scan can take several minutes; progress appears in the application.

Production-build preview:

```powershell
npm run build
npm run server
```

In another terminal:

```powershell
Set-Location 'D:\fuelmore-radar'
npm run preview
```

A public Cloudflare Workers deployment serves the SPA, `/rpc`, and
`/api/fuel-activity`. Activity stays fresh via:

1. The Worker chooses the newest valid publisher snapshot from KV and assets.
   Its 10-minute cron only copies complete publisher data to KV; proxy-counting
   legacy edge reports are rejected, and timestamps/maturity are never advanced
   independently. Failed KV reads fall back to assets.
2. GitHub Actions `Refresh FUEL activity` every 15 minutes, which runs
   `npm run publish:activity`, commits `public/fuel-activity.json`, and triggers
   Workers Builds so ASSETS remains a durable publisher snapshot. Checkpoints use
   unique run-specific cache keys. Schedule/build delays remain visible as stale
   data, which the frontend continues to display with its coverage warning.

Running `npm run build` alone does not deploy anything.

## 10. Validation

Run all required checks after meaningful changes:

```powershell
npm test
npm run lint
npm run build
```

The automated suite covers formatting, source states, local history, watchlists,
wallet reads, MORE inventory, planner validation and pinned quotes, FUEL daily
aggregation, log-range splitting, maturity reconstruction, and related UI states.

For UI changes, also check:

- clean desktop load and all six navigation views;
- a 390-pixel mobile viewport with no horizontal document overflow;
- source-health and stale/error states;
- public wallet lookup, pagination, calendar filtering, and watchlist behavior;
- planner quote invalidation after input changes; and
- the browser console for runtime errors.

Do not use a real transaction or private key as a test. The current application
has no transaction workflow.

## 11. Security and privacy boundaries

- Treat all entered addresses as public blockchain identifiers.
- Saved wallets remain in the browser's local storage; do not transmit or publish
  them beyond the public reads needed to service the lookup.
- Never request, store, log, or expose seed phrases or private keys.
- Never add write-contract calls under the appearance of a read-only feature.
- Never describe explorer verification as an audit.
- Never convert an unavailable value to `0`, `false`, or an empty position.
- Validate chain ID, contract identity, pinned block/hash assumptions, decimals,
  and ownership before displaying wallet-specific records.
- Treat all profitability, reward, penalty, and future-price outputs as unsupported
  until the formulas and deployed implementations are independently verified.

## 12. Known limitations

- Local development uses Vite plus the loopback collector. A Cloudflare Worker
  can serve the production SPA, `/rpc`, and `/api/fuel-activity`. Do not deploy
  without explicit approval.
- The FUEL event collector persists a durable checkpoint in
  `.radar-data/fuel-index.json` and resumes incrementally after the first full
  scan. Reorg recovery truncates to the highest common block hash and rescans
  forward; a total hash mismatch still forces a full rebuild. This is a local
  JSON checkpoint, not a hosted database with multi-replica recovery.
- Market history is browser-local and session-oriented.
- There are no background push notifications or calendar exports.
- Wallet connection and protocol transactions are not implemented.
- Native swaps and executable quotes are not implemented.
- Reward, penalty, profitability, and total-cost calculations are not implemented.
- MORE coverage is limited to the configured Robinhood token and staking contract.
- Contract source and ABI provenance is tracked in
  `docs/provenance/CONTRACT_PROVENANCE.md` with Sourcify match status. MORE token
  implementation source remains unmatched. This is not a security audit.
- The main frontend bundle currently produces a non-blocking size warning.

## 13. Roadmap

The next milestones should remain gated by verification and explicit user approval:

1. **Harden the data layer.** Sourcify-backed contract provenance is documented
   under `docs/provenance/`. Local incremental FUEL checkpoints and Cloudflare
   activity refresh (KV cron + GitHub Actions publisher) are in place. Remaining
   work: MORE token implementation verification and optional CI bytecode re-checks.
2. **Complete planning.** Mint/claim fee, late-penalty, and gross-reward formulas
   are now source-verified. Wire tested calculators with assumptions and
   observation blocks beside every output.
3. **Add alerts and export.** Start with user-triggered calendar export; persistent
   notifications require explicit opt-in and an operating scheduler.
4. **Add wallet execution.** Re-verify current contract interfaces, simulate every
   action, expose exact call/fees/allowances, and leave signing in the user's wallet.
5. **Consider native trading.** Only after router and pool support, slippage,
   deadline, approval, quote-expiry, and receipt behavior are fully tested.
6. **Productionize.** Add environment configuration, a hosted API, rate limiting,
   observability, deployment documentation, and a security review.

Future wallet execution is a product direction, not authorization to submit a
transaction. Any implementation must preserve a human confirmation boundary.

## 14. Definition of done for future changes

A change is complete only when:

- its claim and data provenance are accurate;
- unavailable, empty, partial, delayed, and stale states remain distinguishable;
- token, pool, controller, and staking identities remain correct;
- relevant tests are added or updated;
- `npm test`, `npm run lint`, and `npm run build` pass;
- responsive behavior is checked when the UI changes;
- the read-only boundary is preserved unless the user explicitly changes scope;
- `README.md`, this document, and `AGENTS.md` remain consistent; and
- no generated cache, browser profile, credential, or private data is treated as
  source code or included in a handoff.


## Managed RPC migration in development

Worker and Node collector accept backend-only `RPC_URL`; browser reads remain
same-origin. Provider errors are sanitized before public responses or collector
logs. `npm run check:rpc` checks network and historical-read capabilities before
activation. The public RPC remains a legacy default while provider setup is
pending. This does not yet implement independent collection, secondary-provider
failover, public/private edition separation or production quotas. See the approved
2026-09-19 public/private spec and managed-RPC implementation plan.

### RPC gateway limits under development

The implementation branch limits request bodies to 64 KiB while streaming,
JSON-RPC batches to 100 reads, explicit log ranges to 2,000 blocks and fee history
to 100 blocks. A Worker isolate permits 12 simultaneous upstream operations and
600 read units per client IP per minute. Identical concurrent cacheable reads
share an upstream operation; response IDs remain caller-specific. HTTP 429
retries honor Retry-After and jitter within a 12-second total upstream deadline.
These in-memory limits are per isolate, not global provider-quota enforcement.
A distributed Cloudflare rate limit and live provider capability testing remain
release requirements. Transport failures remain explicit errors; contract
reverts are not retried.

Cloudflare's native rate-limit binding is a candidate for the next gateway
layer, but it uses per-location counters and is not an exact global billing cap.
Do not describe it as account-wide enforcement. Reference:
https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

### Clean public source export

`npm run export:public` creates a new ignored `public-export/candidate-*`
directory; it never copies Git history or deployment credentials. It excludes
personal components and the owner module, uses the public entry as its only
entry point, provides a fresh deployment template and public README, retains
contract-source SPDX notices, and collects dependency licenses. A SHA-256
manifest identifies every exported source file for later versioned core updates.
The export is a candidate, not a published repository or deployed site. Review
and runtime verification are still required before publication. The original
personal repository remains intact.

Public-mode history and saved-wallet storage use a separate namespace. Personal
storage keys remain compatible with the existing edition.

Export verification checkpoint (2026-09-19): the generated candidate's 124-file
manifest matched its files, excluded the personal modules and Git metadata,
and used public mode for local development. An independent `npm ci` succeeded
with zero reported npm audit vulnerabilities. This package-level check does not
establish live endpoint correctness or production access control.

Managed RPC activation checkpoint (2026-09-19): the existing production Worker
now has an encrypted `RPC_URL` secret saved through Cloudflare after explicit
user confirmation. The deployed code has not yet been upgraded to consume it;
no live managed endpoint capability claim is made. The GitHub Actions `RPC_URL` repository secret is also saved.
Live provider validation remains pending; a manual workflow run on an
implementation branch runs the read-only probe without publishing snapshots. Review found and fixed response correlation before
RPC deduplication/remapping: mismatched single and batch IDs are rejected before
caching. 135 tests, lint and both frontend builds passed for that fix.

Private Access checkpoint (2026-09-19): Cloudflare Worker Access is configured
for all traffic, including production and previews, with a single exact-email
owner policy and a 24-hour session. Unauthenticated requests to the root, asset
path, API path, POST RPC path and a deployed preview URL each returned HTTP 302
to the configured Cloudflare Access login host. Owner sign-in remains to be
verified. The policy does not grant collector access through the protected
website; independent publishing must use a separate authenticated storage path.

Live managed RPC evidence (2026-09-19 21:45 UTC): GitHub Actions run
https://github.com/asjames18/fuelmore-radar/actions/runs/35471352819
passed the read-only capability probe using the encrypted repository secret.
It verified chain ID 4663, recent block 67414916, historical block 63139884,
contract state at both blocks, a single-block historical log request and
unchanged block hashes. This does not establish full archive completeness,
provider quota, larger log ranges or batch limits. The publish job was skipped.

Owner login check found that only the Cloudflare identity provider is currently
configured; the owner policy uses a different email. Email-code authentication
must be enabled and owner sign-in verified before private access is considered
fully usable. Access denial remains effective in the meantime.

Workload probe run 35471658876 (2026-09-19 21:51 UTC) succeeded for six
batched contract reads (41 ms) and a 10-block log range (53 ms), but rejected
2,000- and 50,000-block log samples. These are single samples, not latency
guarantees. The observed range restriction matches Alchemy's documented
Robinhood free-tier 10-block limit:
https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-get-logs
The current collector's 50,000-block adaptive subdivision would create excessive
requests for this endpoint, especially on a full backfill. Production collector
activation requires explicit small-range scheduling and recoverable checkpoints,
or a separately authorized provider-plan change. No paid plan was enabled.
All 137 tests, lint and both edition builds passed before pushing commit 9236241.

Collector recovery implementation (2026-09-19): `RPC_LOG_RANGE` accepts 1–50,000
blocks. Configured managed endpoints default to 10; the legacy public endpoint
retains 50,000. Four requests run concurrently, with at most 100 small ranges
per checkpoint group. Only contiguous completed groups advance the persisted
index after event decoding, pinned-tip hash and chain checks. Interrupted runs
retain the last completed group, while reports are published only after the
full requested snapshot completes. A 50-minute scan budget allows the 90-minute
Actions job to save its checkpoint even when a backfill needs another run.
GitHub cache restore/save steps are separate, with save attempted on failure.
A manual branch validation job exercises collection and saves a separate
validation cache without committing data or publishing a production report.
Live recovery validation remains pending.

Recovery review caught and fixed deadline enforcement inside checkpoint groups.
The total run signal now aborts in-flight reads and is checked during decoding
and before checkpoint/report output. Transport retries may add a few seconds
after abort; the Actions timeout retains a substantial cache-save margin.
Independent review found no remaining concrete P1/P2 issue in this recovery
change; live collection is still required to validate operational performance.

Independent publication implementation (not activated): the scheduled Node job
now validates a completed report and directly writes `fuel-activity-report-v1`
to Cloudflare KV with backend-only account/namespace configuration and a scoped
API token. Reports include the pinned `throughHash`. Invalid, stale and
out-of-order snapshots cannot replace stored data. The workflow no longer
commits snapshots or triggers builds; Worker cron/HTTP storage writers are
removed so a single scheduled publisher owns the key. Readers prefer newer
observation times at equal coverage, then KV over the asset fallback.
Storage credentials and live publication remain pending.

Live collector run 35472128765 failed after advancing from block 67394284 to
67407284. The validation cache was successfully saved. This proves partial
progress persisted, not successful end-to-end collection. Credential-safe
numeric/status diagnostics have been added for the next resumed run.

Storage implementation verification: 150 tests, lint and both edition builds
passed. Independent review found an equal-block asset preference bug; a new
regression now confirms newer KV observations win. Cloudflare's API accepts
Workers KV Storage Write for both value read and replacement. KV propagation
can take up to 60 seconds across locations; successful publication must not be
described as instant global visibility. References:
https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/get/
https://developers.cloudflare.com/kv/api/write-key-value-pairs/

Public QA checkpoint (2026-09-19): all seven navigation routes loaded at
1280px desktop and 390px mobile widths with no horizontal overflow or recorded
browser errors/warnings. The cockpit started blank, rejected invalid addresses,
and completed a zero-address read with explicit block/time and confirmed empty
inventory. Cancellation worked but used an RPC-failure message; the component
now distinguishes cancellation and its five-minute timeout, with a regression
test. All 151 tests, lint and both builds pass. This does not replace remaining
large-wallet completion, stale/failure simulation and deployed-edition checks.
The existing personal GitHub repository was verified private through its API.

Live recovery verification (2026-09-19): GitHub Actions run 35472624791
completed successfully after restoring the validation checkpoint through block
67407284. It produced a completed report through block 67430714 and saved the
updated validation cache. This verifies resumed end-to-end collection using
the managed RPC. The report was written on the CI runner only: the validation
run did not publish to production KV, commit data, or activate production code.
Evidence: https://github.com/asjames18/fuelmore-radar/actions/runs/35472624791

RPC operating-budget check (2026-09-19): sampled Robinhood blocks 67403934
(21:27:19 UTC) and 67439934 (22:27:42 UTC) span 36,000 blocks in 3,623 seconds.
At that observed cadence, a 10-block log range requires about 2,575,546
requests per 30 days. The current method-cost table and Robinhood endpoint
page list 60 CU per eth_getLogs: approximately 154.5 million CU for scanning
alone, before state reads, retries or backfill. This is an estimate from one
hour of observed blocks, not an account invoice. Older support examples use
75 CU; the current method table takes precedence. Alchemy's free allowance is
30 million CU/month, so the existing free plan is not a sustainable production
collector configuration at the measured cadence. Slower scheduling does not
remove the need to scan every block. Paid-tier Robinhood log ranges are
documented as unlimited (response-size limits still apply); live larger-range
validation must precede changing the repository RPC_LOG_RANGE variable. It
defaults to 10 until explicitly configured. No paid plan has been enabled.
Sources:
https://www.alchemy.com/pricing
https://www.alchemy.com/docs/reference/compute-unit-costs
https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-get-logs

Clean-checkout RPC validation no longer depends on an existing activity report.
It uses the previously live-verified historical block 63139884, allowing public
users to run the provider capability check before their first collection.

Public source release (2026-09-19): clean root commit 82fe80d, tag v0.1.0,
130 tracked files including the manifest; no private Git history was copied.
Candidate bgmJOm passed npm ci, 142 tests (70 frontend + 72 server), lint and
build. All 129 manifest file hashes were checked; manifest SHA256
5d1ac15fef4468a175e17f9fc598ad16a0f26b839f697aa15949e2319ddc6dda.
Independent review found a preview-directory mismatch, now fixed and verified
with HTML and built assets returning HTTP 200. Review found no remaining
blocking/important issues in source isolation, credentials or licensing notices.
This establishes the source release only: public hosting, provider operating
capacity and production publication remain
outstanding. Personal tests (152), lint and both builds passed for the RPC
clean-checkout fix.

Public GitHub verification: anonymous API reads returned the public repository,
its single root commit, and v0.1.0 pointing to
82fe80d731c75211136df789aa76bb14e6fb2d7a. GitHub Actions runs
35473767196 (main) and 35473767433 (tag) both completed successfully. The existing
personal repository was separately verified private. Public source publication
does not imply a public hosted site or completion of the edition rollout.

Shared-core consumption verification (2026-09-19): personal source is now
pinned to the published v0.1.0 commit via public-core.lock.json. The sync command
verified all 111 managed source/provenance files match that release and applied
the initial lock without changing personal entry points or settings. Future
updates default to preview, require an explicit full commit SHA and verified
manifest, and refuse local edits or symlinked paths. Six real-Git fixture tests
cover updates, removals, protected entry points, mismatched pins, incomplete
manifests and conflicts. Independent review found no P1/P2 issues. Full checks:
158 tests, lint, personal/public builds and isolation check passed. Regenerating
the public export produces the identical published 129-file manifest; private
updater scripts and the lock are not exported.

Additional UI verification (2026-09-19): public cockpit completed a live wallet
with 100 active batch slots at block 67449671, including reward amounts. A
separate direct RPC read at that block confirmed 100 proxy slots, zero liquid
FUEL and sample slot 0 rank 10406, seven-day term, maturity
2026-09-21T22:53:53Z and gross reward 322507 whole FUEL, matching the displayed
row. Block hash stayed 0x78af125fe0766f7a799a0a5ace0381904de69f44419fdce9d653164d9ce87f17.
This is a representative sample, not a complete independent reward audit.
The live browser recorded no warnings/errors. A separate localhost-only outage
proxy returned RPC 503 while supplying a retained activity report: the UI showed
explicit delayed coverage and the original block/time, and wallet reads showed
an error with retry enabled instead of confirmed-empty inventory. Error and
retained-report layouts had no overflow at 390px. The simulation tab/server were
closed after verification; no production responses were modified.

Local workspace recovery (2026-09-19): the external SSD unmounted while saving
this change, making the original worktree's Git metadata unavailable. The seven
edited files remained intact on the Mac. A fresh clone of the implementation
branch at da76bb2 was created at
`/Users/asjames18/.codex/worktrees/radar-recovered/fuelmore-radar`, and each
recovered file was hash-compared to its original. The disconnected worktree and
its metadata pointer were left unchanged. Continue work from the recovered
clone; reconnecting the SSD is not required to preserve or push these edits.

## Release preparation — 2026-09-20 UTC

Public v0.1.1 adds a required Cloudflare rate-limit binding before RPC cache or
upstream access. It charges each batch item, returns 429 when exhausted, and
fails closed with 503 if protection is unavailable. Counters are approximate
and per Cloudflare location, not an account-wide billing quota. The private
edition imports its three changed shared files through the pinned core updater.
The two deployment templates use separate limiter namespaces, which still need
account collision checks and deployed verification before activation.

GitHub confirms CLOUDFLARE_API_TOKEN exists; permissions and publication have
not been verified. Cloudflare dashboard automation is blocked by an unavailable
admin-policy security check. No workaround or new deployment was performed.
Owner email-code login and RPC capacity remain release gates.

### Validation Cloud collector validation

The owner-provided VALIDATION_RPC_URL passed historical RPC, six-call batch,
2,000-block log, and full resumed collector checks in GitHub run 35482935956.
The resulting CI report covers through block 67567943. The 50,000-block sample
failed; use 2,000 for the tested candidate. Production still uses its previous
configuration; no Cloudflare KV publication or deployment occurred. Details:
`docs/audits/2026-09-20-free-rpc.md`.

### Collector activation prepared

The release branch now configures the production collector to use the verified
VALIDATION_RPC_URL secret and 2,000-block log ranges. A missing secret stops
collection instead of falling back to the shared public RPC. YAML parsing,
shell syntax, production branch guard, provider/range assertions, and an
executable missing-secret failure check passed; independent review found no
P1/P2 issues. This workflow-only update does not change the Worker RPC secret.

The branch is not merged or deployed. Before activation, verify the Cloudflare
Worker's RPC_URL secret, ACTIVITY binding, rate-limit binding namespace, owner-only
Access policy and build configuration. Verify a successful KV publication and
live protocol reads after activation. Dashboard automation remains denied by
an unavailable admin-policy check; no alternate access path was used.

## Speculation v2 — price and liquidity scenarios — 2026-09-21 UTC

The Speculation view now covers four scenario families, all computed from live
observable numbers and all labeled as scenarios, not predictions or advice:

- Supply: potential claims from scheduled maturities (renamed from "scheduled
  unlocks" — maturing is not claiming, reward sizes are estimated from the
  trailing average claim size) plus the trailing-pace extension.
- Burns: observed burns plus the mint-fee pace (25% / 30% verified split);
  a missing native price now renders as a gap (null), never a flat line.
- Price: implied USD price = today's market-cap snapshot ÷ projected supply on
  each path. Pure arithmetic; markets are not modeled.
- Liquidity: today's pool liquidity held flat (the only data-supported
  baseline) plus an illustrative supply-scaled line.

New pure functions `projectPrices`, `projectLiquidity`, and `formatUsd` in
`src/lib/speculation.ts` with tests; burn gaps covered by an updated test.
Validation: 151 frontend + 170 node + 6 core tests passed, lint clean, both
builds green (pre-existing >500 kB bundle warning unchanged).

Preview: `fuelmore-radar-preview` worker (version e1aa6092) serves the v2 public
bundle and proxies read-only `/api/*` to the live public worker; analytics
beacons are swallowed so preview QA never pollutes production counters.
Desktop + 390px QA pending at time of writing.

Deploy note: the earlier `-- --name` separator passed to deploy-wrangler.py made
wrangler ignore the name override and deploy to production instead. The correct
preview invocation passes `--name` directly (no `--` separator), or relies on
the preview wrangler.jsonc whose `name` is already `fuelmore-radar-preview`.

### Preview proxy fix — 2026-09-21 UTC (continued)

The `fuelmore-radar-preview` worker's `/api/*` proxy initially returned 404s.
Diagnosis: the worker WAS running (`run_worker_first: ["/api/*", "/rpc*"]`
works in wrangler 4.136) — but worker subrequests to another `*.workers.dev`
hostname fail with Cloudflare error 1042 ("DNS points to prohibited IP"),
surfacing as a generic 404 page. Fix: proxy to the custom domain
`https://fuelmoreradar.melanatedintech.com` instead of the workers.dev URL.
Debugging note: an early "worker isn't running" conclusion was wrong — caused
by a case-sensitive header grep hiding `X-Preview-Worker` and by `/__ping`
correctly falling through to SPA `index.html` (it isn't in `run_worker_first`).
Current preview version fc526c37 serves bundle `assets/index-DgJ2Ik2M.js`,
proxies `/api/*` + `/rpc*` to live production data, and swallows analytics
beacons with 204.

### Preview RPC POST fix + MORE baseline fix — 2026-09-21 UTC (continued)

1. The preview worker's proxy converted proxied requests to GET (`fetch(url)`)
   and dropped POST bodies — `/rpc` JSON-RPC (used by Cockpit wallet lookups)
   silently broke on preview. Fixed `~/workspace/preview-radar/worker.mjs` to
   forward the request method, headers (minus hop-by-hop), and body. Verified
   live: `POST /rpc {eth_chainId}` → `0x1237` (chain 4663). Redeployed preview
   as version `978d14c6` serving bundle `assets/index-BZmkmKPr.js`.
2. MORE projected supply had a one-day lag: the series subtracted
   `(b.more − points[0].more)`, so day 1 subtracted zero projected burns —
   inconsistent with the FUEL paths, which include their first day's inflows.
   Extracted the composition into a tested pure function `projectSupplies`
   (speculation.ts) that anchors MORE on the *observed* burn baseline, so the
   day-1 point is `currentSupply − 1 day's pace` ("current minus projected
   burns through that date"). `SpeculationView.tsx` now calls it. Added 4
   tests (day-1 subtraction, gap behavior, length handling, unknown pace).

### MORE URL — canonical confirmed 2026-09-21

`https://moretokens.com/` 301-redirects to `https://www.moretokens.com/`,
so the code's `www` form is already canonical (avoids a redirect hop).
No change.

Validation (2026-09-21 UTC, after the fixes): 331 private tests
(155 frontend + 170 node + 6 core), 170 public server tests, lint clean,
both builds green (pre-existing >500 kB bundle warning unchanged).

### Browser QA — Speculation v2 preview (final, 2026-09-21 UTC)

Desktop QA on current preview bundle `assets/index-BZmkmKPr.js`
(preview version `978d14c6`, post-reload, 365d horizon):
- Burns chart RENDERS (FUEL + MORE cumulative lines, live pace stats).
- Liquidity chart RENDERS (flat observed lines; supply-scaled series has no
  distinct path because supply projections are unavailable).
- FUEL supply chart: honest placeholder — zero reward claims in the trailing
  window means no average claim size exists to value maturities, so
  `projectSupply` returns null by design ("waiting on the activity report
  and live protocol reads").
- MORE supply + implied price: placeholders — the production snapshot has no
  `moreTotalSupply` (protocol reads are retaining an older section; the
  collector's protocol read source has not been 'available').
- Horizon switching 90/180/365: PASS on the rendering charts.
- Wording PASS: "Potential claims from scheduled maturities", mint-fee-only
  burns with the 25%/30% FeeDistributor split, price labeled as constant-
  market-cap arithmetic, not a forecast.
- Cockpit zero-address lookup: PASS — the fixed `/rpc` POST proxy works.
- Earlier 13:45 EDT desktop pass (old bundle) hit a transient activity-report
  fetch failure (all charts placeholders); the endpoint returned 200 with a
  report (maturity ready) from ~14:15 EDT onward.
- NOT VERIFIED: 390px mobile layout / horizontal overflow and the browser
  console — the browser automation offers no viewport resize or DevTools
  access. Desktop showed no overflow and no page-visible errors.
- Data health at QA time: header "Saved sync attempt · 4h ago" with a STALE
  badge — GitHub Actions continues to throttle the */15 schedule; runs that
  get created succeed.

### Exact first-unlock countdown — 2026-09-21 EDT (preview only)

- The first FUEL unlock was measured on-chain: earliest maturity timestamp
  `1790028786` = 2026-09-21 22:13:06 UTC (18:13:06 EDT), a 7-day term minted at
  launch on 2026-09-14. Found by rebuilding all 26,977 active positions from
  every RankClaimed/MintClaimed event since genesis, then confirmed with a
  direct `userMints` read at the latest block (exact match). Five other wallets
  mature in the same second.
- `buildMaturity` now publishes `firstMaturityTs` (min over active positions,
  null when none); it flows through the activity report and edge validation
  (older snapshots without the field still pass). `FirstClaimCountdown` counts
  to that exact timestamp and shows it in the sub-line, falling back to the
  00:00 UTC date-bin target for older snapshots.
- Deployed to `fuelmore-radar-preview` (version
  8105a6c5-5293-4ebe-b8de-dfac59404fd0) with bundle index-BZLTgYev.js. The
  preview worker injects `firstMaturityTs: 1790028786` into the proxied
  /api/fuel-activity response (TEMP, clearly marked — remove once the
  production snapshot carries the field natively).
- Preview QA verified: countdown ticking ("0d 01h 28m 14s" at 16:44 EDT), sub-line
  "Earliest unlock · Mon, Sep 21, 22:13:06 UTC · 4,092 positions maturing that day",
  live data loaded, no visible errors. NOT VERIFIED: 390px mobile screenshot
  and browser console (no viewport-resize or DevTools access in the browser
  automation; local Chromium renders nothing in this environment). CSS review:
  the sub-line is a plain wrapping div with a 560px media query shrinking the
  digits, so mobile overflow risk is minimal.
- Tests: +3 frontend (exact timestamp, passed-timestamp "Unlocking now"),
  +2 server (firstMaturityTs value, null when empty). Full suite, lint, build,
  and public isolation check all pass. Production untouched.

## Refresh architecture — 2026-09-24 UTC

The Worker cron moved from `*/15` to `*/5` (288 ticks/day). To stay inside the
Cloudflare free KV limit (1,000 writes/day), per-tick diagnostic writes were
bounded: `watchdog-last-check` and `market-snapshot-last-run` now write only
when their state changes (steady ok/fail streaks add no information). Steady
state is roughly 600 KV writes/day (burns metadata + market-history mirror).

The burns collector no longer leads with raw `eth_getLogs` scans (unsuited to
the ~96 ms Robinhood Chain block time and free-tier 10-block range limits).
Transport order per tick is now:

1. `alchemy_getAssetTransfers` for FUEL burner→zero-address transfers, used
   only to locate candidate transactions; each candidate's receipt is fetched
   and only the original `BuyAndBurn` event is counted (same counting rule as
   before — one drip per event, never invented).
2. Blockscout address-logs for the burner (graceful on challenge/403).
3. The original batched `eth_getLogs` scan as the final fallback.

The watermark advances through the queried range only on a successful
transport; if every transport fails the watermark holds and the run records
`all-transports-failed`. Chain reads use ordered RPC failover
(`RPC_URL` → `RPC_URL_FALLBACKS` → official public RPC) with credential-safe
error logging (host only — keys embedded in URL paths never reach logs).
Failover triggers on network errors, HTTP 429/5xx, timeouts, and
provider-level JSON-RPC throttling errors; method-level JSON-RPC errors still
surface directly so log-range halving keeps working. Chart gap breaks in the market comparison now use a 15-minute
threshold (three 5-minute slots) instead of 45 minutes.
