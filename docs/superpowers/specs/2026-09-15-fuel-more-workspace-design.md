# FUEL / MORE workspace design

Status: proposed for review. User confirmed all three goals: monitoring, planning,
and wallet-connected execution. Robinhood is the initial network, based on the
supplied markets and contracts. Other MORE networks are a later extension.

## Product

One responsive web application for understanding the FUEL / MORE ecosystem,
tracking positions and deadlines, comparing mint/stake scenarios, and submitting
supported transactions through the user's wallet.

### Monitor

Retain the existing market and protocol dashboard. Add per-source freshness and
availability, validated contract identities, balances, burns, fee distributions,
and a supply/maturity timeline. Position lookup must cover direct FUEL positions,
BatchMinter-created positions, and MORE stakes. Unavailable reads must never look
like zero balances or no positions. Token transfers must remain distinguished
from verified protocol events and swaps.

### Plan

Add FUEL mint scenarios (batch size, duration, estimated fees and rewards), FUEL
and MORE stake scenarios, and a consolidated maturity calendar. Show the inputs,
block/time of observation, and assumptions for every estimate. Keep gas estimates,
protocol charges, token-price scenarios, and penalties separate. Future price and
penalty-funded rewards are uncertain; do not label them guaranteed returns.
Calculations must come from verified deployed implementations and contract reads,
not copied marketing formulas. Support saved watch addresses and calendar export.

### Act

Connect an injected EVM wallet, confirm the chain, and expose supported FUEL mint,
claim, claim/remint, stake/unstake and MORE stake/unstake actions. Identify the exact
contract, function, amount, allowance, network, fees, and minimum received where
applicable before requesting a wallet signature. Simulate each supported action,
handle rejection/reverts, and track its receipt. The user signs in their wallet;
the app never handles private keys. Trading starts through explicit market links;
native swapping is a subsequent milestone with validated router/pool integration,
quotes, slippage limits, deadlines, and allowance controls. Links do not count as
completion of native trading.

## Architecture

Keep the existing React, TypeScript, Vite, and viem foundation. Split integrations
into market data, explorer metadata, FUEL, BatchMinter, MORE staking, and wallet
adapters. Each read returns availability, source, timestamp/block, and data rather
than using zero/null alone to conflate errors with empty positions.

Use a chain-specific registry with provenance, proxy implementation address, and
verified ABI artifacts. Token and controller roles stay separate. Proxy changes
invalidate assumptions until refreshed. Calculators consume typed snapshots;
transaction preparation consumes calculator inputs but rechecks current state.

A small Node service with SQLite provides durable event indexing and scheduled
maturity evaluation. It indexes from verified deployment blocks with bounded
requests, checkpoints, confirmation depth, deduplication, and reorg recovery.
The browser reads public summaries through its API; wallet signing stays in the
browser. Local session history is not a substitute for an indexed historical chart.
Deploying this service and configuring delivery channels is a later operational
step, not implicit authorization to publish or subscribe the user.

Use in-app maturity notices and calendar export first. Persistent notifications
require user-enabled web push and a running scheduler; represent delivery status
explicitly. Do not promise background alerts from an open-tab timer.

## Alternatives

1. Recommended: keep the frontend and add adapters plus a small indexed backend.
   Preserves existing work and supports durable history and alerts.
2. Browser-only: simpler hosting, but limited historical coverage and no reliable
   background deadline monitoring.
3. Replace the whole application: permits broader redesign but delays useful
   features and discards a workable foundation without a current requirement.

## Delivery milestones and acceptance

1. Data foundation: restore local test/build tooling; validate deployed interfaces;
   fix unavailable/partial states; document contract provenance. Acceptance: errors
   cannot appear as empty positions or live data; ABI assumptions are traceable.
2. Complete positions and planning: batch/direct FUEL plus MORE stake inventory,
   tested calculations, calendar and export. Acceptance: controlled fixtures cover
   empty/active/matured/late positions, decimal handling, and boundary dates.
3. Wallet actions: connection, chain handling, simulation, approvals and protocol
   writes. Acceptance: mocked wallet and fork/simulation coverage includes rejection,
   insufficient funds, reverted calls, pending and confirmed receipts. No real-value
   transaction is necessary for automated QA.
4. History and alerts: durable index, API, timeline, watchlist and scheduler.
   Acceptance: restart recovery, duplicate logs, reorgs, and deduplicated deadline
   events are exercised; notification delivery requires explicit user opt-in.
5. Native trading: verified pool/router support and quote-to-receipt flow. Acceptance:
   price movement, slippage, expired quotes, allowances and failed swaps are tested.

## Known limits and current evidence

See ../../product-context.md for inspected sources and address mapping. App UI roles
are confirmed; deployed source/ABI auditing is outstanding. Explorer retrieval failed
through the web tool. Existing direct FUEL lookup does not establish complete wallet
coverage. Existing hard-coded allocation percentages require contract verification.
Platform-native dependencies were restored. All five new history tests pass.
An existing compact-currency formatting test fails, and default test discovery
incorrectly includes browser-profile extension tests; tooling cleanup remains. This directory has no Git repository, so this design is saved locally
and is not committed.
