import {afterEach,expect,it,vi} from 'vitest'
import {createCockpitFetch} from './cockpitTransport'
afterEach(()=>vi.useRealTimers())
it('paces parallel reads below the gateway budget',async()=>{
 vi.useFakeTimers();const times:number[]=[]
 const request=createCockpitFetch(async()=>{times.push(Date.now());return new Response('{}')})
 const jobs=Promise.all(Array.from({length:8},()=>request('https://example.test')))
 await vi.runAllTimersAsync();await jobs
 expect(times.every((t,i)=>i===0||t-times[i-1]>=200)).toBe(true)
})
it('honors a rate-limit cooldown before retrying the same read',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status:429,headers:{'Retry-After':'60'}})).mockResolvedValue(new Response('{"result":"ok"}'))
 const request=createCockpitFetch(fetcher);const result=request('https://example.test')
 await vi.advanceTimersByTimeAsync(59999);expect(fetcher).toHaveBeenCalledTimes(1)
 await vi.advanceTimersByTimeAsync(201);expect((await result).status).toBe(200)
})
it('retries transient gateway errors but never retries rejected contract calls',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status:502})).mockResolvedValue(new Response('{"error":{"code":3}}'))
 const pending=createCockpitFetch(fetcher)('https://example.test');await vi.runAllTimersAsync()
 expect((await pending).status).toBe(200);expect(fetcher).toHaveBeenCalledTimes(2)
})
it('cancels during cooldown without issuing another read',async()=>{
 vi.useFakeTimers();const controller=new AbortController();const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:429,headers:{'Retry-After':'60'}}))
 const pending=createCockpitFetch(fetcher)('https://example.test',{signal:controller.signal});const assertion=expect(pending).rejects.toThrow()
 await vi.advanceTimersByTimeAsync(5);controller.abort();await assertion;expect(fetcher).toHaveBeenCalledTimes(1)
})
it('recovers a transient network failure with a bounded retry',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(new Response('{}'))
 const pending=createCockpitFetch(fetcher)('https://example.test');await vi.runAllTimersAsync()
 expect((await pending).status).toBe(200);expect(fetcher).toHaveBeenCalledTimes(2)
})
it('stops after three gateway failures instead of retrying forever',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockImplementation(async()=>new Response('{}',{status:503}))
 const pending=createCockpitFetch(fetcher)('https://example.test');await vi.runAllTimersAsync()
 expect((await pending).status).toBe(503);expect(fetcher).toHaveBeenCalledTimes(3)
})
