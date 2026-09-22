# Price-source research: free alternatives to Dexscreener

**Date:** 2026-09-21
**Question:** Dexscreener's free API now returns HTTP 429 for requests from Cloudflare Workers' shared egress IPs (identical URLs return 200 from a normal server). Find a free replacement for the 15-minute market-snapshot cron that collects USD price + liquidity for exactly two pools on Robinhood Chain (chain id 4663, an Arbitrum L2).

**Canonical pools (verified 2026-09-21):**
- FUEL: pool `0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69` — Uniswap V3, FUEL/WETH, 1% fee
- MORE: pool `0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef` — Uniswap V4 (bytes32 poolId, PoolManager singleton)

Both candidates below were tested **live against the real pools** from this VM on 2026-09-21 ~02:10 UTC. Prices matched Dexscreener within <1%.

---

## 1. GeckoTerminal (CoinGecko) — RECOMMENDED PRIMARY

- **Robinhood coverage:** ✅ Yes. Network slug is `robinhood`. Verified live: both pools return full data.
- **Free tier:** No API key, no signup. ~30 requests/min (1,800/hr). This is per-source, but note it is a *shared* bucket — other Cloudflare Worker users count against the same limit. Our load is ~0.13 req/min, so headroom is enormous.
- **Endpoint (one request per pool):**
  - `GET https://api.geckoterminal.com/api/v2/networks/robinhood/pools/{pool_address}`
  - Header: `Accept: application/json;version=20230302`
- **Fields (verified live):**
  - `data.attributes.base_token_price_usd` — price (FUEL: `0.00549336131006248`)
  - `data.attributes.reserve_in_usd` — liquidity (FUEL: `5938.277`)
  - `data.attributes.price_change_percentage` — `{m5, m15, m30, h1, h6, h24}` (percent)
  - `data.attributes.volume_usd` — per window; `transactions` — buys/sells per window
  - `data.attributes.address`, `data.relationships.base_token.data.id` = `robinhood_<token_address>`, `data.relationships.dex.data.id`
- **Validation mapping:** confirm `attributes.address` equals the canonical pool address (case-insensitive) and `relationships.base_token.data.id` ends with the canonical token address. Rejects mis-indexed pairs the same way the Dexscreener identity check does.
- **Cloudflare egress risk:** no known Cloudflare-IP block; it's the standard public API used by countless Workers. Cannot prove a negative, but nothing suggests the Dexscreener treatment.

## 2. DexPaprika — RECOMMENDED FALLBACK

- **Robinhood coverage:** ✅ Yes. `GET /networks` lists 36 chains including `robinhood`. Verified live on both pools.
- **Free tier:** public REST works with **no key** (verified live just now). Published limits vary by source: community docs say 10,000 req/day no-key; CoinPaprika's own comparison says free key = 100K credits/mo at 30 req/min. One comparison notes free-tier data can lag up to ~60s — irrelevant for 15-min snapshots. No-key access worked fine in testing; a free key is available if limits ever bite.
- **Endpoint (one request per pool):**
  - `GET https://api.dexpaprika.com/networks/robinhood/pools/{pool_address_or_pool_id}`
- **Fields (verified live):**
  - `last_price_usd` (MORE: `3.738380016624219e-05`), `last_price` (native), `liquidity_usd` (MORE: `3874.34`)
  - Per-window stats: `24h` / `6h` / `1h` / `30m` / `15m` / `5m` → `last_price_usd_change`, `volume_usd`, `buy_usd`, `sell_usd`
  - `dex_name`, `id` (pool address/poolId), `tokens[].id`
- **Validation mapping:** confirm `id` equals the canonical pool address/poolId (case-insensitive) and one of `tokens[].id` equals the canonical token address.
- **Caveat:** `24h.last_price_usd_change` scale needs verification before use (observed `-0.09` on FUEL where GeckoTerminal said `-4.249%` — likely a fraction vs percent). Treat change fields as informational until normalized; price + liquidity are the snapshot-critical fields and they match.
- **Cloudflare egress risk:** same honest caveat as GeckoTerminal — no known block, tiny usage.

## Ruled out

| Source | Why out |
|---|---|
| **CoinGecko onchain API** (`/onchain/simple/...`) | Returns **401 without an API key** — even the free Demo plan requires signup + key. Works without key on nothing. Revisit only if Antonio wants a signup-based key. |
| **Birdeye (birdeye.so)** | Requires API key; supported chains are solana/ethereum/bsc/arbitrum/optimism/polygon/avalanche/base/zksync(/sui/monad) — **no Robinhood**. Free Standard tier is 1 rps. Out on both counts. |
| **Moralis** | Robinhood Chain support is **"coming soon" / waitlist** (moralis.com/chains/robinhood, updated ~5 days ago). Also requires API key + signup. Out. |
| **DefiLlama prices API** | Tested `coins.llama.fi/prices/current/robinhood:<token>` — returned `{}`. Does not index Robinhood Chain tokens. (Still useful for ETH/USD if we ever need it.) |
| **DEXTools / Defined.fi / GMGN** | DEXTools pricing unpublished/paid-leaning; Defined.fi GraphQL needs a key; GMGN needs existing auth. No verified Robinhood coverage. Not worth the friction when two verified no-key options exist. |

## 6. Direct on-chain reads via the public Robinhood RPC

**Viable as a last-resort price source, not as the primary.** Assessment:

- **Price:** feasible. FUEL pool is Uniswap V3 → `slot0()` gives `sqrtPriceX96`; price(token0/token1) = (sqrtPriceX96 / 2^96)² adjusted for decimals → FUEL/WETH. Then WETH→USD needs ETH/USD — DefiLlama's free `coingecko:ethereum` price works (no Robinhood indexing needed). ~3 `eth_call`s per pool + 1 HTTP call.
- **Liquidity:** approximate. A V3 pool contract *holds* its token balances, so `balanceOf(pool, token0)` + `balanceOf(pool, token1)` ≈ reserves (plus uncollected fees). USD value via the same prices. Close enough for a dashboard, but it's an approximation, not the indexer's TVL.
- **MORE pool problem:** it's **Uniswap V4** — the "address" is a bytes32 poolId on the singleton PoolManager. Price needs `PoolManager.getSlot0(poolId)`; balances live in the manager's currency accounting (ERC-6909 claims), much harder to read as simple reserves.
- **Cost:** zero marginal cost — uses the existing `RPC_URL`; no new service, immune to API rate limits. RPC rate limits on the public endpoint are the only risk (unknown, but our volume is trivial).
- **Verdict:** keep as a documented **third fallback** (price-only for FUEL via V3 slot0; V4 makes MORE messy). The complexity/robustness tradeoff isn't worth it while two verified no-key indexers exist. If both indexers ever throttle CF egress too, this is the escape hatch.

---

## Antonio's "bounce between them" idea — assessment

**Practical and KV-safe.** Recommended design: **ordered failover, not strict alternation.**

- Try **GeckoTerminal** first for a pair → on failure **DexPaprika** → on failure **Dexscreener** (already coded, may recover).
- Failover only costs extra requests *when the primary fails*, unlike alternation which burns 2× requests every run.
- **KV budget:** 1,000 writes/day free. Cron = 96 runs/day × 1 write (history append) + analytics flushes (~288/day) ≈ **384 writes/day**. Dual-source adds **zero** KV writes — one put per successful run regardless of source. Safe.
- **Subrequest budget:** Workers free plan allows 50 subrequests/invocation. Typical dual-source run = 2 requests (one per pool, one source). Worst case (all sources fail with retries) ≈ 12. Safe.
- **Cron timing:** 15-min window is generous; even full failover with backoff fits in seconds.
- **Optional refinement:** rotate the primary source daily/weekly so no single provider absorbs 100% of our traffic — cheap insurance against per-IP throttling like Dexscreener's.

### Concrete next steps (for the implementer)
1. Add `server/price-sources.mjs` with one adapter per source (`geckoterminal`, `dexpaprika`, `dexscreener`), each exposing: fetch pair → normalize to `{ priceUsd, liquidityUsd, priceChange24h, volume24h }` → strict identity validation (pool address + base token address + chain/network match; reject anything else, never record).
2. Rework `collectMarketSnapshot` to try sources in order **per pair** (GT → DP → Dexscreener), first valid result wins; keep all-or-nothing storage and the existing retry/backoff per source. Log which source succeeded per pair.
3. Keep the Dexscreener token-endpoint fallback only inside the Dexscreener adapter.
4. Tests: per-source fixtures — valid, malformed, identity-mismatch, 429, empty — plus a failover-ordering test.
5. Run `npm test` / `npm run lint` / `npm run build`; verify KV writes stay at 1/cron run; deploy and confirm `market-history-v1` populates.
6. (Later, optional) Document the on-chain slot0 escape hatch; do not build it now.

**Bottom line:** make **GeckoTerminal the primary** and **DexPaprika the fallback**, keep Dexscreener third. Both are free, no-key, verified live on Robinhood Chain with price + liquidity + 24h stats, and the dual-source design costs nothing extra in KV writes.

## 2026-09-21 egress probe findings (Cloudflare Workers, not VM)

A temporary probe worker on the same Cloudflare account fetched the exact
collector URLs with the exact collector headers. Results were consistent
across repeated probes:

- **GeckoTerminal → HTTP 429** (`gt-error-code-429`) on the very first
  request. Cloudflare Workers shared egress IPs are throttled. The earlier
  "~30 req/min free" figure was measured from a non-Cloudflare VM and does
  NOT hold on Workers egress.
- **DexPaprika → HTTP 402** (`payment_required`, `tier: keyless`):
  "Credit limit for the last 30 days reached for unauthenticated use."
  The shared keyless quota is exhausted from Workers egress
  (reported `used: 6019774` against `limit: 30000`). A free DexPaprika API
  key would grant dedicated monthly credits and is the most promising
  zero-cost primary — requires the account owner to register.
- **Dexscreener → HTTP 200** with valid pair data (intermittent 429s
  observed 2026-09-21 ~01:30–02:00 UTC, recovered by ~03:20 UTC).

**Consequence:** source order changed to Dexscreener → GeckoTerminal →
DexPaprika (see `server/price-sources.mjs` header). Never rank sources by
VM-only probes again — always verify from Workers egress before choosing
a primary.
