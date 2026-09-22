# FUEL / MORE Radar: product context

Updated 2026-09-19 from user-provided sources, Sourcify provenance, and
read-only comparison with AxelCalloway/fuel-protocol-backup and Willis5555/FUEL.

## User intent

Build something using the FUEL and MORE applications, websites, Robinhood markets,
and seven supplied contract addresses. The user confirmed all three workflows: monitoring dashboard, mint/stake planning,
and wallet-connected execution. The current
implementation is a read-only dashboard; that is existing behavior, not a confirmed
final product requirement.

## Source map

- https://www.moretokens.com/ — staking overview and penalty-funded rewards.
- https://app.moretokens.com/ — live staking application; Ethereum, PulseChain,
  Avalanche, and Robinhood selectors; Buy, Stake, Stats, Arbitrage, Buy & Burn.
- https://fuelmoretokens.com/ — supplied FUEL website; not yet inspected successfully.
- https://app.fuelmoretokens.com/ — Robinhood FUEL application; Mint, Buy & Burn,
  Pump Fund, Stake, Stats. Batch minting and claim/remint controls.
- https://dexscreener.com/robinhood/0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef
  — observed MORE/WETH Uniswap v4 market.
- https://dexscreener.com/robinhood/0xff40c99525ffa6b6cf79ecbe370ef7c887d68f69
  — supplied FUEL market, already configured locally; page verification outstanding.

## Addresses

Roles below are confirmed against the live apps' displayed configuration, not a
completed source-code audit. Explorer pages supplied at https://robin.etherscan.io
could not be retrieved by the web tool in this session.

| Role | Address |
| --- | --- |
| FUEL token | 0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3 |
| MORE Robinhood token | 0xc0F1A40512114b25cc1F30b5DF0bb48691405555 |
| BatchMinter | 0xEaB771dB3883dC05DbEA1915F7e81910869bbc18 |
| FeeDistributor | 0x2f69ff61802d9738e562E438d1F6326389D95861 |
| MintVault / Pump Fund | 0x492d111487f097759340dc119DE5887d58c38bB0 |
| TokenBuyAndBurn | 0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2 |
| MOREBurner | 0x86f11A15E1793e7ce1F4264830d1973e80339A51 |

The FUEL app footer labels MOREBurner as the MORE contract. Its settings drawer
explicitly identifies that address as MOREBURNER. The MORE app footer identifies
0xc0F…5555 as its Robinhood token. Keep these roles distinct.

## Observed behavior and gaps

The FUEL UI describes batches of 1–50 mints, claim deadlines, late penalties,
claim/remint, and a protocol-wide supply/maturity timeline. The MORE UI describes
penalty-funded staking rewards, early/late exits, and multiple supported networks.
These are UI descriptions; verify deployed contract rules before implementing
calculators or execution. Do not assume the two protocols share penalty rules.

Existing Radar provides markets, local session history, protocol reads, contract
metadata, transfers, and direct FUEL wallet mint/stake lookup. It does not yet
establish complete BatchMinter position coverage, MORE stake coverage, persistent
indexed history, maturity alerts, or wallet execution.

Proposed architecture and milestones: docs/superpowers/specs/2026-09-15-fuel-more-workspace-design.md. Design review is pending.

## Approved first feature

User approved the design and prioritized daily FUEL minting versus claiming: unique
wallets, individual mint starts/reward claims, and claimed FUEL. Implemented as a
local collector plus Overview/Protocol panel; verification recorded in the plan.

## Accuracy hardening — 2026-09-15

- Source availability now covers market, contract, holder, transfer and protocol
  requests. Failed reads stay unknown; the dashboard no longer merges old values
  into a fresh snapshot without field-level provenance. Timed-out refreshes retain
  the old snapshot with its old timestamp and stale status.
- Source checks carry completion timestamps and become delayed after two minutes.
  CONNECTED means response availability, not audited or instantaneous data.
- Unknown holder counts, trade counts and combined burn totals render as dashes.
- Wallet lookup reads direct FUEL state plus paginated BatchMinter proxy slots at
  one block. Confirmed empty slots and failed reads have distinct labels. MORE
  staking remains explicitly outside this lookup.
- Live QA: public sender 0x90ce619e7b958742e067b941f7114775dfe4ea6b has 70 proxy
  slots; UI loaded 25, 50, then all 70 at block 64025707. No direct mint was present.
- Fee allocation 45/25/30 is sourced from the public FUEL app's tour text. Explorer
  source retrieval was unavailable; these percentages are explicitly unverified,
  not a verified deployed-contract rule. Independent source verification remains
  outstanding and must precede reliance on these values in execution/calculators.
  **Superseded 2026-09-17:** the split is now source-verified against FeeDistributor
  (Sourcify exact match). See Contract provenance below.

## Contract provenance — 2026-09-17

Sourcify exact matches were retrieved for FUEL Token, BatchMinter, FeeDistributor,
MintVault, both buy-and-burn controllers, and MORE staking. MORE token (EIP-1167
proxy) has **no** Sourcify match. First-party Solidity excerpts live under
`docs/provenance/sources/`; summary in `docs/provenance/CONTRACT_PROVENANCE.md`.

Verified from deployed source (not an audit):

- Mint fee = `soloMintGas * max(gasPrice, minGasPrice)`; claim fee = 25% of mint fee.
- FeeDistributor immutable split 45% vault / 25% FUEL burner / 30% MORE burner.
- Late claim penalty `min(2^(daysLate+3)/7 - 1, 99)` with 7-day window.
- BatchMinter: full fee per proxy slot (no fee amortization).

UI Protocol fee flow labels updated from app-reported/unverified to source-verified.
Planner reward projections remain withheld until calculators are wired and tested.

The official app's Robinhood network mapping identifies MORE staking at
0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31. Its getStakerID/getStakeInfo interface
responded on chain 4663. Implemented a paginated, read-only wallet inventory with
owner validation, block/hash pinning, live token decimals and explicit failures.
The FUEL month calendar remains FUEL-only; MORE record dates appear separately.
This completes basic MORE token stake lookup, not reward calculations or other
assets in the MORE app. Original proposed/pending design text above is historical;
the user has since approved and repeatedly authorized implementation.

## Independent reference cross-check — 2026-09-19

Read-only comparison against AxelCalloway/fuel-protocol-backup (Solidity +
address table) and Willis5555/FUEL (`index.html` ABIs/addresses). Neither
frontend was vendored; both include write UIs that remain out of Radar scope.

Findings (not an audit):

- Checksummed FUEL / BatchMinter / FeeDistributor / MintVault / both burners
  match Axel after restoring EIP-55 on two lowercase markdown addresses.
- Axel `FeeDistributor.sol` and `Fuel.sol` `_penalty` match Radar’s Sourcify
  excerpts (trailing newline only). 45/25/30 and the late-claim curve are
  independently corroborated, not newly discovered.
- Axel’s backup `index.html` names the MORE burner key `MORE`. Willis correctly
  separates MORE token `0xc0F1…5555` from MORE burner `0x86f1…9A51`. Live Radar
  addresses were not changed.
- Robinhood WETH from Axel is documented as chain infrastructure only.
- Willis inspired due/late position styling, a view-only fee-quote panel, and a
  Blockscout first-page top-holder board. Radar does not copy wallet connect,
  `sendTransaction`, or Willis’s mint-event holder scan.

Evidence: `docs/provenance/REFERENCE_CROSSCHECK.md`.


## Cloudflare audit — 2026-09-19 (local repairs pending release)

Public production reads confirmed older proxy-counted KV data overriding newer
sender-counted publisher assets. The Worker now selects the newest validated Node
publisher snapshot, rejects legacy edge-incremental aggregates, and synchronizes
whole reports only. FuelActivity now accepts stale responses rather than hiding
their data. Workflow checkpoint keys are unique per run, and Worker routing/RPC
regressions are included in npm test. See audits/2026-09-19-cloudflare.md for the
observed blocks, files, tests and release limitations. No deployment was authorized
or performed as part of this audit.


## 2026-09-20 authenticated explorer recovery

The user authorized a free Blockscout key for the private scheduled publisher.
It is stored only as encrypted GitHub Actions BLOCKSCOUT_API_KEY; no credential
was committed or put in a public browser build. Official chain-4663 API requests
are paced at four per second. Run 35486574533 published all seven source groups,
including holder counts 110 FUEL / 177 MORE, at 03:27:18.711Z UTC. Public reload
retained those values. Public v0.1.3 hides sync diagnostics and provides combined
price-percent and USD-liquidity comparison charts; private diagnostics remain.


## 2026-09-20 trading chart and cockpit follow-up

User authorized fixes, commits and production deployment while away. Official
Dexscreener embed settings were inspected in its chart dialog; canonical FUEL and
MORE pool URLs are reused. Both live HTTPS embeds rendered genuine USD candles
and volume. Sparse dashboard observations are never converted into trade candles.
The observed 288-slot repeat cockpit failure and transient production HTTP 502
reads motivated paced, abortable retries. Gateway security limits were preserved.
Validation: 185 personal / 169 public tests, lint and builds passed; paced 288-slot
RPC scan and 150-slot browser inventory/reward scan completed without missing rows.
