// Worker-side dashboard snapshot builder for the FUEL/MORE Radar.
//
// The homepage (pairs, contracts, holders, recent activity, protocol) used to
// be assembled by the GitHub Actions publisher on a ~3h cadence (GitHub's
// scheduler drops most triggers; gaps up to 7h). This module rebuilds the
// same snapshot inside the Worker's own 5-minute cron, so every section of
// the site stays as fresh as the free tier allows.
//
// Fidelity: the section builders mirror src/lib/api.ts fetchRadarData (the
// same adapters the UI and the GitHub publisher use), and merge/validation
// mirror src/lib/dashboardSnapshot.ts. When a source fails, the previous
// snapshot's section is retained and honestly marked (retained/partial) —
// missing data is never invented or zeroed.
//
// Budgets (worker free tier):
// - Subrequests: ~18 per tick (2 DexScreener + 7 Blockscout contracts +
//   4 Blockscout holders + 2 Blockscout transfers + 3 JSON-RPC batches),
//   sharing the 50/invocation cap with the market snapshot, burn collector
//   and watchdog in the same tick.
// - KV writes: ZERO. The snapshot is written D1-only (100k writes/day free);
//   every reader already prefers D1, so the legacy KV mirror is pure
//   overhead against the 1,000 KV writes/day cap.
// - RPC: protocol reads are one JSON-RPC batch per phase against the managed
//   endpoint list (resolveRpcUrls: managed -> fallbacks -> public).
//
// runDashboardSnapshot never throws: a failed tick keeps the previous
// snapshot and logs the failure for Workers observability.

import { resolveRpcUrls } from './rpc-config.mjs'
import { toMinHex, hexToBigInt } from './minter-collect.mjs'

export const DASHBOARD_KEY = 'dashboard-snapshot-v1'
export const DASHBOARD_RUN_DEADLINE_MS = 4 * 60 * 1000

const CHAIN_ID = 4663
const CHAIN_ID_HEX = '0x1237'

const CONTRACTS = [
  { key: 'fuel', name: 'FUEL Token', type: 'ERC-20 token', address: '0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3' },
  { key: 'more', name: 'MORE Token', type: 'ERC-20 proxy', address: '0xc0F1A40512114b25cc1F30b5DF0bb48691405555' },
  { key: 'batch', name: 'BatchMinter', type: 'Protocol proxy', address: '0xEaB771dB3883dC05DbEA1915F7e81910869bbc18' },
  { key: 'distributor', name: 'FeeDistributor', type: 'Protocol controller', address: '0x2f69ff61802d9738e562E438d1F6326389D95861' },
  { key: 'vault', name: 'MintVault', type: 'Pump fund', address: '0x492d111487f097759340dc119DE5887d58c38bB0' },
  { key: 'fuelBurner', name: 'FUEL Buy & Burn', type: 'Burn controller', address: '0x1f8e137117f78EF1EA84235F3E5423c46bF2D4A2' },
  { key: 'moreBurner', name: 'MORE Buy & Burn', type: 'Burn controller', address: '0x86f11A15E1793e7ce1F4264830d1973e80339A51' },
]

const PAIRS = {
  fuel: '0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69',
  more: '0xd77dcda732a762ec8b04ee44a1c7370602759d2372037a5008135ab9f60305ef',
}

// First 4 bytes of keccak256(signature); verified against viem 2026-09-24.
const SELECTOR = {
  totalSupply: '0x18160ddd',
  globalRank: '0x1c244082',
  activeMinters: '0xb4800cdc',
  totalTokenStaked: '0x2e559d79',
  activeStakes: '0xed2f2369',
  getCurrentAMP: '0x99202454',
  getCurrentEAAR: '0x8979c87c',
  getCurrentMaxTerm: '0x45125715',
  totalTokenBurnt: '0xede124fc',
  totalMoreBurnt: '0x5dff6021',
  ethUsedForBurns: '0x9ed1f0f9',
  totalDistributed: '0xefca2eed',
  totalSwept: '0x243389bc',
  currentCycle: '0xbab2f552',
  currentCycleEnd: '0xf2d6c828',
}

const DEX_PAIR_API = 'https://api.dexscreener.com/latest/dex/pairs/robinhood'
/** Official Robinhood Chain Blockscout REST v2 (indexed; free, keyless). */
const BLOCKSCOUT_API = 'https://robinhoodchain.blockscout.com/api/v2'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function formatUnits(value, decimals) {
  const neg = value < 0n
  const abs = neg ? -value : value
  const s = abs.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '')
}

async function json(url, { attempt = 0, timeoutMs = 12_000 } = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await pause(500 * (attempt + 1))
      return json(url, { attempt: attempt + 1, timeoutMs })
    }
    throw new Error(`HTTP ${response.status} ${url}`)
  }
  return response.json()
}

async function fetchPair(pairAddress) {
  const payload = await json(`${DEX_PAIR_API}/${pairAddress}`)
  const pair = payload.pairs?.[0]
  if (!pair) throw new Error(`Pair not found: ${pairAddress}`)
  const tokenAddress =
    pairAddress.toLowerCase() === PAIRS.fuel.toLowerCase() ? CONTRACTS[0].address : CONTRACTS[1].address
  if (
    pair.chainId !== 'robinhood' ||
    pair.pairAddress.toLowerCase() !== pairAddress.toLowerCase() ||
    pair.baseToken.address.toLowerCase() !== tokenAddress.toLowerCase()
  ) {
    throw new Error('Market identity mismatch')
  }
  return {
    symbol: pair.baseToken.symbol.toUpperCase(),
    name: pair.baseToken.name,
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    version: pair.labels?.[0] ?? '—',
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    priceNative: pair.priceNative ? Number(pair.priceNative) : null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    marketCap: pair.marketCap ?? null,
    fdv: pair.fdv ?? null,
    volume24h: pair.volume?.h24 ?? null,
    buys24h: pair.txns?.h24?.buys ?? null,
    sells24h: pair.txns?.h24?.sells ?? null,
    change1h: pair.priceChange?.h1 ?? null,
    change6h: pair.priceChange?.h6 ?? null,
    change24h: pair.priceChange?.h24 ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
  }
}

async function fetchContractStatus(contract) {
  const data = await json(`${BLOCKSCOUT_API}/smart-contracts/${contract.address}`)
  return {
    ...contract,
    reachable: true,
    verified: Boolean(data.is_verified),
    proxyType: data.proxy_type ?? null,
    implementation: data.implementations?.[0]?.address_hash ?? null,
    contractName: data.name ?? null,
  }
}

async function fetchHolderSummary(address) {
  const [meta, holders] = await Promise.all([
    json(`${BLOCKSCOUT_API}/tokens/${address}`),
    json(`${BLOCKSCOUT_API}/tokens/${address}/holders`),
  ])
  const supply = BigInt(meta.total_supply)
  const percent = (value) => (supply > 0n ? Number((BigInt(value) * 10_000n) / supply) / 100 : null)
  const items = Array.isArray(holders.items) ? holders.items : []
  const top = items[0]
  const topNonContract = items.find((item) => !item.address.is_contract)
  const totalHolders = Number(meta.holders_count)
  const rows = items.slice(0, 5).map((item) => ({
    address: item.address.hash,
    percent: percent(item.value),
    isContract: item.address.is_contract == null ? null : Boolean(item.address.is_contract),
  }))
  // Empty first page with a positive holder count is an incomplete list, not "no holders."
  const topHolders = rows.length > 0 ? rows : totalHolders === 0 ? [] : null
  return {
    totalHolders,
    topAddress: top?.address.hash ?? null,
    topPercent: top ? percent(top.value) : null,
    topIsContract: top ? Boolean(top.address.is_contract) : null,
    topNonContractPercent: topNonContract ? percent(topNonContract.value) : null,
    topHolders,
  }
}

const unavailableHolders = () => ({
  totalHolders: null,
  topAddress: null,
  topPercent: null,
  topIsContract: null,
  topNonContractPercent: null,
  topHolders: null,
})

async function fetchTransfers(address) {
  const data = await json(`${BLOCKSCOUT_API}/tokens/${address}/transfers`)
  const zero = /^0x0{40}$/i
  const dead = /^0x0{36}dead$/i
  const poolAddresses = Object.values(PAIRS).map((item) => item.toLowerCase())
  return data.items.slice(0, 8).map((item) => {
    const from = item.from.hash
    const to = item.to.hash
    const event = zero.test(from)
      ? 'Mint'
      : dead.test(to) || zero.test(to)
        ? 'Burn'
        : poolAddresses.includes(from.toLowerCase()) || poolAddresses.includes(to.toLowerCase())
          ? 'Pool transfer'
          : 'Transfer'
    return {
      hash: item.transaction_hash,
      timestamp: item.timestamp,
      symbol: item.token.symbol,
      event,
      amount: Number(formatUnits(BigInt(item.total.value), Number(item.total.decimals))),
      from,
      to,
      status: 'Confirmed',
    }
  })
}

/** One JSON-RPC batch call. Returns the array of response objects. */
async function rpcBatch(url, calls) {
  const body = calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i + 1, method, params }))
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
  const payload = await response.json()
  const list = Array.isArray(payload) ? payload : [payload]
  if (list.some((entry) => entry && entry.error)) {
    throw new Error(`RPC batch error: ${JSON.stringify(list.find((e) => e?.error)?.error)?.slice(0, 120)}`)
  }
  return list
}

const safeUint = (hex) => {
  try {
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null
    return hexToBigInt(hex)
  } catch {
    return null
  }
}

/**
 * Protocol reads pinned to one block, mirroring fetchProtocol in
 * src/lib/api.ts: chain check + block, batched eth_calls, chain + hash
 * recheck. Returns { values, observation } or throws. 3 subrequests.
 */
async function fetchProtocol(rpcUrl) {
  const [chainIdRes, blockRes] = await rpcBatch(rpcUrl, [
    ['eth_chainId', []],
    ['eth_getBlockByNumber', ['latest', false]],
  ])
  if (Number(chainIdRes.result) !== CHAIN_ID) throw new Error('Unexpected RPC network')
  const block = blockRes.result
  if (!block?.number || !block?.hash) throw new Error('Confirmed block unavailable')
  const blockNumber = block.number
  const blockHex = toMinHex(hexToBigInt(blockNumber))

  const call = (to, selector) => ['eth_call', [{ to, data: selector }, blockHex]]
  const calls = [
    call(CONTRACTS[0].address, SELECTOR.totalSupply),
    call(CONTRACTS[1].address, SELECTOR.totalSupply),
    call(CONTRACTS[0].address, SELECTOR.globalRank),
    call(CONTRACTS[0].address, SELECTOR.activeMinters),
    call(CONTRACTS[0].address, SELECTOR.totalTokenStaked),
    call(CONTRACTS[0].address, SELECTOR.activeStakes),
    call(CONTRACTS[0].address, SELECTOR.getCurrentAMP),
    call(CONTRACTS[0].address, SELECTOR.getCurrentEAAR),
    call(CONTRACTS[0].address, SELECTOR.getCurrentMaxTerm),
    call(CONTRACTS[5].address, SELECTOR.totalTokenBurnt),
    call(CONTRACTS[6].address, SELECTOR.totalMoreBurnt),
    call(CONTRACTS[5].address, SELECTOR.ethUsedForBurns),
    call(CONTRACTS[6].address, SELECTOR.ethUsedForBurns),
    call(CONTRACTS[3].address, SELECTOR.totalDistributed),
    ['eth_getBalance', [CONTRACTS[4].address, blockHex]],
    call(CONTRACTS[4].address, SELECTOR.totalSwept),
    call(CONTRACTS[4].address, SELECTOR.currentCycle),
    call(CONTRACTS[4].address, SELECTOR.currentCycleEnd),
  ]
  const results = await rpcBatch(rpcUrl, calls)
  const values = results.map((entry) => safeUint(entry.result))

  const [chainIdRes2, blockRes2] = await rpcBatch(rpcUrl, [
    ['eth_chainId', []],
    ['eth_getBlockByNumber', [blockHex, false]],
  ])
  if (Number(chainIdRes2.result) !== CHAIN_ID || blockRes2.result?.hash !== block.hash) {
    throw new Error('Chain changed during protocol reads')
  }
  const [
    totalSupply, moreTotalSupply, globalRank, activeMinters, totalStaked, activeStakes, amp, eaar,
    maxTermSeconds, fuelBurnt, moreBurnt, ethUsedFuelBurns, ethUsedMoreBurns,
    totalDistributed, vaultBalance, vaultSwept, vaultCycle, vaultCycleEnd,
  ] = values
  return {
    observation: {
      blockNumber: hexToBigInt(blockNumber).toString(),
      blockHash: block.hash,
      blockTimestamp: hexToBigInt(block.timestamp).toString(),
    },
    values: {
      totalSupply, moreTotalSupply, globalRank, activeMinters, totalStaked, activeStakes, amp, eaar,
      maxTermSeconds, fuelBurnt, moreBurnt, ethUsedFuelBurns, ethUsedMoreBurns,
      totalDistributed, vaultBalance, vaultSwept, vaultCycle, vaultCycleEnd,
    },
  }
}

/** Try each managed RPC URL in order; throw only when all fail. */
async function fetchProtocolWithFailover(env) {
  let urls
  try {
    urls = resolveRpcUrls(env)
  } catch {
    urls = []
  }
  let lastError = null
  for (const url of urls) {
    try {
      return await fetchProtocol(url)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('No RPC endpoint configured')
}

function sourceCheck(name, available, total, checkedAt, detail) {
  return {
    name,
    status: available === total ? 'available' : available === 0 ? 'unavailable' : 'partial',
    checkedAt,
    detail,
  }
}

const hasUnavailableSources = (sources) => sources.some((source) => source.status !== 'available')

const SOURCE_NAMES = [
  'Dexscreener markets',
  'Blockscout contracts',
  'FUEL holders',
  'MORE holders',
  'FUEL transfers',
  'MORE transfers',
  'Protocol RPC reads',
]
const PROTOCOL_KEYS = [
  'totalSupply', 'moreTotalSupply', 'globalRank', 'activeMinters', 'totalStaked', 'activeStakes',
  'amp', 'eaar', 'maxTermSeconds', 'fuelBurnt', 'moreBurnt', 'ethUsedFuelBurns', 'ethUsedMoreBurns',
  'totalDistributed', 'vaultBalance', 'vaultSwept', 'vaultCycle', 'vaultCycleEnd',
]

export function encodeDashboard(data) {
  return JSON.stringify({ version: 1, chainId: CHAIN_ID, data }, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** Strict shape validation; returns the decoded RadarData or null. */
export function decodeDashboard(raw, now = Date.now()) {
  try {
    if (typeof raw !== 'string' || raw.length > 1_000_000) return null
    const { version, chainId, data } = JSON.parse(raw)
    const time = (value) =>
      typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60_000
    if (version !== 1 || chainId !== CHAIN_ID || !data || !time(data.updatedAt) || typeof data.partial !== 'boolean') {
      return null
    }
    if (
      !Array.isArray(data.sources) ||
      data.sources.length !== SOURCE_NAMES.length ||
      SOURCE_NAMES.some((name) => data.sources.filter((s) => s?.name === name).length !== 1)
    ) {
      return null
    }
    if (
      data.sources.some(
        (s) =>
          !['available', 'partial', 'unavailable'].includes(s.status) ||
          !time(s.checkedAt) ||
          typeof s.detail !== 'string' ||
          (s.attemptedAt !== undefined && !time(s.attemptedAt)),
      )
    ) {
      return null
    }
    if (!Array.isArray(data.pairs) || !Array.isArray(data.contracts) || !Array.isArray(data.activity) || !data.holders || !data.protocol) {
      return null
    }
    if (
      data.pairs.some(
        (p) => !p || !['FUEL', 'MORE'].includes(p.symbol) || typeof p.pairAddress !== 'string' || typeof p.tokenAddress !== 'string',
      )
    ) {
      return null
    }
    if (data.contracts.some((c) => !c || typeof c.address !== 'string' || typeof c.key !== 'string')) return null
    for (const symbol of ['FUEL', 'MORE']) {
      const h = data.holders[symbol]
      if (!h || !(h.totalHolders === null || Number.isFinite(h.totalHolders)) || !(h.topHolders === null || Array.isArray(h.topHolders))) {
        return null
      }
    }
    if (
      data.activity.some(
        (a) => !a || typeof a.hash !== 'string' || !time(a.timestamp) || !Number.isFinite(a.amount),
      )
    ) {
      return null
    }
    if (
      data.protocolObservation &&
      (!/^\d+$/.test(data.protocolObservation.blockNumber) ||
        !/^0x[0-9a-f]{64}$/i.test(data.protocolObservation.blockHash) ||
        !/^\d+$/.test(data.protocolObservation.blockTimestamp))
    ) {
      return null
    }
    for (const key of Object.keys(data.protocol)) if (!PROTOCOL_KEYS.includes(key)) return null
    for (const key of PROTOCOL_KEYS) {
      const value = data.protocol[key]
      if (value === undefined) {
        if (key !== 'moreTotalSupply') return null
        data.protocol[key] = null
        continue
      }
      if (value !== null && (typeof value !== 'string' || !/^\d{1,78}$/.test(value))) return null
      data.protocol[key] = value === null ? null : BigInt(value)
    }
    return data
  } catch {
    return null
  }
}

/** Keep source groups atomic: never fill missing pinned RPC fields from another block. */
export function mergeDashboard(previous, incoming) {
  if (!previous) return incoming
  if (Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt)) return previous
  const next = { ...incoming, holders: { ...incoming.holders }, sources: incoming.sources.map((s) => ({ ...s })) }
  for (const source of next.sources) {
    const prior = previous.sources.find((s) => s.name === source.name)
    if (source.status === 'available' || !prior || (prior.status !== 'available' && !prior.retained)) continue
    source.attemptedAt = source.checkedAt
    source.checkedAt = prior.checkedAt
    source.retained = true
    switch (source.name) {
      case 'Dexscreener markets':
        next.pairs = previous.pairs
        break
      case 'Blockscout contracts':
        next.contracts = previous.contracts
        break
      case 'FUEL holders':
        next.holders.FUEL = previous.holders.FUEL
        break
      case 'MORE holders':
        next.holders.MORE = previous.holders.MORE
        break
      case 'Protocol RPC reads':
        next.protocol = previous.protocol
        next.protocolObservation = previous.protocolObservation
        break
      default: {
        const symbol = source.name.split(' ')[0]
        next.activity = [
          ...next.activity.filter((a) => a.symbol !== symbol),
          ...previous.activity.filter((a) => a.symbol === symbol),
        ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      }
    }
  }
  next.partial = next.sources.some((s) => s.status !== 'available' || s.retained)
  return next
}

const emptyProtocol = () => ({
  totalSupply: null, moreTotalSupply: null, globalRank: null, activeMinters: null, totalStaked: null,
  activeStakes: null, amp: null, eaar: null, maxTermSeconds: null,
  fuelBurnt: null, moreBurnt: null, ethUsedFuelBurns: null, ethUsedMoreBurns: null,
  totalDistributed: null, vaultBalance: null, vaultSwept: null, vaultCycle: null,
  vaultCycleEnd: null,
})

/**
 * Build one RadarData snapshot from live sources. Mirrors the section
 * grouping of fetchRadarData: pairs and contracts are fetched first (their
 * checkedAt timestamps pin the source rows), then holders/transfers/protocol
 * race in parallel with per-source success tracking.
 */
export async function buildDashboard(env) {
  const checked = new Map()
  const track = async (name, promise) => {
    try {
      return await promise
    } finally {
      checked.set(name, new Date().toISOString())
    }
  }

  const pairResults = await Promise.allSettled(Object.values(PAIRS).map((address) => track('Dexscreener markets', fetchPair(address))))
  checked.set('Dexscreener markets', new Date().toISOString())

  // Contracts stay sequential with a small pause: polite to the free
  // explorer tier, matching the GitHub publisher's cadence.
  const contractResults = []
  for (const contract of CONTRACTS) {
    try {
      contractResults.push({ status: 'fulfilled', value: await track('Blockscout contracts', fetchContractStatus(contract)) })
    } catch (reason) {
      contractResults.push({ status: 'rejected', reason })
    }
    await pause(120)
  }
  checked.set('Blockscout contracts', new Date().toISOString())

  const [fuelHolders, moreHolders, fuelActivity, moreActivity, protocol] = await Promise.allSettled([
    track('FUEL holders', fetchHolderSummary(CONTRACTS[0].address)),
    track('MORE holders', fetchHolderSummary(CONTRACTS[1].address)),
    track('FUEL transfers', fetchTransfers(CONTRACTS[0].address)),
    track('MORE transfers', fetchTransfers(CONTRACTS[1].address)),
    track('Protocol RPC reads', fetchProtocolWithFailover(env)),
  ])

  const pairs = pairResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const contracts = contractResults.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : { ...CONTRACTS[index], reachable: false, verified: false, proxyType: null, implementation: null, contractName: null },
  )
  const activity = [
    ...(fuelActivity.status === 'fulfilled' ? fuelActivity.value : []),
    ...(moreActivity.status === 'fulfilled' ? moreActivity.value : []),
  ]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 10)

  const checkedAt = new Date().toISOString()
  const protocolValue = protocol.status === 'fulfilled' ? protocol.value.values : emptyProtocol()
  const protocolFields = Object.values(protocolValue)
  const sources = [
    sourceCheck('Dexscreener markets', pairs.length, 2, checkedAt, 'Third-party mirror of on-chain pool price/liquidity; not an executable quote; fetch time is not trade time.'),
    sourceCheck('Blockscout contracts', contracts.filter((item) => item.reachable).length, CONTRACTS.length, checkedAt, 'Source-verification metadata is not a security audit.'),
    ...[
      ['FUEL holders', fuelHolders],
      ['MORE holders', moreHolders],
      ['FUEL transfers', fuelActivity],
      ['MORE transfers', moreActivity],
    ].map(([name, result]) =>
      sourceCheck(name, result.status === 'fulfilled' ? 1 : 0, 1, checkedAt, 'Explorer-indexed data may lag the chain.'),
    ),
    sourceCheck(
      'Protocol RPC reads',
      protocolFields.filter((value) => value !== null).length,
      protocolFields.length,
      checkedAt,
      `${protocolFields.filter((value) => value !== null).length}/${protocolFields.length} reads returned. Reads pinned to one block; hash rechecked.`,
    ),
  ]
  for (const source of sources) source.checkedAt = checked.get(source.name) ?? checkedAt
  return {
    sources,
    pairs,
    contracts,
    holders: {
      FUEL: fuelHolders.status === 'fulfilled' ? fuelHolders.value : unavailableHolders(),
      MORE: moreHolders.status === 'fulfilled' ? moreHolders.value : unavailableHolders(),
    },
    activity,
    protocol: protocolValue,
    protocolObservation: protocol.status === 'fulfilled' ? protocol.value.observation : undefined,
    updatedAt: new Date().toISOString(),
    partial: hasUnavailableSources(sources),
  }
}

/** Read the previous snapshot (D1 first, legacy KV fallback). */
async function readPrevious(env) {
  try {
    if (env.DB && typeof env.DB.prepare === 'function') {
      const row = await env.DB.prepare('SELECT value FROM snapshots WHERE key = ?').bind(DASHBOARD_KEY).first()
      if (row?.value != null) return decodeDashboard(row.value)
    }
  } catch { /* fall through */ }
  try {
    if (env.ACTIVITY && typeof env.ACTIVITY.get === 'function') {
      const raw = await env.ACTIVITY.get(DASHBOARD_KEY)
      if (raw != null) return decodeDashboard(raw)
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Write the snapshot D1-only. The legacy KV mirror is skipped deliberately:
 * every reader prefers D1, so mirroring would spend 288 KV writes/day of the
 * 1,000/day free cap for zero benefit.
 */
async function writeSnapshot(env, body) {
  if (!env.DB || typeof env.DB.prepare !== 'function') throw new Error('D1 unavailable for dashboard snapshot')
  await env.DB.prepare(
    `INSERT INTO snapshots(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(DASHBOARD_KEY, body, Date.now())
    .run()
}

function withDeadline(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Dashboard snapshot deadline exceeded')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Rebuild the dashboard snapshot on the 5-minute cron. Never throws: a
 * failed tick keeps the previous snapshot and logs the failure.
 */
export async function runDashboardSnapshot(env) {
  try {
    const next = await withDeadline(
      (async () => {
        const [previous, incoming] = await Promise.all([readPrevious(env), buildDashboard(env)])
        const merged = mergeDashboard(previous, incoming)
        const body = encodeDashboard(merged)
        if (!decodeDashboard(body)) throw new Error('Snapshot validation failed')
        await writeSnapshot(env, body)
        return merged
      })(),
      DASHBOARD_RUN_DEADLINE_MS,
    )
    console.log(
      JSON.stringify({
        msg: 'dashboard-snapshot',
        ok: true,
        updatedAt: next.updatedAt,
        partial: next.partial,
        sources: next.sources.map((s) => ({ name: s.name, status: s.status, retained: !!s.retained })),
      }),
    )
  } catch (err) {
    console.error(JSON.stringify({ msg: 'dashboard-snapshot-error', error: err?.message ?? String(err) }))
  }
}
