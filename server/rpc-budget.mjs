// Per-isolate safeguards. Production also needs a distributed edge rate limit;
// these counters are intentionally not described as an account-wide quota.
export function createRpcBudget({maxConcurrent=12,unitsPerMinute=600,now=Date.now}={}) {
 const clients=new Map(), pending=new Map()
 let active=0
 return {
  admit(client,units) {
   const time=now()
   let record=clients.get(client)
   if (!record || time-record.start>=60000) {
    for (const [key,value] of clients) if(time-value.start>=60000) clients.delete(key)
    if (!record && clients.size>=5000) return false
    record={start:time,used:0};clients.set(client,record)
   }
   if(record.used+units>unitsPerMinute)return false
   record.used+=units;return true
  },
  async run(key,operation) {
   if(key && pending.has(key))return pending.get(key)
   if(active>=maxConcurrent)throw new Error('RPC gateway busy')
   active++
   const promise=Promise.resolve().then(operation).finally(()=>{active--;if(key)pending.delete(key)})
   if(key)pending.set(key,promise)
   return promise
  },
 }
}
export function validateReadBudget(items) {
 for(const item of items) {
  if(item.method==='eth_getLogs') {
   const filter=item.params?.[0]
   if(!filter || typeof filter!=='object')return 'Log filter required'
   if(filter.blockHash) {
    if(!/^0x[0-9a-f]{64}$/i.test(filter.blockHash) || filter.fromBlock!==undefined || filter.toBlock!==undefined)return 'Invalid block hash filter'
   } else {
    if(!/^0x[0-9a-f]+$/i.test(filter.fromBlock??'') || !/^0x[0-9a-f]+$/i.test(filter.toBlock??''))return 'Explicit log block range required'
    const from=BigInt(filter.fromBlock),to=BigInt(filter.toBlock)
    if(to<from || to-from>=2000n)return 'Maximum log range is 2000 blocks'
   }
  }
  if(item.method==='eth_feeHistory' && (!/^0x[0-9a-f]+$/i.test(item.params?.[0]??'') || BigInt(item.params[0])>100n))return 'Maximum fee history is 100 blocks'
 }
 return null
}
export function retryDelay(header,attempt,remaining,now=Date.now(),random=Math.random) {
 let delay=300*2**attempt+Math.floor(random()*150)
 if(header) {
  const seconds=Number(header)
  const requested=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-now
  if(Number.isFinite(requested))delay=Math.max(delay,requested)
 }
 return delay+250>=remaining?null:Math.max(0,delay)
}
export async function readLimitedBody(request, limit=65536) {
 if (Number(request.headers.get('content-length'))>limit) return null
 const reader=request.body?.getReader()
 if(!reader)return ''
 const decoder=new TextDecoder()
 let size=0,text=''
 try {
  while(true) {
   const {done,value}=await reader.read()
   if(done)return text+decoder.decode()
   size+=value.byteLength
   if(size>limit){await reader.cancel();return null}
   text+=decoder.decode(value,{stream:true})
  }
 } finally {reader.releaseLock()}
}
export async function fetchRpcWithinBudget(url,body) {
 const deadline=Date.now()+12000
 for(let attempt=0;attempt<3;attempt++) {
  const remaining=deadline-Date.now()
  if(remaining<=0)throw new Error('RPC deadline exceeded')
  // One deadline covers transport, response body and retry delays.
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body,signal:AbortSignal.timeout(remaining)})
  if(response.status===429 && attempt<2) {
   const delay=retryDelay(response.headers.get('Retry-After'),attempt,deadline-Date.now())
   if(delay!==null) {await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,delay));continue}
  }
  return {status:response.status,body:await response.json()}
 }
 throw new Error('RPC retry budget exceeded')
}
