# FUEL / MORE Radar

Latest chart/cockpit release: v0.1.4. Real Dexscreener USD candles for FUEL and
MORE, optional dual-axis USD/percentage comparison, filled USD liquidity chart,
and no observation-table dropdown. Wallet reads now pace requests and retry
transient gateway failures without changing read-only protection.

Verification (2026-09-21 UTC, Speculation v2 + RPC/MORE fixes): 331 private tests (155 frontend +
170 node + 6 core), 170 public server tests, lint, both builds, and public
isolation passed. Speculation now covers supply, burn, implied-price, and
liquidity scenarios. Production RPC scans completed 288 slots; the browser completed
a separate 150-slot wallet including reward reads. Both candle charts rendered
in the production HTTPS site (local preview embeds stayed blank).


Latest release verification (2026-09-20 UTC): 178 personal tests and 162 public
tests passed, along with lint, both builds, and public isolation checks. Public
v0.1.3 is live with a simple last-sync header and combined price/liquidity charts.
Authenticated publisher run 35486574533 succeeded: all seven sources available,
FUEL holders 110, MORE holders 177, and protocol reads pinned to block 67618018.
The shared snapshot was saved at 2026-09-20T03:27:18.711Z. Holder values survived a
live page reload. Desktop and 390px chart checks passed with no captured console
errors. These are observations at that sync, not guarantees of future availability.
See [project overview](docs/PROJECT_OVERVIEW.md) for current status.

A local Robinhood Chain dashboard for the FUEL and MORE ecosystem.

## Project documentation

- [Full project overview and handoff](docs/PROJECT_OVERVIEW.md)
- [Canonical AI agent instructions](AGENTS.md)
- [Product context and source history](docs/product-context.md)

Saved-sync release verification (2026-09-20 UTC): 178 personal tests and 162 public
tests passed; lint and builds passed. Production publisher run 35485654439 saved
17 protocol values at block 67605078. Live reload/refresh retained the saved data
and original observation times on both editions; desktop and 390px checks passed.
That initial explorer gap was resolved by the authenticated sync described above.

## Saved dashboard sync

Production loads `/api/dashboard` from shared Cloudflare KV. The existing
15-minute publisher collects market, protocol, holder, transfer, and contract
metadata once for both editions. Browsers check the saved copy every minute and
restore their edition-specific local cache immediately after reload. The refresh
button checks storage; it does not trigger upstream collection.

Failed source groups retain their last complete values and original observation
time. Partial protocol reads never mix blocks with an older complete group.
The private timestamp panel identifies retained/delayed data; the public header
shows last sync time and update cadence only. Snapshots older than 30
minutes are marked stale. Mint/claim coverage remains separately timestamped.
Wallet lookups and fee quotes remain direct reads and are never shared in this cache.
Localhost keeps direct refreshes and saves them locally. Browser storage failures
leave the current session usable. GitHub scheduling and upstream availability can
cause delays; no freshness guarantee is implied.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:4173. This starts Vite and the local activity collector on
127.0.0.1:4174. Both processes must stay running for automatic activity updates.
The browser talks to Robinhood RPC through same-origin `/rpc` (Vite proxy locally,
Cloudflare Worker in production) so direct RPC CORS is not required.
A first history scan can span multiple runs on a restricted provider and writes a durable event checkpoint
to `.radar-data/fuel-index.json`. Later refreshes scan only new blocks (with reorg
rewind when tip hashes diverge). Completed reports also survive in
`.radar-data/fuel-activity.json`.

For a production-build preview, run `npm run build`, keep `npm run server` running,
and run `npm run preview`. The Vite preview proxy forwards activity requests to the
collector. A public deployment needs a separately hosted backend and same-origin
API routing; this local implementation does not deploy itself.

## Personal FUEL cockpit

The **Cockpit** nav page is the personal decision desk for wallet
`0x36ccC887e2c98f710F789a1f9551e24c01aDE6F6` (custom wallets supported). It
covers risk profile, mint/buy/sell/wait bias, unlock-day inventory, and
sell-size framing vs pool liquidity. On-chain RPC supplies FUEL amounts
(balances, `getGrossReward`, late penalty); Dexscreener supplies USD price and
pool depth (their mirror of on-chain reserves — still third-party, never an
executable quote). Positions still preloads the pinned wallet.

## Production activity freshness (Cloudflare)

The Worker chooses the newest valid sender-counted publisher report from KV and
`public/fuel-activity.json`. KV errors fall back to deployed assets. Legacy
`edge-incremental` reports are rejected because their proxy-based wallet counts
and reused maturity data do not satisfy the dashboard's definitions.

The production workflow schedules a single Node publisher every 15 minutes.
After collection completes, `publish:storage` validates the report and replaces
one shared KV value using a backend-only Cloudflare API token. There are no data
commits, site rebuilds, Worker cron writes or public refresh mutations in this
new path. Production KV publication and live personal-site coverage were verified on 2026-09-20 UTC.

Configure GitHub repository variables `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_KV_NAMESPACE_ID`, and encrypted secret `CLOUDFLARE_API_TOKEN` with
Workers KV Storage Edit limited to the hosting account. Keep this token out of
Worker/frontend configuration. Both editions may read the same ACTIVITY KV.
Actions checkpoints use unique cache keys and save on collection failure.

```sh
npm run publish:activity
npm run publish:storage
```

## Daily FUEL minting versus claiming

The panel appears in Overview and Protocol and covers the last seven **UTC days**.

- **Mint starts:** FUEL `RankClaimed` events, each representing an opened mint.
- **Reward claims:** FUEL `MintClaimed` events, each representing a claimed reward.
- **Minting / claiming wallets:** unique transaction senders per action per day.
  Batch proxy addresses do not count as separate people. A sender may represent
  several users through relayers/bundlers; one person may own multiple wallets.
- **FUEL claimed:** sum of decoded reward amounts, accumulated in integer token
  units. The table rounds for display; hovering the amount exposes full precision.

The two action counts measure different lifecycle stages. Mint starts do not mean
new circulating tokens that day, and reward claims do not establish token sales.
A claim-and-remint can contribute to both series. Daily unique-wallet counts must
not be summed to infer unique wallets over the entire week.

The collector reads public Robinhood RPC logs, resolves blocks and transaction
senders, and excludes the latest 64 blocks. It splits log ranges when the provider
hits its result limit. It only publishes a fully completed scan and rejects block
hash inconsistencies. After the first full genesis scan it persists an event
checkpoint and resumes incrementally, truncating to a common ancestor when the tip
hash no longer matches. Daily activity covers seven UTC days. Mint lifecycle
history is reconstructed from the checkpointed event set so older active mints
remain in the maturity outlook. Reports from before launch include zero-activity
days based on the token's on-chain genesis value. Today is incomplete and the
exact coverage timestamp/block is displayed.

The event ABI matches the public application at https://app.fuelmoretokens.com/.
This is not a full contract audit. Broader wallet execution, planners, MORE staking
coverage, persistent event indexing and notifications remain future milestones in
`docs/superpowers/specs/2026-09-15-fuel-more-workspace-design.md`.

## Checks

```sh
npm test
npm run lint
npm run build
```

Test discovery excludes browser profiles and macOS resource-fork files on the
external drive. The tests cover formatting, storage failures, daily aggregation,
batch-wallet deduplication, claim precision, UTC boundaries and log-range limits.

## Source accuracy and wallet coverage

The Data sources section reports available, partial, unavailable, and delayed
checks with individual completion times. CONNECTED means sources responded; it
is not a claim that all data is instantaneous or independently audited. RPC
protocol metrics can span several blocks. Missing values remain unknown instead
of being replaced by zero. Old dashboard values are not silently mixed into a
fresh snapshot. The daily collector has its own coverage timestamp and status.

Positions supports direct FUEL balances/mints/stakes and BatchMinter proxy mint
slots. Use Load more to read additional pages of 25 slots at the same chain block.
Coverage is stated explicitly; failed slots are marked unavailable. MORE stakes are available through a separate read in Positions. FUEL position-card maturity dates use the browser's timezone.

Fee splits are labeled source-verified against FeeDistributor (Sourcify exact
match). See `docs/provenance/CONTRACT_PROVENANCE.md`. An independent 2026-09-19
cross-check against AxelCalloway/fuel-protocol-backup and Willis5555/FUEL is in
`docs/provenance/REFERENCE_CROSSCHECK.md`. Those repos are secondary references,
not a substitute for Sourcify. Verification is not a security audit. MORE token
implementation source remains unmatched.

Accuracy regression checks: 21 tests pass, along with lint and build. Live browser
QA loaded all 70 slots for a public batch-minting wallet at one block and checked
source timestamps and fee labels. A clean page load and navigation had no runtime
errors. A development hot-reload hook-order warning during editing was cleared
by a full reload; it did not recur on the clean-load check.


## Maturity tracking and saved wallets

Overview and Protocol now include a 7/30-day maturity outlook alongside actual
mint starts and claims. Future actuals remain unknown. Schedules are derived from
RankClaimed timestamps and terms; MintClaimed closes the lifecycle. The collector
replays genesis-to-snapshot history, checks the active count against activeMinters,
and checks three sampled active maturity timestamps against userMints. If these
checks fail, it withholds the maturity schedule rather than publish an incomplete
one. Passing samples are not a full source-code audit.

Positions includes a UTC month calendar with selectable dates and an agenda.
It uses the loaded direct and batch mint/stake maturity timestamps. Partial pages
and failed reads are explicitly flagged. Upcoming, due (penalty-free window) and
late (verified penalty schedule) badges describe mint date state only; claim
amounts are not invented. Stake cards use date-only due styling and do not apply
the mint penalty curve.

Save an entered wallet to the browser-local watchlist and select it for a new
lookup. The limit is 50 addresses. No wallet connection, background notification
or public publication is involved. Storage failures are reported as temporary
changes. The first full-history scan takes several minutes; successful reports
persist across restarts. Errors retry after 30 seconds. A durable incremental
index remains a future scalability improvement over full-history replay.

Maturity phase verification: all 30 tests, lint and production build passed. Live
scan at block 64032156 matched 23,167 active positions and all three sampled
maturity timestamps. It reported 4,092 scheduled maturities on September 21 and
901 on September 22 (snapshot time September 15, 23:09:18 UTC). Browser QA covered
7/30-day switching, calendar date filtering, watchlist save/reload/select/remove,
and a 390px mobile viewport with no page overflow. The temporary QA watchlist
entry was removed after verification.

## FUEL fee and duration planner

Planner compares live direct and batch mint/claim protocol fee getters, plus the
sum for claim-and-remint. Comparisons include 1, 10, 25, 50 and the entered batch
size. Each refresh checks chain 4663, pins all contract calls to one block, and
rechecks its hash. Gas price is a separate RPC observation supplied to the getters.
Changing batch size clears the quote; failed refreshes remove old fees. Quotes
older than two minutes (by fetch or block timestamp) are visibly marked older.

The maximum mint term is returned in seconds and converted to days, consistent
with the existing protocol panel and the official application's maxTermSec read.
At block 64056469 it was 27,388,800 seconds = 317 days. The seven-day minimum is
explicitly app-reported. Calendar plans use snapshot time plus whole UTC days;
they do not prove transaction eligibility. Stake amount validation preserves up
to 18 decimals and rejects rounding, nonpositive values and uint256 overflow.

Full reward/penalty implementation verification remains blocked: explorer access
returned security challenges; no source was recovered. Therefore no mint reward,
staking yield, penalty, profitability, network gas estimate, or total transaction
cost is displayed. The APY parameter is shown as a raw contract value. MORE reward planning, wallet simulation and execution are still outstanding.

Planner verification: 40 tests, lint and production build passed. Browser QA
confirmed live batch fees, quote invalidation, term bounds, decimal validation,
and a 390px viewport without page overflow. The fresh quote at block 64056469
returned 0.0015 ETH mint fee and 0.000375 ETH claim fee for 10 positions. Existing
activity at block 64048985 matched 23,212 active positions against RPC state.
All seven dashboard source categories responded on the final source check, after
an intermittent partial response. Availability is not a full accuracy audit.

The DOM-test dependency uses jsdom 26, compatible with this machine's Node 20.
Newer jsdom failed to initialize here. The existing main-bundle size warning
remains; it does not prevent the production build.


## MORE stake inventory

Positions now offers Load MORE stakes for the looked-up wallet. It reads the
Robinhood staking contract `0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31`, mapped by
the official MORE app. `getStakerID` provides inventory and `getStakeInfo` provides
records. Amounts use the token's on-chain decimals. Active/ended status follows
the contract flag; start/end/claim timestamps are shown in UTC. It does not compute
rewards or penalties, and excludes other assets supported by the MORE application.

Reads use a separate pinned block from the FUEL snapshot, clearly displayed.
Pages contain up to 25 records and reuse the original block hash. Owner mismatches
and failed records stay unavailable. Duplicate IDs, inventory failures, wrong
networks, or changed block hashes reject the snapshot. A confirmed zero-ID result
is distinguished from a failed lookup. The existing month calendar is now titled
FUEL maturity calendar to make its scope explicit.

Verification: 46 tests, lint and build passed. Adapter tests cover pinned reads,
25-record pagination, exact decimal units, empty vs failed inventory, duplicate
IDs, owner mismatch, wrong chain, and changed snapshots. Contract interface and
address were inspected from the official app; a deployed-source audit is pending.

Live MORE browser QA at block 64106723 loaded all 12 IDs for public staker
0x8599A6cab9617FFb12E6f11aD119caeE7323a2c4. Eleven records were ended and stake
101 was active; inventory matched the direct RPC read. Mobile width was 390px
with no document overflow, and no runtime errors were reported. The test address
was not added to the saved-wallet watchlist.

## Managed RPC setup (backend only)

The Worker reads `RPC_URL` from a Cloudflare secret. The Node publisher/collector
reads `RPC_URL` from its process environment; GitHub collection receives the
repository Actions secret VALIDATION_RPC_URL, mapped to RPC_URL for collection. Never use a `VITE_` variable or paste
provider credentials into source, issues, logs, or chat. Local `.dev.vars` is
ignored for Wrangler; Node requires an exported environment or a supported
`--env-file` invocation. Vite's existing local proxy still uses the public RPC.
Missing configuration retains the legacy public endpoint during migration.

With a managed endpoint securely configured, run `npm run check:rpc` before
activation. It checks chain 4663, recent and historical contract reads, a narrow
historical log request, and block-hash consistency. It does not establish full
archive completeness or contractual capacity. Sampled six-call batches and
10/2,000/50,000-block log ranges are also measured. Without a managed endpoint,
this check fails rather than reporting the public endpoint as migrated.

Managed secrets are saved and live probes passed. After an interrupted run
saved 13,000 blocks of progress, run 35472624791 resumed successfully through
block 67430714. This validation did not publish to production. The measured
continuous scan exceeds the Alchemy free monthly allowance; provider capacity
and authenticated KV publication remain prerequisites for activation.

### Public edition development checkpoint (2026-09-19)

The implementation branch supports `npm run build:public` (output
`dist-public`) and preserves the personal `npm run build` entry. The public
build automatically rejects known personal identifiers and panel labels.
Neither this split nor managed RPC activation is deployed yet.

Current checks: 80 frontend, 72 server and 6 core-updater tests passed; lint and both
edition builds passed.
Public preview checks at `http://localhost:4180/` confirmed empty wallet inputs,
Planner Coming soon, independent MORE chart selection, no console warnings or
errors during those flows. All seven routes loaded without horizontal overflow
at desktop and 390×844 mobile sizes. Invalid/empty wallet and cancellation flows
passed. A 100-slot cockpit read completed, and a sample reward was independently
confirmed at its pinned block. Retained stale activity and RPC-failure states
were exercised in a local outage preview, including 390px layout. Owner login
usability and deployed editions still require release verification.

The in-progress RPC gateway also applies streamed payload and block-range limits,
per-isolate concurrency/client budgets, duplicate-read coalescing, and a bounded
429 retry deadline. The Worker also requires a Cloudflare RPC_RATE_LIMITER binding, charging
each logical batch method against an approximate 600-read/IP/minute allowance
per location. This is not a global billing cap. Provider usage controls and
verification of the deployed binding remain required before public activation. Provider historical,
batch and resumed-collection checks have passed.

Prepare a clean public source candidate with `npm run export:public`. Each run
creates a new ignored `public-export/candidate-*` folder with public docs,
licenses, CI and a deployment template. Do not publish the original repository
or its history as the public edition. The reviewed public source is now published at
https://github.com/asjames18/fuelmore-radar-public (v0.1.1). Its clean checkout
passed 142 tests, lint, build and preview checks. Production configuration and
live public deployment verification remain outstanding.

### Collector RPC range and recovery

Set backend `RPC_URL` and `RPC_LOG_RANGE=10` for the verified Alchemy free endpoint.
Managed endpoints default to 10 blocks per log query. The Node collector reads
four ranges concurrently and saves only contiguous completed groups. A failed
range never advances coverage past the gap. The existing complete report stays
available while a backfill resumes from its saved checkpoint on the next run.
The 50-minute scan budget bounds each run; a full initial history may need more
than one run. Keep `.radar-data/fuel-index.json` across restarts.

### Updating the shared public core

The personal edition vendors neutral source from the public repository. Its
`public-core.lock.json` pins the reviewed tag, exact commit, manifest digest and
111 shared file hashes. Private entry points, owner settings, personal cockpit,
planner, diagnostics, risk components and deployment configuration stay local.

Make future shared-code changes in the public repository first. Clone/fetch
`https://github.com/asjames18/fuelmore-radar-public.git` into a separate directory,
review the release and obtain its full commit SHA independently. From this
personal repository, preview the update before applying it:

```sh
npm run sync:core -- /path/to/public-checkout v0.1.0 82fe80d731c75211136df789aa76bb14e6fb2d7a
npm run sync:core -- /path/to/public-checkout v0.1.0 82fe80d731c75211136df789aa76bb14e6fb2d7a --apply
npm test
npm run lint
npm run build
npm run build:public
```

The public checkout must contain both the current and next release commits.
The command reads committed Git objects; uncommitted source changes are not
imported. A tag pointing to another SHA, incomplete/mismatched manifests,
symlinked targets or local edits to managed files stop the update. Preserve
local work and resolve it deliberately; the updater has no force option.
The first pin requires every existing shared file to match the reviewed release.
Subsequent updates apply shared-file patches and record the new lock. Review and
commit the resulting diff. Package/dependency and deployment configuration
changes require separate review; this command does not install or deploy anything.

### v0.1.1 verification — 2026-09-20 UTC

The pinned public release is 48b4d7395eec476a02456bb5f3d6f0f3116d115d.
Public tests: 70 frontend + 76 server; lint and build passed. Both GitHub
CI runs 35479086972 and 35479087184 succeeded. Private import: 80 frontend +
76 server + 6 updater tests passed; lint, personal build, public build, and
public isolation checks passed. Vite still warns about the main bundle size.
No UI behavior changed; deployed limiter behavior has not been exercised.
Cloudflare activation, storage permission/write verification, and owner login
remain outstanding because dashboard automation cannot verify its admin policy.
