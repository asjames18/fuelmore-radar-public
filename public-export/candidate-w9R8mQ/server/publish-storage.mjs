#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {isUsableReport,REPORT_KEY} from './activity-edge.mjs'

export function storageConfig(env) {
 const account=env.CLOUDFLARE_ACCOUNT_ID,namespace=env.CLOUDFLARE_KV_NAMESPACE_ID,token=env.CLOUDFLARE_API_TOKEN
 if(!/^[a-f0-9]{32}$/i.test(account??'') || !/^[a-f0-9]{32}$/i.test(namespace??'') || typeof token!=='string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid storage publisher configuration')
 return {url:`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${REPORT_KEY}`,token}
}

/** Single scheduled writer; never expose this credential or mutation to browsers. */
export async function publishSnapshot(report,env,request=fetch) {
 const {url,token}=storageConfig(env)
 if(!isUsableReport(report,3600) || !/^0x[0-9a-f]{64}$/i.test(report.throughHash??'')) throw new Error('Complete current snapshot required for publication')
 const generated=Date.parse(report.generatedAt)
 if(generated>Date.now()+60000 || generated<report.throughTimestamp*1000) throw new Error('Invalid snapshot observation time')
 const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'}
 let previous
 try {
  const response=await request(url,{method:'GET',headers,signal:AbortSignal.timeout(15000)})
  if(response.status!==404) {
   if(!response.ok)throw new Error()
   previous=await response.json()
  }
 }catch{throw new Error('Storage snapshot read failed; existing report retained')}
 if(previous?.chainId===4663 && /^\d+$/.test(previous.throughBlock??'') &&
   (BigInt(previous.throughBlock)>BigInt(report.throughBlock) || Date.parse(previous.generatedAt)>generated)) throw new Error('Storage contains a newer snapshot; publication withheld')
 try {
  const response=await request(url,{method:'PUT',headers,body:JSON.stringify(report),signal:AbortSignal.timeout(15000)})
  if(!response.ok || (await response.json()).success!==true)throw new Error()
 }catch{throw new Error('Storage publication was not confirmed; retry the validated snapshot')}
 return {ok:true,throughBlock:report.throughBlock,throughHash:report.throughHash,generatedAt:report.generatedAt}
}

async function main() {
 if(process.argv.includes('--check')){storageConfig(process.env);console.log('Storage publisher configuration present');return}
 const report=JSON.parse(await readFile(new URL('../.radar-data/fuel-activity.json',import.meta.url),'utf8'))
 console.log(JSON.stringify(await publishSnapshot(report,process.env)))
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{console.error('Storage publication failed; check publisher configuration and snapshot freshness');process.exitCode=1})
