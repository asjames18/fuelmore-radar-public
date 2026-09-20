# FUEL / MORE Radar

Read-only market, protocol and wallet-position dashboard for Robinhood Chain
mainnet (chain ID **4663**). No wallet connection or transaction signing.

## Run locally

Use Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:4173/. The local collector listens on port 4174. Initial
activity collection can take time; unavailable or stale data is labeled.
Set `RPC_URL` in the backend process environment to a managed Robinhood mainnet
endpoint. Never put provider credentials in a `VITE_` variable or browser code.
Local browser RPC uses the public endpoint until a backend gateway is configured.

```sh
npm test
npm run lint
npm run build
```

## Cloudflare

Build output is `dist-public`. Create a separate Worker and ACTIVITY KV namespace;
add its ID to `wrangler.jsonc`. Store `RPC_URL` as a Worker secret. Verify chain
4663, archive reads and log limits with `npm run check:rpc` before activation.
The deployment configuration is a template, not a running service. Verify its
rate-limit binding and a scheduled Node publisher before exposing a public API.

The included `RPC_RATE_LIMITER` binding allows approximately 600 logical RPC
reads per minute per client IP at each Cloudflare location. A batch consumes one
token per method. Use an unused account namespace ID in `wrangler.jsonc`; keep
public and personal editions in separate namespaces. Missing or failed binding
protection returns 503; an exhausted limit returns 429 with Retry-After. IPs
behind a shared network share the allowance. Cloudflare counters are permissive,
eventually consistent and local to each location, not a global billing cap.
Set provider spending/usage controls separately and verify real deployed
limits before launch. Reference: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

Run `npm run publish:activity` on a scheduled Node host with persistent
`.radar-data`, then `npm run publish:storage` to upload the complete report to KV.
The storage step requires backend-only `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_KV_NAMESPACE_ID` and a scoped `CLOUDFLARE_API_TOKEN`. Use one publisher
per namespace. It preserves coverage/hash/time and rejects invalid, old or
out-of-order snapshots. The Worker is a reader; activity updates need no rebuild.
The Alchemy free endpoint requires `RPC_LOG_RANGE=10`, but its monthly allowance
is insufficient for continuous complete scanning at the measured chain cadence.
Select a provider/plan with adequate capacity; validate larger log ranges before
increasing `RPC_LOG_RANGE`. Running less often does not reduce total blocks to
scan. No paid service is enabled by this template. Failed reads retain the
last complete report and resumable checkpoint. Verify live publication and
recovery before release.

## Pages and interpretation

- Overview: market and protocol snapshots, daily FUEL minting versus claiming.
- Cockpit and Positions: enter any public wallet; no wallet is preselected.
- Markets: choose FUEL or MORE with its own scale. Charts contain observations
  collected by this browser, not historical candles. Flat prices can be real.
- Protocol and Contracts: contract state and source-match metadata.
- Planner: Coming soon while calculations undergo release validation.

Daily wallets are unique transaction senders, not verified people. Read coverage,
UTC dates, pinned blocks and freshness labels before interpreting the figures.
Prices are third-party Dexscreener snapshots, not executable quotes. Contract
source verification is not a security audit. Large wallet reads can take several
minutes; incomplete reads remain explicitly incomplete.

Source provenance is recorded in `docs/provenance/CONTRACT_PROVENANCE.md`.
This project is not affiliated with Robinhood, FUEL, MORE, Alchemy or Dexscreener.

## License

Original Radar code is MIT licensed. See LICENSE and THIRD_PARTY_NOTICES.md.
