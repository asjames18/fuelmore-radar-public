import type { HistoryPoint } from './types'
export type ChartRange = '1D' | '7D' | '30D' | 'ALL'
/**
 * The market collector runs on a 15-minute cadence. When two consecutive
 * observations are farther apart than this, the collector went quiet for at
 * least three slots — insert a null break point between them so the chart
 * drops the line instead of drawing a straight segment across missing
 * observations. A straight line across a gap would imply the radar knows
 * what happened in between; a visible break is honest about not knowing.
 */
export const MAX_POINT_GAP_MS = 45 * 60 * 1000
const nullPoint = (at: number): HistoryPoint => ({
  at,
  fuelPrice: null,
  morePrice: null,
  fuelLiquidity: null,
  moreLiquidity: null,
})
export function marketComparison(history: HistoryPoint[], range: ChartRange) {
  const ordered = [...history].sort((a,b)=>a.at-b.at)
  const latest = ordered.at(-1)?.at ?? 0
  const days = range === 'ALL' ? Infinity : Number.parseInt(range)
  const ranged = ordered.filter(p=>p.at >= latest-days*86_400_000)
  const windowed: HistoryPoint[] = []
  for (const p of ranged) {
    const prev = windowed.at(-1)
    if (prev && p.at - prev.at > MAX_POINT_GAP_MS) {
      windowed.push(nullPoint(Math.floor((prev.at + p.at) / 2)))
    }
    windowed.push(p)
  }
  // Both tokens start at the SAME observation. A zero/missing baseline is unusable.
  const base = windowed.find(p=>p.fuelPrice !== null && p.fuelPrice>0 && p.morePrice !== null && p.morePrice>0)
  return { base, points: windowed.map(p=>({
    ...p,
    fuelChange: base && p.at>=base.at && p.fuelPrice!==null ? (p.fuelPrice/base.fuelPrice!-1)*100 : null,
    moreChange: base && p.at>=base.at && p.morePrice!==null ? (p.morePrice/base.morePrice!-1)*100 : null,
  })) }
}
