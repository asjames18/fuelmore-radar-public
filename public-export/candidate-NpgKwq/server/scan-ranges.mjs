/** Bounded concurrent reads with contiguous, awaited checkpoint boundaries. */
export async function scanRanges({from,to,range,read,commit,concurrency=4,groupSize=100,deadline=Infinity,now=Date.now}) {
  if(typeof range!=='bigint' || range<1n || !Number.isInteger(concurrency) || concurrency<1 || concurrency>6 || !Number.isInteger(groupSize) || groupSize<1 || groupSize>100) throw new Error('Invalid scan scheduling configuration')
  for(let start=from;start<=to;) {
    if(now()>=deadline) throw new Error('Collector run budget exhausted; checkpoint retained')
    const ranges=[]
    let cursor=start
    while(cursor<=to && ranges.length<groupSize) {
      const end=cursor+range-1n<to?cursor+range-1n:to
      ranges.push([cursor,end]);cursor=end+1n
    }
    let next=0,failed=false,failure
    const results=new Array(ranges.length)
    await Promise.all(Array.from({length:Math.min(concurrency,ranges.length)},async()=>{
      while(next<ranges.length && !failed) {
        if(now()>=deadline){failed=true;failure=new Error('Collector run budget exhausted; checkpoint retained');break}
        const i=next++
        try {results[i]=await read(...ranges[i])}
        catch(error){failed=true;failure=error}
      }
    }))
    if(failed) throw failure
    if(now()>=deadline) throw new Error('Collector run budget exhausted; checkpoint retained')
    await commit({from:start,to:cursor-1n,logs:results.flat()})
    start=cursor
  }
}
