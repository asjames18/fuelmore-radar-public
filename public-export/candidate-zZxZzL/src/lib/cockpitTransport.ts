/** Pace wallet inventory reads below the 600/min gateway limit, including retries.
 * One scheduler is shared by inventory + reward clients; no wallet data is cached.
 */
function pause(ms:number, signal?:AbortSignal|null) {
 signal?.throwIfAborted()
 return new Promise<void>((resolve,reject)=>{
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve()}
  const timer=setTimeout(finish,Math.max(0,ms))
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason ?? new Error('Cancelled'))}
  signal?.addEventListener('abort',abort,{once:true})
 })
}
export function createCockpitFetch(fetcher:typeof fetch=(...args)=>fetch(...args)) : typeof fetch {
 let next=0, cooldown=0
 let queue=Promise.resolve()
 async function acquire(signal?:AbortSignal|null) {
  const turn=queue.then(async()=>{
   while(Math.max(next,cooldown)>Date.now())await pause(Math.max(next,cooldown)-Date.now(),signal)
   signal?.throwIfAborted();next=Date.now()+200
  })
  queue=turn.catch(()=>{})
  await turn
 }
 return async(input,init)=>{
  const signal=init?.signal ?? (input instanceof Request?input.signal:undefined)
  for(let attempt=0;;attempt++) {
   await acquire(signal)
   let response:Response
   try { response=await fetcher(input,init) }
   catch(error) {
    signal?.throwIfAborted()
    if(attempt>=2)throw error
    cooldown=Math.max(cooldown,Date.now()+1000*2**attempt)
    continue
   }
   const retry=response.status===429 || [502,503,504].includes(response.status)
   if(!retry || attempt>=2)return response
   const header=response.headers.get('Retry-After')
   const seconds=header===null?NaN:Number(header)
   const requested=header===null?NaN:Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now()
   // Long server cooldowns are returned intact instead of being shortened.
   if(Number.isFinite(requested) && requested>65000)return response
   const delay=Math.max(response.status===429?60000:1000*2**attempt,Number.isFinite(requested)?requested:0)
   cooldown=Math.max(cooldown,Date.now()+delay)
   await response.body?.cancel()
  }
 }
}
export const cockpitFetch=createCockpitFetch()
