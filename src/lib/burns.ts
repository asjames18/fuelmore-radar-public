// Client for the FUEL buy-and-burn API. Served by the worker.

export type BurnDay = {
  date: string
  fuel: number | null
  eth: number | null
  drips: number | null
}

export type BurnsTotals = {
  fuel: number | null
  eth: number | null
  drips: number | null
}

export type BurnsResponse = {
  status: 'ok' | 'collecting'
  days: BurnDay[]
  totals: BurnsTotals
  methodology: string
  through_block: string | null
  through_time: string | null
}

export async function fetchBurns(): Promise<BurnsResponse> {
  const res = await fetch('/api/burns', { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return (await res.json()) as BurnsResponse
}
