import { expect, it } from 'vitest'
import { marketComparison } from './marketComparison'
const point=(at:number,fuelPrice:number|null,morePrice:number|null)=>({at,fuelPrice,morePrice,fuelLiquidity:1000,moreLiquidity:200})
it('compares different price scales from one shared baseline',()=>{
 const result=marketComparison([point(1,0.01,0.00001),point(2,0.02,0.000005)],'ALL')
 expect(result.points[0].fuelChange).toBe(0)
 expect(result.points[1].fuelChange).toBe(100)
 expect(result.points[1].moreChange).toBe(-50)
 expect(result.points[1].moreLiquidity).toBe(200)
})
it('does not invent baselines or bridge unavailable price observations',()=>{
 const result=marketComparison([point(1,0.01,null),point(2,0,0.01),point(3,0.02,0.01),point(4,null,0.02)],'ALL')
 expect(result.base?.at).toBe(3)
 expect(result.points[0].fuelChange).toBeNull()
 expect(result.points[1].fuelChange).toBeNull()
 expect(result.points[3].fuelChange).toBeNull()
 expect(result.points[3].moreChange).toBe(100)
})
it('filters the selected window and rebases both tokens together without mutating history',()=>{
 const input=[point(200000000,2,2),point(1,1,1)]
 const result=marketComparison(input,'1D')
 expect(result.points).toHaveLength(1)
 expect(result.points[0].fuelChange).toBe(0)
 expect(input[0].at).toBe(200000000)
})
it('breaks the series across collection gaps instead of bridging missing observations',()=>{
 const gap = 46*60*1000
 const result=marketComparison([point(0,0.01,0.00001),point(gap,0.02,0.000005)],'ALL')
 expect(result.points).toHaveLength(3)
 const [first,brk,last]=result.points
 expect(brk.at).toBe(gap/2)
 expect(brk.fuelPrice).toBeNull()
 expect(brk.morePrice).toBeNull()
 expect(brk.fuelLiquidity).toBeNull()
 expect(brk.fuelChange).toBeNull()
 expect(brk.moreChange).toBeNull()
 // Neighbor points are untouched and the base is still a real observation.
 expect(first.fuelChange).toBe(0)
 expect(last.fuelChange).toBe(100)
 expect(result.base?.at).toBe(0)
})
it('does not break the series for one or two missed collection slots',()=>{
 const twoMisses = 45*60*1000
 const result=marketComparison([point(0,0.01,0.00001),point(twoMisses,0.02,0.000005)],'ALL')
 expect(result.points).toHaveLength(2)
})
it('breaks multiple gaps independently',()=>{
 const gap = 60*60*1000
 const result=marketComparison([point(0,1,1),point(gap,2,2),point(gap*2,3,3)],'ALL')
 expect(result.points).toHaveLength(5)
 expect(result.points[1].fuelPrice).toBeNull()
 expect(result.points[3].fuelPrice).toBeNull()
 expect(result.points.map(p=>p.at)).toEqual([0,gap/2,gap,gap+gap/2,gap*2])
})
it('reports the earliest observation of the selected window',()=>{
 const day=86_400_000
 const input=[point(0,0.01,0.00001),point(day,0.02,0.00002),point(2*day,0.03,0.00003)]
 // 7D keeps all three days; earliest is the first real observation, not a null break point.
 expect(marketComparison(input,'7D').earliestAt).toBe(0)
 // 1D keeps only the last 24h of the window.
 expect(marketComparison(input,'1D').earliestAt).toBe(day)
 expect(marketComparison(input,'ALL').earliestAt).toBe(0)
 expect(marketComparison([],'ALL').earliestAt).toBeNull()
})
