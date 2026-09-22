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
