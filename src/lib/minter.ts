// Client for the minter-analytics API (FUEL only).
// Served by the worker; on preview it reads the preview KV namespace.

export type MinterRow = {
  wallet: string
  claimed: number | null
  sold: number | null
  bought: number | null
  pct_sold: number | null
  mints_opened: number | null
  remint_count: number | null
  remint_eth: number | null
  first_claim_ts: number | null
  first_sale_ts: number | null
  last_active_ts: number | null
}

export type MintersResponse = {
  status: 'ok' | 'collecting'
  count: number
  rows: MinterRow[]
  methodology: string
  through_block: string | null
  through_time: string | null
}

export type FlowEntry = {
  wallet: string
  fuel: number | null
  usd: number | null
}

export type DailyFlowsResponse = {
  status: 'ok' | 'collecting'
  date: string
  buyers: FlowEntry[]
  sellers: FlowEntry[]
  buy_vol_usd: number | null
  sell_vol_usd: number | null
  n_buys: number | null
  n_sells: number | null
  usd_missing: number | null
  note: string
  through_block: string | null
  through_time: string | null
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json()
}

export async function fetchMinters(
  sort = 'sold',
  dir: 'asc' | 'desc' = 'desc',
  limit = 100,
): Promise<MintersResponse> {
  const params = new URLSearchParams({ sort, dir, limit: String(limit) })
  const data = (await getJson(`/api/minters?${params}`)) as Partial<MintersResponse>
  if (!data || !Array.isArray(data.rows)) throw new Error('Unexpected minter response')
  return data as MintersResponse
}

export async function fetchDailyFlows(date?: string): Promise<DailyFlowsResponse> {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  const data = (await getJson(`/api/flows/daily${query}`)) as Partial<DailyFlowsResponse>
  if (!data || typeof data.date !== 'string') throw new Error('Unexpected flows response')
  return data as DailyFlowsResponse
}
