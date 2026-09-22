# Independent reference cross-check (2026-09-19)

**Not a security audit.** This note compares Radar’s registry and provenance
against two public repositories used as **inspiration / secondary sources**.
Neither repo is treated as authoritative without matching our Sourcify-backed
sources and checksummed identities.

| Source | Observed | Role |
| --- | --- | --- |
| [AxelCalloway/fuel-protocol-backup](https://github.com/AxelCalloway/fuel-protocol-backup) | commit `bb119a95502b7fc6c0c01d1beb37f006610a16bb` (2026-09-18) | Solidity under `contracts/`, `addresses/ADDRESSES.md`, README table |
| [Willis5555/FUEL](https://github.com/Willis5555/FUEL) | commit `36a9b184a1d8bbd46c226e6ccd6ba06587af5836` (2026-09-19) | `index.html` ABIs/addresses (secondary) |

Radar did **not** vendor either frontend. Both include wallet connect and
write-contract flows that remain out of Radar scope.

## Address comparison (EIP-55)

Byte identities match after restoring checksums. Axel’s README / `ADDRESSES.md`
print two addresses in lowercase; they are the same 20-byte values.

| Role | Radar (`src/lib/contracts.ts` / `more.ts`) | Axel | Willis | Result |
| --- | --- | --- | --- | --- |
| FUEL token | `0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3` | same | same (`A.token`) | Match |
| MORE token | `0xc0F1A40512114b25cc1F30b5DF0bb48691405555` | **absent** | same (`A.more`) | Radar + Willis; Axel table omits MORE token |
| BatchMinter | `0xEaB771dB3883dC05DbEA1915F7e81910869bbc18` | same | same | Match |
| FeeDistributor | `0x2f69ff61802d9738e562E438d1F6326389D95861` | same bytes, lowercase in markdown | same | Match after checksum |
| MintVault | `0x492d111487f097759340dc119DE5887d58c38bB0` | same | same | Match |
| FUEL Buy & Burn | `0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2` | same bytes, lowercase in markdown | same (`A.buyBurn`) | Match after checksum |
| MORE Buy & Burn | `0x86f11A15E1793e7ce1F4264830d1973e80339A51` | same, but Axel `index.html` key is `MORE` | `A.moreBurnerExpected` | **Identity pitfall in Axel UI naming** |
| MORE staking | `0xCC22e7f65bEF29aa21f6F59b9363fdc26005dE31` | **absent** | **absent** | Radar-only in this comparison |
| FUEL/WETH pool | `0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69` | **absent** from address table | same (`A.pool`) | Radar + Willis |
| Robinhood WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (documented as `ROBINHOOD_WETH`) | listed | **absent** | Chain wrap token, **not** added to protocol `CONTRACTS` |
| Multicall3 | checksum restored to `0xcA11bde05977b3631167028862bE2a173976CA11` | **absent** | same | Formatting only; same identity |

**Live protocol addresses were not changed.** The only registry formatting
change is Multicall3 EIP-55 checksum. WETH is recorded as chain infrastructure
and is not used for protocol reads.

Willis resolves `feeDist.moreBurner()` at runtime and compares it to
`moreBurnerExpected`. Radar continues to treat `0x86f1…9A51` as the MORE Buy &
Burn controller, never as the MORE token.

## Solidity vs Radar provenance sources

Axel `contracts/*.sol` is **byte-identical** to Radar’s Sourcify excerpts under
`docs/provenance/sources/` except a trailing newline on Axel’s copies:

| Axel file | Radar excerpt |
| --- | --- |
| `Fuel.sol` | `sources/fuel/Token.sol` |
| `BatchMinter.sol` | `sources/batch/BatchMinter.sol` |
| `FeeDistributor.sol` | `sources/distributor/FeeDistributor.sol` |
| `MintVault.sol` | `sources/vault/MintVault.sol` |
| `TokenBuyAndBurn.sol` | `sources/fuelBurner/TokenBuyAndBurn.sol` |
| `MoreBurner.sol` | `sources/moreBurner/MoreBurner.sol` |

This strengthens the existing Sourcify exact-match record. It is still not an
audit, and MORE token implementation source remains unmatched.

## Fee split 45 / 25 / 30

Axel `FeeDistributor.sol` constants match Radar `FEE_SPLIT` and
`CONTRACT_PROVENANCE.md`:

```text
VAULT_BPS = 4_500  // 45% MintVault
BURN_BPS  = 2_500  // 25% FUEL Buy & Burn
MORE_BPS  = 3_000  // 30% MORE Buy & Burn
BPS_DENOM = 10_000
```

Willis exposes the same getters in its FeeDistributor ABI (`VAULT_BPS`,
`BURN_BPS`, `MORE_BPS`) and does not contradict the split.

## Late-claim penalty

Axel `Fuel.sol` `_penalty` matches Radar `lateClaimPenaltyPct` and Willis
`penaltyPct`:

```text
daysLate = secsLate / 1 day
if daysLate > 6: penaltyPct = 99
else: penaltyPct = min(2^(daysLate+3)/7 - 1, 99)
```

`WITHDRAWAL_WINDOW_DAYS = 7`, `MAX_PENALTY_PCT = 99`. Claim remains allowed after
maturity; the curve is a penalty, not a hard cutoff. Radar still does not invent
claim amounts from this schedule on the Positions page.

## Willis UX notes used as read-only inspiration

Willis’s `index.html` includes connect-wallet, mint/claim/stake writes, a 12%
fee buffer, and a mint-event holder scan. **None of those are copied.**

Patterns that informed Radar’s read-only surfaces:

- Due (penalty-free window) vs late (penalty &gt; 0) styling on position cards.
- View-only fee quote lines from `mintFee` / `claimFee` / batch getters.
- Grouped protocol stats and a top-holder list **only** from data already
  returned by Blockscout’s holders endpoint (first page, up to five rows).

Willis’s on-demand mint-event census is **not** implemented. Radar will not
fabricate extra holders.

## Still open

- MORE token implementation behind the EIP-1167 proxy (Sourcify: no match).
- Independent Sourcify re-check of Robinhood WETH (documented, not wired).
- CI bytecode re-verification.
- Reward / gross-claim calculators on Positions (Cockpit already reads
  `getGrossReward` separately).
- Draft PRs #1 and #2 were left untouched.
