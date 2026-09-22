# Managed RPC Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the existing Worker and Node collector to use a server-secret managed Robinhood RPC endpoint, with safe errors and an explicit capability check before production activation.

**Architecture:** Keep browser requests on same-origin /rpc and preserve the Node collector. Centralize backend endpoint configuration without importing secrets into frontend modules. This is the first independently testable stage of the approved edition split; it does not publish a public repository or change access policies.

**Tech Stack:** React/TypeScript/Vite, Node ESM, viem, Cloudflare Worker, node:test and Vitest.

**Spec:** ../specs/2026-09-19-public-private-radar-design.md

## Global Constraints

- Check chain ID 4663.
- Put provider URLs and keys exclusively in backend secrets, never VITE variables, browser bundles, logs, Git or public documentation.
- Errors are not zero values.
- No wallet connections, approvals, signing, transactions, price predictions or new trading recommendations.
- No paid subscription or account creation is authorized by this spec.
- Preserve FUEL/MORE identities and existing snapshot hash/reorg checks.
- Work in /Volumes/SSD Drive/fuelmore-radar; do not restore the pre-update stash.

## Scope and sequence

The approved design covers independent subsystems. Execute this RPC foundation first. Subsequent separate plans cover: (1) request budgeting, quotas, deduplication and snapshot-safe failover; (2) wallet pagination/progress and public/private source separation; (3) independent publisher storage, telemetry and release. Each requires its own tests and deployment validation. Do not describe this foundation as completing those requirements.

Provider account access, archive entitlement and owner login identity are operational inputs. No credential is needed for mocked implementation tests. Before live activation, the owner creates/selects an Alchemy Robinhood mainnet app and enters its endpoint into backend secrets; never request the key in chat. Do not purchase a plan. Keep the existing public endpoint only as an explicit development/legacy fallback while migration is unconfigured; public release requires a validated managed endpoint.

## Review Focus

- Whitespace or malformed endpoint configuration must fail before a request without echoing credentials (Task 1).
- Provider exceptions may contain secret URLs; responses/logs must use a fixed safe message (Tasks 2–3).
- Switching upstreams must not reuse the old provider's latest-value cache (Task 2).
- Existing collector callers must retain checkpoint and progress behavior with no argument changes (Task 3).
- Chain ID success alone must not be reported as proof of archive or historical-log capability (Task 4).

## File responsibilities

- New server/rpc-config.mjs and server/rpc-config.test.mjs: resolve and validate backend RPC_URL.
- server/worker.mjs and server/worker.test.mjs: use configured upstream, isolate cache, redact failures.
- server/activity.mjs, server/index.mjs, server/publish-activity.mjs: collector configuration and safe outward errors.
- New scripts/check-rpc.mjs and server/rpc-probe.test.mjs: explicit read-only provider capability probe.
- package.json: include new Node test files and check:rpc script.
- .gitignore and .env.example: local secret-file exclusions and placeholder configuration.
- .github/workflows/refresh-activity.yml: pass GitHub RPC_URL secret to publisher only.
- README.md and docs/PROJECT_OVERVIEW.md: setup, migration and unverified deployment limits.

### Task 1: Backend endpoint configuration

**Interfaces:** resolveRpcUrl(env: { RPC_URL?: string }): string; PUBLIC_RPC constant. Imports no process or browser globals; callers supply env.

- [ ] Add failing Node tests in server/rpc-config.test.mjs:

```js
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRpcUrl, PUBLIC_RPC } from './rpc-config.mjs'
it('supports legacy configuration and managed HTTPS paths', () => {
  assert.equal(resolveRpcUrl({}), PUBLIC_RPC)
  assert.equal(resolveRpcUrl({RPC_URL:'https://provider.test/v2/example'}), 'https://provider.test/v2/example')
})
it('rejects malformed or insecure config without disclosing it', () => {
  for (const value of [' ', 'http://provider.test/secret', 'https://user:secret@provider.test', 'file:///secret']) {
    assert.throws(() => resolveRpcUrl({RPC_URL:value}), error => error.message === 'Invalid backend RPC configuration')
  }
})
```

- [ ] Run `node --test server/rpc-config.test.mjs`; expect missing-module failure.
- [ ] Implement resolution without normalizing the provider's signed path/query:

```js
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export function resolveRpcUrl(env) {
  if (env.RPC_URL === undefined || env.RPC_URL === '') return PUBLIC_RPC
  try {
    const value = env.RPC_URL.trim()
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
    return value
  } catch { throw new Error('Invalid backend RPC configuration') }
}
```

- [ ] Add `.dev.vars` and `.dev.vars.*` to .gitignore; add `.env.example` containing `RPC_URL=` and a comment that it is backend-only. Include the new test explicitly in npm test.
- [ ] Run targeted tests; commit configuration and its tests.

### Task 2: Worker upstream and safe failure handling

**Consumes:** resolveRpcUrl(env). **Produces:** same existing /rpc JSON-RPC interface, configured endpoint with no frontend change.

- [ ] Extend worker.test.mjs with mocked requests proving the upstream is configurable and thrown errors cannot disclose endpoint secrets:

```js
it('uses configured upstream and redacts transport errors', async () => {
  const endpoint = 'https://provider.test/v2/test-secret'
  mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, endpoint)
    throw new Error('Failed at ' + endpoint)
  })
  const response = await worker.fetch(request({jsonrpc:'2.0', id:910, method:'eth_getBalance', params:['0x123','latest']}), {...env, RPC_URL:endpoint}, ctx)
  assert.equal(response.status, 502)
  assert.equal((await response.text()).includes('test-secret'), false)
})
```

- [ ] Add a cache-isolation regression: request eth_chainId on endpoint A then B; mock different results and assert two upstream calls and B's value. Run `node --test server/worker.test.mjs`; observe these failures before editing.
- [ ] Import resolveRpcUrl, resolve once inside the guarded RPC branch, pass its result to fetch, namespace the bounded memory cache by endpoint, and replace outward transport messages with `RPC provider unavailable; retry shortly`. Cache keys remain private memory and are never logged. Preserve existing read-only restrictions, timeout and response-ID behavior.

```js
const upstream = resolveRpcUrl(env)
const cacheKey = isCacheable ? `${upstream}:${parsed.method}:${JSON.stringify(parsed.params ?? [])}` : null
// fetch(upstream, existingOptions)
// Catch response error message: 'RPC provider unavailable; retry shortly'
```

- [ ] Run all Worker and allowlist tests. Commit Worker changes and regressions.

### Task 3: Collector configuration and secret-safe reporting

**Consumes:** resolveRpcUrl(process.env). **Produces:** unchanged collectActivity(onProgress, previousIndex) API and report/index formats.

- [ ] Add a collector regression using a temporary RPC_URL and a mocked global fetch: assert the first chain-ID request targets that configured URL, respond with chain ID 1, and assert collection rejects before any history request. Restore env and fetch after the test. Add an error-formatting regression that passes an exception containing a synthetic secret endpoint and confirms the output excludes it; export `collectorFailureMessage()` from rpc-config.mjs returning `Activity collection failed; check provider configuration or retry`.
- [ ] Run the new tests and observe failure before changes.
- [ ] Replace only the collector transport URL with the configured endpoint. Keep block-hash/reorg checks, chain verification and transaction-sender resolution intact:

```js
transport: http(resolveRpcUrl(process.env), { timeout: 20_000, retryCount: 3, retryDelay: 1000 })
```

- [ ] Inspect every outward collector exception path in activity.mjs, index.mjs and publish-activity.mjs. Replace provider-derived error text with collectorFailureMessage(); preserve static known validation messages where safe. Wrap publisher main failure so Node does not print a viem exception containing the URL; set process.exitCode=1. Never log env or request configuration.
- [ ] Pass the secret only into the workflow's collection step:

```yaml
env:
  RPC_URL: ${{ secrets.RPC_URL }}
```

- [ ] Run `npm test`, `npm run lint`, `npm run build`; update runtime setup docs, noting local Vite still uses the public proxy until the separately planned gateway consolidation. Commit collector/configuration changes.

### Task 4: Capability probe and activation evidence

**Interface:** scripts/check-rpc.mjs exports `probeRpc(call)` where call(method, params) returns decoded JSON-RPC result. Returns `{chainId, blockNumber, historicalRead, historicalLogs, consistent}` with booleans; CLI exits nonzero if any mandatory check fails. Never returns endpoints or raw provider errors.

- [ ] Create server/rpc-probe.test.mjs with mocked wrong-chain, unavailable history, inconsistent hash and success cases. Example failure contract:

```js
it('rejects another chain before historical calls', async () => {
  await assert.rejects(probeRpc(async method => {
    assert.equal(method, 'eth_chainId')
    return '0x1'
  }), /Unexpected RPC network/)
})
```

- [ ] Run `node --test server/rpc-probe.test.mjs`; expect failure before implementation.
- [ ] Implement probe sequence: eth_chainId must equal 0x1237; choose head minus 64; record its hash; read FUEL totalSupply using eth_call selector 0x18160ddd at that block; repeat at the report's documented fromBlock from public/fuel-activity.json; read a single-block FUEL Transfer eth_getLogs query there; re-read pinned hash and require equality. Successful empty logs prove request support only, not historical completeness. Return capability booleans, not balances or keys. Broader log-range and batch support stay separately documented as unmeasured.
- [ ] CLI uses resolveRpcUrl(process.env), POST JSON-RPC with a 10-second abort deadline, checks HTTP and JSON-RPC errors, and prints only the safe result. Guard CLI execution so imports in tests make no network requests. Add `check:rpc` and the test file to package.json.
- [ ] Run all required checks. With a configured endpoint, run `npm run check:rpc` and record sanitized results. If no endpoint is configured, report that live managed-provider validation is pending rather than testing the public endpoint and claiming migration success.
- [ ] After endpoint validation, configure RPC_URL via Cloudflare secret entry and GitHub Actions secret entry; do not put the value in chat/commands recorded in history. Verify Worker activity reads, historical collector progress and no secret URLs in public assets/errors. Record deployment version and rollback instructions (restore previous secret configuration and Worker version).
- [ ] Commit probe, tests and evidence docs. Publish/deploy only the reviewed changes, and clearly distinguish configured infrastructure from code readiness.

## Self-review and handoff

This stage covers backend endpoint configuration, safe errors and endpoint characterization. It intentionally does not claim to solve load scaling, private access, UI progress, collector scheduling or the edition split. Those remain explicit later plans under the approved spec. Tests cover all five review-focus conditions. Preserve existing tests as the snapshot-integrity baseline.

Recommended execution: Native, task-by-task in the current session. Four dependent tasks share a small configuration interface; one final independent review is appropriate. Review this plan and select the execution method before product edits.
