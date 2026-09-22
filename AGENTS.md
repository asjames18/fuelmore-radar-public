# FUEL / MORE Radar agent instructions

## Scope

These instructions apply to the entire project at `D:\fuelmore-radar`.
This is the canonical working folder. Do not edit an older copy under
`C:\AI\Projects` unless the user explicitly asks.

## Read first

Before changing the project, read:

1. `docs/PROJECT_OVERVIEW.md` for current scope, architecture, and boundaries.
2. `README.md` for runtime details and the latest verification record.
3. `docs/product-context.md` for source history and identity decisions.
4. The relevant code and tests for the requested feature.

Historical plans in `docs/superpowers/` may describe unfinished work. Live code,
tests, and the current overview take precedence over an older plan's status text.

## Non-negotiable identity rules

- Robinhood Chain ID is `4663`.
- FUEL token: `0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3`.
- MORE token: `0xc0F1A40512114b25cc1F30b5DF0bb48691405555`.
- `0x86f11A15E1793e7ce1F4264830d1973e80339A51` is the MORE Buy & Burn
  controller, not the MORE token.
- Treat token, pool, controller, proxy, implementation, and staking roles as
  separate identities. Verify any registry change before editing code.

## Current authority boundary

The application is read-only. Unless the user explicitly authorizes a scope
change, do not add wallet connection, approvals, signatures, write-contract calls,
transactions, swaps, subscriptions, deployments, or public notifications.

Never request, handle, store, print, or commit a private key or seed phrase. Do
not use a real-value transaction for testing. A future roadmap item is not current
authorization.

## Data integrity rules

- Preserve source, observation time, block, and freshness information.
- Keep unavailable, partial, delayed, stale, and confirmed-empty states distinct.
- Never replace a failed read with zero, false, or “no positions.”
- Do not silently combine values observed at incompatible blocks.
- For paginated position reads, preserve the original pinned block/hash.
- Recheck chain ID and snapshot hash around sensitive multi-read operations.
- Label explorer verification as metadata, never as a security audit.
- Label Dexscreener figures as third-party snapshots, never executable quotes.
- Do not infer swaps from token transfers alone.
- Preserve the app-reported/unverified qualification on the 45/25/30 fee split
until distributor source verification is recorded. After 2026-09-17 provenance
work, treat the split as source-verified via Sourcify exact match on
FeeDistributor; keep the “not a security audit” label.
- Do not add reward, penalty, yield, profitability, or price projections without
  verified deployed rules, explicit assumptions, and tests.

## Editing guidance

- Keep the React/TypeScript/Vite/viem frontend and the local Node collector unless
  the requested work requires an architecture change.
- Put chain/data adapters and validation in `src/lib/`, reusable UI in
  `src/components/`, and collector logic in `server/`.
- Keep the contract registry centralized. If an address or ABI changes, update
  code, tests, provenance documentation, and `docs/PROJECT_OVERVIEW.md` together.
- Preserve strict input validation, bigint precision, token decimals, UTC labels,
  and accessible loading/error states.
- Preserve responsive operation, including the 390-pixel mobile layout.
- Do not edit generated `dist/`, `.radar-data/`, browser QA profiles, screenshots,
  `node_modules/`, resource-fork files, or TypeScript build-info files as source.
- This project is a GitHub repository (`asjames18/fuelmore-radar`). Do not
  claim a commit, branch, or clean Git state unless that is verified. Do not
  merge existing draft PRs unless the user explicitly asks.

## Required validation

After meaningful code changes, run from `D:\fuelmore-radar`:

```powershell
npm test
npm run lint
npm run build
```

Add or update tests for changed behavior. For UI changes, verify clean desktop and
390-pixel mobile loads, relevant navigation paths, failure/stale states, and the
browser console. Never report a check as passed unless it was run in the current
working state.

## Documentation and handoff

Keep agent rules concise here. Put detailed, shareable project explanation in
`docs/PROJECT_OVERVIEW.md`, quick-start details in `README.md`, and evidence/history
in `docs/product-context.md`. Clearly distinguish current behavior, verified facts,
inferences, and future plans.

In a completion handoff, report files changed, checks run, remaining limitations,
and any live verification that was not performed.

