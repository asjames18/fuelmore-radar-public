import type { RadarData } from './types'

export const DASHBOARD_KEY = 'dashboard-snapshot-v1'
export const DASHBOARD_MAX_AGE = 30 * 60_000
export const SOURCE_NAMES = ['Dexscreener markets', 'Blockscout contracts', 'FUEL holders', 'MORE holders', 'FUEL transfers', 'MORE transfers', 'Protocol RPC reads']
const protocolKeys = ['totalSupply','globalRank','activeMinters','totalStaked','activeStakes','amp','eaar','maxTermSeconds','fuelBurnt','moreBurnt','ethUsedFuelBurns','ethUsedMoreBurns','totalDistributed','vaultBalance','vaultSwept','vaultCycle','vaultCycleEnd']

export function encodeDashboard(data: RadarData): string {
  return JSON.stringify({ version: 1, chainId: 4663, data }, (_, value) => typeof value === 'bigint' ? value.toString() : value)
}

/** Accept only this version's aggregate dashboard shape; wallet data is never included. */
export function decodeDashboard(raw: string, now = Date.now()): RadarData | null {
  try {
    if (raw.length > 1_000_000) return null
    const { version, chainId, data } = JSON.parse(raw)
    const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60_000
    if (version !== 1 || chainId !== 4663 || !data || !time(data.updatedAt) || typeof data.partial !== 'boolean') return null
    if (!Array.isArray(data.sources) || data.sources.length !== SOURCE_NAMES.length || SOURCE_NAMES.some(name => data.sources.filter((s: {name: string}) => s?.name === name).length !== 1)) return null
    if (data.sources.some((s: {status: string; checkedAt: string; detail: string; attemptedAt?: string}) => !['available','partial','unavailable'].includes(s.status) || !time(s.checkedAt) || typeof s.detail !== 'string' || (s.attemptedAt !== undefined && !time(s.attemptedAt)))) return null
    if (!Array.isArray(data.pairs) || !Array.isArray(data.contracts) || !Array.isArray(data.activity) || !data.holders || !data.protocol) return null
    if (data.pairs.some((p: {symbol: string; pairAddress: string; tokenAddress: string}) => !p || !['FUEL','MORE'].includes(p.symbol) || typeof p.pairAddress !== 'string' || typeof p.tokenAddress !== 'string')) return null
    if (data.contracts.some((c: {address: string; key: string}) => !c || typeof c.address !== 'string' || typeof c.key !== 'string')) return null
    for (const symbol of ['FUEL','MORE']) {
      const h = data.holders[symbol]
      if (!h || !(h.totalHolders === null || Number.isFinite(h.totalHolders)) || !(h.topHolders === null || Array.isArray(h.topHolders))) return null
    }
    if (data.activity.some((a: {timestamp: string; hash: string; amount: number}) => !a || typeof a.hash !== 'string' || !time(a.timestamp) || !Number.isFinite(a.amount))) return null
    if (data.protocolObservation && (!/^\d+$/.test(data.protocolObservation.blockNumber) || !/^0x[0-9a-f]{64}$/i.test(data.protocolObservation.blockHash) || !/^\d+$/.test(data.protocolObservation.blockTimestamp))) return null
    if (Object.keys(data.protocol).length !== protocolKeys.length) return null
    for (const key of protocolKeys) {
      const value = data.protocol[key]
      if (value !== null && (typeof value !== 'string' || !/^\d{1,78}$/.test(value))) return null
      data.protocol[key] = value === null ? null : BigInt(value)
    }
    return data as RadarData
  } catch { return null }
}

/** Keep source groups atomic: never fill missing pinned RPC fields from another block. */
export function mergeDashboard(previous: RadarData | null, incoming: RadarData): RadarData {
  if (!previous) return incoming
  if (Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt)) return previous
  const next = { ...incoming, holders: {...incoming.holders}, sources: incoming.sources.map(s => ({...s})) }
  for (const source of next.sources) {
    const prior = previous.sources.find(s => s.name === source.name)
    if (source.status === 'available' || !prior || (prior.status !== 'available' && !prior.retained)) continue
    source.attemptedAt = source.checkedAt
    source.checkedAt = prior.checkedAt
    source.retained = true
    switch (source.name) {
      case 'Dexscreener markets': next.pairs = previous.pairs; break
      case 'Blockscout contracts': next.contracts = previous.contracts; break
      case 'FUEL holders': next.holders.FUEL = previous.holders.FUEL; break
      case 'MORE holders': next.holders.MORE = previous.holders.MORE; break
      case 'Protocol RPC reads': next.protocol = previous.protocol; next.protocolObservation = previous.protocolObservation; break
      default: {
        const symbol = source.name.split(' ')[0]
        next.activity = [...next.activity.filter(a => a.symbol !== symbol), ...previous.activity.filter(a => a.symbol === symbol)].sort((a,b) => Date.parse(b.timestamp)-Date.parse(a.timestamp))
      }
    }
  }
  next.partial = next.sources.some(s => s.status !== 'available' || s.retained)
  return next
}
