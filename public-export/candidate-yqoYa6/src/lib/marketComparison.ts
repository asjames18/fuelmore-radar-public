import type { HistoryPoint } from './types'
export type ChartRange = '1D' | '7D' | '30D' | 'ALL'
export function marketComparison(history: HistoryPoint[], range: ChartRange) {
  const ordered = [...history].sort((a,b)=>a.at-b.at)
  const latest = ordered.at(-1)?.at ?? 0
  const days = range === 'ALL' ? Infinity : Number.parseInt(range)
  const points = ordered.filter(p=>p.at >= latest-days*86_400_000)
  // Both tokens start at the SAME observation. A zero/missing baseline is unusable.
  const base = points.find(p=>p.fuelPrice !== null && p.fuelPrice>0 && p.morePrice !== null && p.morePrice>0)
  return { base, points: points.map(p=>({
    ...p,
    fuelChange: base && p.at>=base.at && p.fuelPrice!==null ? (p.fuelPrice/base.fuelPrice!-1)*100 : null,
    moreChange: base && p.at>=base.at && p.morePrice!==null ? (p.morePrice/base.morePrice!-1)*100 : null,
  })) }
}
