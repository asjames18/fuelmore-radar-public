# FUEL/MORE Radar — Full Accuracy & Data-Integrity Audit

**Date:** 2026-09-21, ~22:44–22:55 UTC (18:44–18:55 EDT)
**Scope:** Production https://fuelmoreradar.melanatedintech.com/ — data freshness, on-chain truth, markets, messaging, functional spot checks, Speculation deep-dive
**Method:** READ-ONLY. No production changes, no commits, no deploys. Direct reads of production APIs, Robinhood Chain (chain ID 4663) public RPC, public repos (`~/workspace/fuelmore-radar`, `~/workspace/fuelmore-radar-private`), and direct upstream market APIs.
**Context:** Audit ordered by Antonio at ~18:43 EDT, minutes after the first FUEL reward unlock (on-chain 2026-09-21 22:13:06 UTC / 18:13:06 EDT). Post-unlock regime: claims flooding, supply jumping in batch mints, FUEL price crashing ~99.9%.

---

## 1. CONFIRMED ERRORS

### E1. Market-history chart disagrees with the site's own price cards by ~1,300× (SEVERE)
- The Markets price cards (`/api/dashboard`, Path A, Dexscreener, `checkedAt` 22:40Z) correctly show the post-unlock FUEL crash: **≈ $0.0000035, −99.94%**.
- The site's own market-history time series (`/api/market-history`, Path B) shows **$0.004715** — a pre-crash value, because the collector fell through to DexPaprika, whose FUEL `price_time` is 20:55:22Z (~2h stale, only $106 of indexed 24h volume).
- Root cause: `server/price-sources.mjs` validates only pool-id/token-address identity — **no freshness or cross-source sanity check**. History points store no source attribution (`{t, fuelPrice, fuelLiquidity, morePrice, moreLiquidity}` only), so the chart can't be reconciled to an upstream.
- A visitor comparing the card to the chart sees two contradictory FUEL prices.
- Fix: add a staleness gate (reject `price_time` older than ~30 min), store per-point `fuelSource`/`moreSource`, and/or cross-source sanity check (reject >50% deviation from the last accepted point unless corroborated).

### E2. Speculation page: net-supply trajectory shows FUEL hitting zero ~2026-09-27 while supply is in a vertical claim flood (SEVERE)
- `src/components/SpeculationView.tsx:220-223` computes `netPerDay = avgClaimedPerDay − burnPerDay` = 0 − 45.53M; `src/lib/speculation.ts:105-117` (`projectNetSupply`) projects to zero as the page's "primary forward path" (`SpeculationView.tsx:167-171, 269`), rendered with the banner "the net trajectory reaches zero around 2026-09-27".
- Wrong because `claimedPerDay` comes from `trailingStats` (`speculation.ts:38-63`) over 6 *complete* UTC days (Sept 15–20) when claiming was impossible — the first unlock was today 22:13:06 UTC. The model extrapolates the pre-unlock regime across a regime change.
- Fix: when the current (incomplete) day shows claims but the trailing window shows zero, show a "regime change — claim pace unknown, projections paused" state instead of a trajectory.

### E3. Speculation page: "FUEL claimed / day" = 0, labeled "inflow pace"
- `SpeculationView.tsx:240`. Live reality: **528 claims / 178,595,310 FUEL claimed on 2026-09-21** (through 18:30 EDT), verified exact on-chain. The zero comes from `trailingStats` slicing off the incomplete current day (`speculation.ts:40`).
- Fix: include today's partial-day claim rate labeled as partial-day, or refuse to show a pace.

### E4. Speculation page: "FUEL burned / day (est.)" = 45.53M — a fee-routing equivalent presented as a burn pace
- `SpeculationView.tsx:241`; math in `speculation.ts:216-240` (`projectBurns`): 1,540.5 mints/day × 0.00015 ETH mint fee × 25% ÷ 1.269e-9 ETH/FUEL spot. Arithmetic matches the formula, but the formula converts routed ETH at crashed spot price with zero slippage — FUEL fell to $3.52e-6 ($752 mcap), so the same ETH "buys" 100× more FUEL; the model burns *faster* the more the price crashes.
- Observed reality: `totalTokenBurnt` = **322,436 FUEL cumulative ever**, `ethUsedForBurns` = 0.0613 ETH. The displayed "pace" is 141× total historical burns per day. No burner-drip execution is tracked anywhere (zero code hits for drip/buyAndBurn/buyBurn).
- Affects labels at `SpeculationView.tsx:240, 270, 297-298, 381` and the Guide's Speculation paragraph that repeats the formula.
- Fix: base the burn pace on trailing observed Δ`totalTokenBurnt`/Δt; show the fee-routing figure only as an explicitly labeled upper-bound scenario ("if all routed ETH converted at spot, ignoring slippage"). Labels should read "fee-funded FUEL burn equivalent/day" and explain it's fee-routing-based, not executed drip transactions.

### E5. Speculation page: "Burns use mint fees only: claim-fee routing is not yet verified" — factually false
- `SpeculationView.tsx:390`. The source-verified `Token.sol` (`docs/provenance/sources/fuel/Token.sol:42-44`) documents "every fee is forwarded to the FeeDistributor, which splits 45% / 25% / 30%", and `_collectClaimFee()` (lines ~279–295) forwards claim fees to the same distributor. Live read: `claimFee(gasPrice)` = 0.0000375 ETH = exactly 25% of the mint fee.
- With 528+ claims today, ignoring claim fees materially understates fee flow; the true burn pace is structurally higher.
- Fix: include claim pace × claim fee in the burn-pace input; delete the "not yet verified" claim. (Keeping mint-fees-only as a labeled modeling choice is fine; the stated reason is what's wrong.)

### E6. Speculation page: "the verified 25% / 30% fee split" misstates the split
- `SpeculationView.tsx:316`. The FeeDistributor split is **45/25/30** — 45% MintVault, 25% FUEL burner, 30% MORE burner (`FeeDistributor.sol:25-27`, `Token.sol:42-44`). The copy reads as if fees are split only between the two burners.
- Fix: "the verified 25% / 30% burner shares of the 45/25/30 fee split". (Note: `speculation.ts:11` comment already states it correctly.)

### E7. Speculation page: chart note describes a dotted line that isn't drawn
- `SpeculationView.tsx:270`: "The dotted line values every known maturing position at the trailing average claim size…" — but `avgClaimSize` is null (zero claims in the trailing window), so `projectSupply` returns null (`speculation.ts:152`) and the "Potential claims · scheduled maturities" series is all-null. The maturity data itself is ready and exact (372 days, `due` = 1,030, `firstMaturityTs` = 1790028786).
- Fix: value maturities at today's observed average claim size (178.6M ÷ 528 ≈ 338K FUEL) so the overlay renders, or hide the sentence when the series is null.

### E8. Speculation page: stale supply presented as fresh during a high-velocity event
- `SpeculationView.tsx:235` shows "FUEL supply now … as of 12m ago" with a purely time-based staleness flag (`STALE_MS = 3600_000`, line 47). Between the dashboard's protocol read (18:40:35 EDT, 261.09M) and a direct on-chain read (~18:47 EDT, 290.74M), supply moved **+29.65M FUEL (+11%)**. A 12-minute-old number is not "current" during the claim flood.
- Fix: velocity-aware staleness — if today's indexed claims exceed a threshold of synced supply, badge "moving fast — re-reading" or re-read `totalSupply()` client-side.

### E9. MORE supply section dead while the chain read works
- `SpeculationView.tsx:237, 275-288`: `moreTotalSupply` is null in the served dashboard → "MORE supply projection unavailable". But raw `totalSupply()` on the MORE proxy (`0xc0F1A40512114b25cc1F30b5DF0bb48691405555`) reads fine on-chain: **955,193,794.18 MORE**. The failure is in the server-side read (`src/lib/api.ts:221`, via `fuelAbi` on the proxy) or the publish path, not the chain.
- Fix: diagnose the server-side MORE `totalSupply()` read; the chain is fine.

### E10. Guide: maturity schedule described as "MORE vesting" — wrong token and wrong concept
- `src/components/Guide.tsx:37`: "upcoming maturities lists MORE vesting in the next few days". Reality: `server/maturity.mjs` builds the schedule exclusively from FUEL mint events (`event.kind==='mint'`, `maturityTs = timestamp + term*DAY`); no MORE vesting schedule exists anywhere in the pipeline.
- Fix (approved wording, one refinement applied): "Daily pulse tracks minting and claiming wallets today, plus mint starts, reward claims, and FUEL claimed over the last seven days, and scheduled FUEL mint maturities for the next seven days."

### E11. Guide: implies claiming-wallet counts are shown for seven days — they're today-only
- `src/components/Guide.tsx:36-37`: "Daily pulse tracks minting and claiming wallets today and over the last seven days". Reality (`OverviewStats.tsx:114-121`): the 7-day panel shows mint starts, reward claims, FUEL claimed, and scheduled maturities (next 7 days); wallet counts appear only in "Today".
- Fix: same replacement text as E10.

### E12. Guide: countdown described as ticking down / landing in a "claims are live" state — stale post-unlock
- `src/components/Guide.tsx:38-40`: "A countdown … ticks down to the first date any FUEL rewards can unlock" and flips to a "claims are live" state. Reality: post-unlock the panel renders **"First rewards are live"** + "{due} matured positions ready to claim" (`FirstClaimCountdown.tsx:34-38`, live `due` = 1,030); the countdown targets the exact moment (22:13:06 UTC), not "the first date". The code comment in `FirstClaimCountdown.tsx:11` ("claims are live" state) is also stale.
- Fix: "The panel now shows 'First rewards are live' with the count of matured positions ready to claim"; update the code comment.

### E13. "Updates every 15 minutes" overpromises on the publisher path
- `src/App.tsx:179` (also in the production bundle); `Guide.tsx:21-22` ("Numbers refresh about every 15 minutes"). Reality: the public worker's `*/15 * * * *` cron (`wrangler.jsonc:6-8`) runs the market-price snapshot and watchdog on time, but the dashboard/activity/maturity publisher is a scheduled **GitHub Actions** workflow that GitHub throttles — docs (`PROJECT_OVERVIEW.md:86-93`) record ~8–10 runs/day with gaps up to 7h; earlier today the feed was ~3h stale. Live data was ~5 min fresh at audit time, but the claim is a promise, not a description of intent.
- Fix: "Scheduled every 15 minutes" (the existing "Last sync: X ago" timestamp already carries actual freshness). Apply the same "scheduled" language in `Guide.tsx` and `SnapshotFreshness.tsx:10`.

### E14. "Net trajectory at today's pace" / "the slope is today's pace" — the pace is not today's
- `SpeculationView.tsx:249` ("Net trajectory at today's pace"), `:316` ("the slope is today's pace, not tomorrow's outcome"). Reality: `trailingStats` averages over *all complete UTC days* in the collector window (latest incomplete day always excluded) — a full-window trailing average, never literally today's pace.
- Fix: "Net trajectory at the trailing pace" / "current trailing pace". The Guide's "at the current pace" depletion note is borderline; convert for consistency. (Labels that already say "trailing" — "Mint pace · trailing {n}d" — are accurate.)

### E15. "Claiming wallets" label understates who claimed
- `OverviewStats.tsx` / API `claimWallets: 13`. On-chain audit: **528 distinct beneficiary addresses** each claimed exactly once today (topic1 of MintClaimed events; amounts sum exactly to `claimedFuel`). The site's `claimWallets` counts distinct **transaction senders** (13 relayer/batch wallets), by design (`server/activity.mjs`: `claimers.add(event.sender)`). Same pattern for `mintWallets: 13` vs 548 minters.
- This is a labeling issue, not a data bug — but "Claiming wallets · 13" strongly implies 13 users claimed when 528 did.
- Fix: "Claim batches via 13 relayer wallets" or "13 claiming transactions · 528 beneficiaries". The UI's existing note "Wallets are unique transaction senders per day, not verified people" (`OverviewStats.tsx:125-126`) is accurate but insufficient here.

### E16. Contracts subtitle overclaims: "Verified contract addresses"
- `src/App.tsx:62`. The registry itself lists the MORE Token as **Unverified** (minimal proxy, implementation source not matched on Sourcify; `lib/provenance.ts:43-46`). The page body is honest (per-row badges, "verification is not a security audit"), but the subtitle overclaims.
- Fix: "Contract address registry — check the address, not the name."

---

## 2. UNVERIFIED / UNKNOWN

- **U1. The 63.59M totalSupply figure from earlier Sept 21 evening could not be reproduced.** Two independent reads tonight: on-chain `totalSupply()` = 261.09M (18:40 EDT) → 290.74M (18:47 EDT); the site's page-load read showed 261,090,566.39 at 18:40:35 EDT — both sides in whole FUEL, 18-decimal math verified correct, and the site's value is a **direct live contract read** (`src/lib/api.ts` `fetchProtocol` → `protocol.totalSupply` → "FUEL supply" in `OverviewStats.tsx`). Worker B's conclusion: earlier discrepancy was timing — supply jumps in discrete batch-mint steps (one block added +29.65M FUEL). Worker F could not reproduce 63.59M against contract `0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3` at all. The 63.59M figure may have been a misdecoded read, a different contract/method, or a much earlier value — mark it **suspect, not confirmed**. No evidence of a site calculation bug either way.
- **U2. Server-side MORE `totalSupply()` failure root cause** (E9): raw `eth_call` succeeds, so the failure is in the server read/publish path — needs server-side debugging; not determinable from read-only audit.
- **U3. "Send on any chain" donation text** (`App.tsx:213`): cannot verify who controls `0x995ff20448507459baf3b4ae1d2192e2b4a41f7a` or that it receives on *any* chain — by address construction it works only on EVM-compatible chains, not BTC/Solana. Needs Antonio to document (EVM-only) or drop the phrase.
- **U4. The exact on-chain getters behind the dashboard publisher's `fuelBurnt`/`moreBurnt`/`ethUsedFuelBurns` counters** are consistent in production but the publisher code lives in the `fuelmore-radar` repo's dashboard workflow, which was not in the local checkout — recommend a one-time spot-check of that workflow.
- **U5. FeeDistributor's actual pending/distributable ETH** (`MIN_DISTRIBUTE` = 0.01 ETH threshold, drip cadence, `totalDistributed` = 4.11 ETH known): not fetched anywhere, so "ETH available for fee-funded burns" can't be quantified from current feeds — this is a data gap, not a bug.
- **U6. Claim-flood continuation rate after 18:30 EDT** (activity report lags ~20 min behind head at audit time); the +29.6M/7min figure is from two `totalSupply()` reads, not the event indexer.
- **U7. Whether the GitHub Actions publisher's throttle** (~8–10 runs/day, gaps to 7h) will again produce multi-hour staleness overnight — monitored tonight, fresh at audit time, but the throttle is unchanged.

---

## 3. OK / CORRECT

- **Freshness:** `/api/fuel-activity` 7 min old (`generatedAt` 22:37:19.895Z, `status: "ready"`, `error: null`, `source: "kv"`); `/api/dashboard` 4 min old (`partial: false`, all 7 sources "available": Dexscreener, Blockscout, FUEL/MORE holders, transfers, Protocol RPC); `/api/market-history` exactly on 15-min cadence (73 points/20.5h, median gap 900s; one 92-min gap at first-deploy backfill). Zero null prices, zero zero-prices — null-never-zero discipline intact. Earlier 3h-stale condition fully resolved.
- **Maturity schedule:** 372 daily bins live in production (`2026-09-15 → 2027-09-21`); `MATURITY_DAY_COUNT` = 6 + 1 + 365 = 372 (`server/maturity.mjs:8`); the 37→372 publish-validation fix is confirmed live. Today's bin (2026-09-21) `scheduled`: 4092.
- **On-chain cross-checks — exact matches:** claims 528 ✓, `claimedFuel` "178595310" ✓ (exact, 18-dp), mints 548 ✓ (via `RankClaimed` topic `0xe9149e1b5059238baed02fa659dbf4bd932fbcf760a431330df4d934bc942f37`), `firstMaturityTs` = 1790028786 = 2026-09-21 22:13:06 UTC (exact to the second; first claim mined ~117s after, exactly as expected). Comparisons were apples-to-apples over the site's own `throughBlock` 69156936.
- **Countdown:** renders "First rewards are live" (`due` = 1,030 > 0); falls back to date-bin only if `firstMaturityTs` absent; "Unlocking now" state if target passes with `due == 0`. No negative timers. Deployed bundle verified to contain "First rewards are live" — the stale-bundle incident is not recurring. *(Note: one worker initially reported the snapshot "does not carry firstMaturityTs" — it looked at the top level; the field is live at `report.maturity.firstMaturityTs`, confirmed by a second worker and by direct fetch.)*
- **Cockpit wallet lookup:** real claimer address → 200, `fuelBalance`/`userMints` exact vs chain; dead address → 200 with exact on-chain dust balance (not fabricated); bad/missing/lowercase input → 400 with clear message (strict EIP-55 by design, `cockpit-cache.mjs:117-123`); no 500s; unknown wallets return nulls/zeros without inventing positions. Latency 1.7s compute, 0.66s KV-cached.
- **Null-never-zero:** market collector returns null on any failure (`market-collect.mjs:65-106`); a point requires both FUEL and MORE sides (`market-collect.mjs:89`); failed points leave history untouched. Production has 74 points with 0 null/0 zero fields. Speculation page's burn-unavailable fallback is explicitly labeled "claims only — burn pace unavailable" (`SpeculationView.tsx:220-223, 154-155`).
- **Snapshot all-or-nothing:** core event scan is hard all-or-nothing — any scan/decode failure throws (`activity.mjs:105-107, 115, 232, 243`), so nothing partial publishes. The maturity sub-feed fails soft by design (returns `status:'unavailable'`; UI renders nothing unless `status === 'ready'`).
- **Messaging — accurate items:** "Read-only · No wallet required"; "Public data · snapshot, not advice"; "Wallets are unique transaction senders per day, not verified people"; maturity disclaimers ("Scheduled maturity is not a forecast of claims, rewards, or selling"); fee-split "source-verified on the deployed FeeDistributor (Sourcify exact match; not a security audit)" (45/25/30 verified); "45/25/30" Protocol flow; fee-quote derivation; penalty-schedule claims; Uniswap v3/v4 venue claims (matches Dexscreener `dexId=uniswap`); holder-board "Explorer first page only · not a complete on-chain census"; "Stored only in this browser" (watchlist); Planner coming-soon; Cockpit "Estimated claim (net)", "Not an executable Uniswap quote", "Radar does not submit swaps".
- **Data-sources footer** (`App.tsx:91-97`): accurate with one minor caveat — market data uses the ordered failover (Dexscreener → GeckoTerminal → DexPaprika), so "via Dexscreener" is not always the actual source.
- **Speculation framing (substance):** "scenarios, not forecasts" (`:230`), "nothing is a forecast" (`:379`), "not a price call" (`:345`), "What is NOT here: price predictions, profit estimates, or advice" (`:391`) — informational framing is strong and consistent. (It lacks a verbatim "not financial advice" string; `:391` covers it in substance.)
- **MORE market data:** consistent across all paths and sources (within ~1.5%); fdv/liquidity correctly distinguished for both tokens.
- **No invented data anywhere:** no FUEL↔MORE mix-ups, no inverted prices, no unit errors (18-decimal conversions verified correct), no liquidity-vs-FDV confusion.

---

## 4. RECOMMENDED FIXES (audit only — no implementation)

### Priority 1 — before more users see it
1. **Regime-change guard on the Speculation page** (E1–E4): when the trailing window shows zero claims but the current day shows claims, pause the net-supply projection and show "regime change — claim pace unknown, projections paused" instead of a depletion-to-zero narrative. This one guard fixes E2, E3, and the dotted-line null (E7's data side).
2. **Market-history staleness gate** (E1): in `server/price-sources.mjs`, reject points whose upstream `price_time` is older than ~30 min (or require volume-weighted recency); store per-point source attribution (`fuelSource`/`moreSource`); consider rejecting points deviating >50% from the last accepted point unless corroborated. The site currently disagrees with itself about FUEL's price by 1,300×.
3. **Rebase Speculation inputs on observed data** (E4, E5): burn pace from trailing Δ`totalTokenBurnt`/Δt; include claim fees in fee-flow (claim fee verified at 25% of mint fee); keep the fee-routing number only as an explicitly labeled upper-bound scenario. Fix the 45/25/30 wording (E6).

### Priority 2 — messaging corrections
4. **Guide rewrite** (E10–E12): apply the approved text — "Daily pulse tracks minting and claiming wallets today, plus mint starts, reward claims, and FUEL claimed over the last seven days, and scheduled FUEL mint maturities for the next seven days."; "First rewards are live" instead of "claims are live"; update the stale code comment (`FirstClaimCountdown.tsx:11`).
5. **"Scheduled every 15 minutes"** (E13): `App.tsx:179`, `Guide.tsx:21-22`, `SnapshotFreshness.tsx:10`.
6. **"today's pace" → "trailing pace"** (E14): `SpeculationView.tsx:249, 316`; Guide depletion note for consistency.
7. **Claim-wallet label** (E15): "Claim batches via 13 relayer wallets" / "13 claiming transactions · 528 beneficiaries".
8. **Contracts subtitle** (E16): "Contract address registry — check the address, not the name." (MORE Token is Unverified.)
9. **Standardize "source-verified; not a security audit"**: already done everywhere except `MorePositions.tsx:46` ("Source-code audit remains outstanding") — align to the standard phrasing.
10. **Market-data attribution**: footer/DataSources should name the failover chain (Dexscreener → GeckoTerminal → DexPaprika), not Dexscreener alone.
11. **Donation text** (U3): verify or soften "send on any chain" (EVM-only reality).

### Priority 3 — design direction (Antonio's Speculation philosophy, recorded for the fix)
Rebuild the Speculation page against Antonio's five principles: (1) reality-grounded baselines — live `totalSupply()` with a velocity guard ("moving fast" badge during claim floods), trailing observed claim and burn paces, the actual ready maturity schedule valued at today's observed avg claim size (~338K FUEL); (2) optimistically-leaning but honest framing — e.g. "If the claim flood normalizes to the maturity schedule and burns execute at the observed drip pace, net supply does X — but the honest near-term read is: supply is growing fast while 1,030+ positions sit ready to claim."; (3) explicitly factor in the unlock-driven price drop (FUEL ≈ $3.5e-6, $752 mcap, −99.94%), the ETH routable to burners (add distributor pending balance + `totalDistributed`), and the low-liquidity dynamic ($1.16k pool depth vs 0.058 ETH/day burner buys — quantify, don't just disclaim); (4) project from averages of observed burn activity, never static assumptions; (5) keep the existing strong informational framing (`:230`, `:379`, `:391`). Scenario input draft: (a) *Observed today* — partial-day claims; (b) *Schedule-implied* — maturity days × 338K FUEL avg; (c) a band between them; burn scenarios as (a) *observed drip pace* and (b) *fee-routing upper bound* labeled "if all routed ETH converted at spot; ignores slippage and the 0.01 ETH distribution threshold".

### Priority 4 — hygiene
12. **Diagnose the server-side MORE `totalSupply()` read** (E9, U2).
13. **Delete or archive `SpeculationComingSoon.tsx`** — dead code with a now-false claim.
14. **Resolve the 63.59M supply figure** (U1): if it came from a specific earlier read, document it; otherwise treat as a misdecoded value.
15. **Monitor the GitHub publisher throttle** (U7): the `*/15` cadence is intent, not delivery; tonight's freshness is good, but the throttle that caused today's 3h staleness is unchanged.

---

## 5. NOTE ON SCOPE LIMITS
- Live browser checks (what a genuine iPhone renders) were not performed — page text/API reads only.
- Market comparisons are snapshots from 22:46–22:55 UTC; prices, especially post-crash FUEL, move fast.
- The MORE staking-proxy on-chain getters behind `fuelBurnt`/`moreBurnt` (U4) were not reachable from the local checkout.
