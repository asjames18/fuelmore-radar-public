# Contract provenance — Robinhood Chain (4663)

**Observed:** 2026-09-17; reference cross-check 2026-09-19  
**Method:** Sourcify `exact_match` (chain 4663) plus live `eth_call` spot checks.  
**Independent references (not authoritative alone):** AxelCalloway/fuel-protocol-backup Solidity + address table; Willis5555/FUEL `index.html` ABIs/addresses. See `REFERENCE_CROSSCHECK.md`.  
**Not a security audit.** Explorer/Sourcify verification means published source matches bytecode; it does not imply economic safety.

## Registry

| Role | Address | Sourcify | Local source |
| --- | --- | --- | --- |
| FUEL Token | `0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3` | exact_match (2026-09-14) | `sources/fuel/Token.sol` |
| MORE Token | `0xc0F1A40512114b25cc1F30b5DF0bb48691405555` | **no match** (minimal proxy bytecode ~45 B) | — |
| BatchMinter | `0xEaB771dB3883dC05DbEA1915F7e81910869bbc18` | exact_match | `sources/batch/BatchMinter.sol` |
| FeeDistributor | `0x2f69ff61802d9738e562E438d1F6326389D95861` | exact_match | `sources/distributor/FeeDistributor.sol` |
| MintVault | `0x492d111487f097759340dc119DE5887d58c38bB0` | exact_match | `sources/vault/MintVault.sol` |
| FUEL Buy & Burn | `0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2` | exact_match | `sources/fuelBurner/TokenBuyAndBurn.sol` |
| MORE Buy & Burn | `0x86f11A15E1793e7ce1F4264830d1973e80339A51` | exact_match | `sources/moreBurner/MoreBurner.sol` |
| MORE staking | `0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31` | exact_match | `sources/moreStaking/rhmoreteststk.sol` |

Sourcify status JSON for each match lives beside the source. Re-fetch:

`https://sourcify.dev/server/v2/contract/4663/<address>`

## Verified protocol rules (FUEL)

### Mint fee

```text
mintFee(gasPrice) = soloMintGas * max(gasPrice, minGasPrice)
```

- Defaults in source: `soloMintGas = 150_000`, `minGasPrice = 1 gwei` (owner-adjustable within hard bounds).
- Entire fee is forwarded to `feeDistributor`.
- Live spot check (2026-09-17, gasPrice = 1 gwei): `mintFee = 0.00015 ETH`.

### Claim fee

```text
claimFee(gasPrice) = mintFee(gasPrice) * 2500 / 10000   // 25% of mint fee
```

- `CLAIM_FEE_BPS = 2500` is a constant (not owner-adjustable).
- Live spot check: `claimFee = 0.0000375 ETH` at 1 gwei.

### Fee split (45 / 25 / 30)

From verified `FeeDistributor.sol` constants and comments:

| BPS | Share | Destination |
| --- | --- | --- |
| 4500 | 45% | MintVault |
| 2500 | 25% | TokenBuyAndBurn (FUEL) |
| 3000 | 30% | MoreBurner |

`Token.sol` documents the same split. Permissionless `distribute()` flushes accumulated ETH when balance ≥ `0.01 ether`.

**Status change:** previously labeled app-reported/unverified in the UI; now **source-verified** against deployed FeeDistributor bytecode via Sourcify.

### Batch minting fees

`BatchMinter.sol` states explicitly that each proxy pays the **full** per-address mint/claim fee. Batching amortizes gas, not protocol fees (`MAX_BATCH = 100`).

### Late claim penalty (mint reward)

```text
daysLate = secsLate / 1 day
if daysLate > 6: penaltyPct = 99
else: penaltyPct = min(2^(daysLate+3)/7 - 1, 99)
netReward = grossReward * (100 - penaltyPct) / 100
```

- `WITHDRAWAL_WINDOW_DAYS = 7`, `MAX_PENALTY_PCT = 99`.
- Claim is allowed any time after maturity; there is no hard cutoff—only escalating penalty.
- Gross reward: `getGrossReward(rankDelta, amplifier, term, eaa)` using ABDK log₂ math.

### Stake APY parameter

`getCurrentAPY()` decays from `APY_START = 20` toward `APY_END = 2` every `APY_DAYS_STEP = 90` days since genesis. Stake reward uses that locked APY at stake creation.

## MORE staking (verified source; separate rules)

File verified on-chain is named `rhmoreteststk.sol`. Early exit: proportional unserved-days penalty. Late exit: grace `14 days`, then linear scale over `700 days`. Penalties recycle into the reward pool (no 45/25/30 split).

## Still open / not verified here

- MORE token implementation behind the EIP-1167 proxy (Sourcify: no match).
- Independent security review, economic attack analysis, or audit.
- End-to-end tests that recompute `getGrossReward` against live claims (planner still withholds reward projections until wired + tested).
- Bytecode re-verification automation in CI.

## Implications for “mint conditions”

Honest mint-environment signals can now cite:

1. Live `mintFee` / `claimFee` at a pinned block and gas price.
2. Verified fee-split destinations.
3. Late-claim penalty schedule (claim urgency after maturity).
4. Batch full-fee-per-slot rule.
5. Source-health / liquidity (market) — still observational, not advice.

Do **not** label an outcome “safe to mint.” Prefer Favorable / Caution / Unfavorable / Unknown with cited rules and observation blocks.

## Independent reference cross-check (2026-09-19)

Compared Radar’s checksummed registry and Sourcify excerpts to
[AxelCalloway/fuel-protocol-backup](https://github.com/AxelCalloway/fuel-protocol-backup)
(`contracts/*.sol`, `addresses/ADDRESSES.md`) and, secondarily,
[Willis5555/FUEL](https://github.com/Willis5555/FUEL) (`index.html`).

- Protocol byte identities match. Axel prints FeeDistributor and FUEL Buy & Burn
  in lowercase in markdown; EIP-55 restores Radar’s existing checksums.
- Axel Solidity is byte-identical to Radar’s Sourcify excerpts aside from a
  trailing newline. Fee split `4500/2500/3000` and `_penalty` match.
- Axel’s backup UI labels the MORE burner key as `MORE`. Willis separates
  `A.more` (token) from `A.moreBurnerExpected`. Radar keeps those roles distinct.
- Axel lists Robinhood WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. Radar
  records it as `ROBINHOOD_WETH` (chain wrap token) and does **not** add it to
  protocol `CONTRACTS` or change live FUEL/MORE addresses.
- MORE token and MORE staking are not in Axel’s address table; Willis includes
  the MORE token and FUEL/WETH pool, not MORE staking.

Full table: `docs/provenance/REFERENCE_CROSSCHECK.md`.
