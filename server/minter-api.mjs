// Read-only HTTP handlers for FUEL minter analytics.
//
// Shared by the public worker (server/worker.mjs) and the preview proxy
// worker: both pass their KV namespace and get the same JSON contract.
//
//   GET /api/minters?sort=<key>&dir=asc|desc&limit=<1..500>
//     → { status: 'ok'|'collecting', count, rows, methodology,
//         through_block, through_time }
//   GET /api/flows/daily?date=YYYY-MM-DD (default: today, America/New_York)
//     → { status: 'ok'|'collecting', date, buyers, sellers, buy_vol_usd,
//         sell_vol_usd, n_buys, n_sells, usd_missing, note,
//         through_block, through_time }
//
// Missing data is reported as status 'collecting' with empty lists —
// never fabricated zeroes. USD values are approximate (see methodology).

import {
  METHODOLOGY,
  MINTER_KEY_PREFIX,
  DAY_KEY_PREFIX,
  META_KEY,
} from './minter-collect.mjs'

const WEI_PER_TOKEN = 1e18
const DISPLAY_TOP_N = 10

const SORT_KEYS = new Set([
  'claimed',
  'sold',
  'bought',
  'pct_sold',
  'mints_opened',
  'remint_count',
  'remint_eth',
  'first_claim_ts',
  'first_sale_ts',
  'last_active_ts',
])

const FLOWS_NOTE =
  'Top FUEL buyers and sellers per America/New_York calendar day, measured from ' +
  'FUEL/WETH pool swaps. Router-mediated swaps are attributed to the transaction ' +
  'sender. USD values are approximate; usd_missing counts swaps whose USD value ' +
  'could not be calibrated.'

function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function weiToTokens(weiStr) {
  try {
    return Number(BigInt(weiStr)) / WEI_PER_TOKEN
  } catch {
    return null
  }
}

function isoOrNull(tsSeconds) {
  const n = Number(tsSeconds)
  if (!Number.isFinite(n) || n <= 0) return null
  try {
    return new Date(n * 1000).toISOString()
  } catch {
    return null
  }
}

function publicRow(stored) {
  return {
    wallet: stored.wallet,
    claimed: weiToTokens(stored.claimed),
    sold: weiToTokens(stored.sold),
    bought: weiToTokens(stored.bought),
    pct_sold: numOrNull(stored.pct_sold),
    mints_opened: numOrNull(stored.mints_opened),
    remint_count: numOrNull(stored.remint_count),
    remint_eth: weiToTokens(stored.remint_eth_wei),
    first_claim_ts: numOrNull(stored.first_claim_ts),
    first_sale_ts: numOrNull(stored.first_sale_ts),
    last_active_ts: numOrNull(stored.last_active_ts),
  }
}

function publicEntry(entry) {
  return {
    wallet: entry.w,
    fuel: weiToTokens(entry.fuel),
    usd: typeof entry.usd === 'number' ? entry.usd : null,
  }
}

async function readMeta(kv) {
  try {
    const meta = await kv.get(META_KEY, 'json')
    if (meta && typeof meta === 'object') return meta
  } catch {
    /* treat as missing */
  }
  return null
}

function freshness(meta) {
  return {
    through_block: meta?.last_block ?? null,
    through_time: typeof meta?.last_run_ts === 'number' ? isoOrNull(meta.last_run_ts) : null,
  }
}

function jsonResponse(payload, { status = 200, maxAge = 120 } = {}) {
  return Response.json(payload, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  })
}

function kvUnavailable() {
  return jsonResponse({ error: 'Minter data unavailable' }, { status: 503, maxAge: 0 })
}

export async function handleMintersRequest(request, kv) {
  if (!kv || typeof kv.list !== 'function') return kvUnavailable()
  const url = new URL(request.url)
  const sortParam = url.searchParams.get('sort')
  const sort = sortParam && SORT_KEYS.has(sortParam) ? sortParam : 'sold'
  const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))

  try {
    const rows = []
    let cursor
    do {
      const page = await kv.list({ prefix: MINTER_KEY_PREFIX, cursor, limit: 1000 })
      for (const key of page.keys ?? []) {
        try {
          const stored = await kv.get(key.name, 'json')
          if (stored && typeof stored.wallet === 'string') rows.push(publicRow(stored))
        } catch {
          /* skip unreadable rows */
        }
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)

    rows.sort((a, b) => {
      const av = a[sort]
      const bv = b[sort]
      // Missing values always sort last.
      const an = av == null ? (dir === 'desc' ? -Infinity : Infinity) : av
      const bn = bv == null ? (dir === 'desc' ? -Infinity : Infinity) : bv
      return dir === 'desc' ? bn - an : an - bn
    })

    const meta = await readMeta(kv)
    return jsonResponse({
      status: rows.length > 0 ? 'ok' : 'collecting',
      count: rows.length,
      rows: rows.slice(0, limit),
      methodology: METHODOLOGY,
      ...freshness(meta),
    })
  } catch {
    return kvUnavailable()
  }
}

function etToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function handleFlowsDailyRequest(request, kv) {
  if (!kv || typeof kv.get !== 'function') return kvUnavailable()
  const url = new URL(request.url)
  const date = url.searchParams.get('date') || etToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: 'Invalid date; use YYYY-MM-DD' }, { status: 400, maxAge: 0 })
  }

  try {
    const stored = await kv.get(DAY_KEY_PREFIX + date, 'json')
    const meta = await readMeta(kv)
    const base = {
      date,
      note: FLOWS_NOTE,
      ...freshness(meta),
    }
    if (!stored || typeof stored !== 'object') {
      return jsonResponse({
        ...base,
        status: 'collecting',
        buyers: [],
        sellers: [],
        buy_vol_usd: null,
        sell_vol_usd: null,
        n_buys: null,
        n_sells: null,
        usd_missing: null,
      })
    }
    const entries = (list) =>
      (Array.isArray(list) ? list : []).slice(0, DISPLAY_TOP_N).map(publicEntry)
    return jsonResponse({
      ...base,
      status: 'ok',
      buyers: entries(stored.buyers),
      sellers: entries(stored.sellers),
      buy_vol_usd: numOrNull(stored.buy_vol_usd),
      sell_vol_usd: numOrNull(stored.sell_vol_usd),
      n_buys: numOrNull(stored.n_buys),
      n_sells: numOrNull(stored.n_sells),
      usd_missing: numOrNull(stored.usd_missing),
    })
  } catch {
    return kvUnavailable()
  }
}
