import {expect,it} from 'vitest'
import {cockpitError} from './cockpitError'
it('distinguishes throttling, reorgs and unknown failures without leaking credentials',()=>{
 expect(cockpitError({cause:{status:429}})).toContain('one minute')
 expect(cockpitError(new Error('Snapshot changed; refresh cockpit'))).toContain('consistent snapshot')
 expect(cockpitError(new Error('Unexpected network'))).toContain('different network')
 expect(cockpitError(new Error('https://secret-provider/key'))).not.toContain('secret-provider')
})
