/** Give actionable context without exposing provider URLs or raw RPC payloads. */
export function cockpitError(error:unknown) {
 let current=error
 for(let i=0;i<8 && current && typeof current==='object';i++) {
  const e=current as {message?:string;status?:number;cause?:unknown}
  if(e.status===429)return 'The read service is busy. Wait one minute, then refresh. Your previous snapshot is preserved.'
  if(e.message?.startsWith('Snapshot changed'))return 'The chain snapshot changed during the scan. Refresh to read a new consistent snapshot.'
  if(e.message==='Unexpected network')return 'The RPC returned a different network. This lookup was stopped to protect data accuracy.'
  current=e.cause
 }
 return 'The read service could not complete this scan after retries. Please refresh; any previous snapshot is preserved.'
}
