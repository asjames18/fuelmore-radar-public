#!/usr/bin/env node
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {isUsableReport,REPORT_KEY} from './activity-edge.mjs'
import {d1Config,d1Get,d1Put} from './d1-publish.mjs'

export function storageConfig(env) {
 d1Config(env)
 return {key:REPORT_KEY}
}

/** Single scheduled writer; never expose this credential or mutation to browsers. */
export async function publishSnapshot(report,env) {
 const {key}=storageConfig(env)
 if(!isUsableReport(report,3600) || !/^0x[0-9a-f]{64}$/i.test(report.throughHash??'')) throw new Error('Complete current snapshot required for publication')
 const generated=Date.parse(report.generatedAt)
 if(generated>Date.now()+60000 || generated<report.throughTimestamp*1000) throw new Error('Invalid snapshot observation time')
 let previous
 try {
  const raw=await d1Get(env,key)
  if(raw) previous=JSON.parse(raw)
 }catch(err){console.error(`Storage snapshot read failed for ${key}:`,err?.message ?? err);throw new Error('Storage snapshot read failed; existing report retained')}
 if(previous?.chainId===4663 && /^\d+$/.test(previous.throughBlock??'') &&
   (BigInt(previous.throughBlock)>BigInt(report.throughBlock) || Date.parse(previous.generatedAt)>generated)) throw new Error('Storage contains a newer snapshot; publication withheld')
 try {
  await d1Put(env,key,JSON.stringify(report))
 }catch(err){console.error(`Storage publication failed for ${key}:`,err?.message ?? err);throw new Error('Storage publication was not confirmed; retry the validated snapshot')}
 return {ok:true,throughBlock:report.throughBlock,throughHash:report.throughHash,generatedAt:report.generatedAt}
}

async function main() {
 if(process.argv.includes('--check')){storageConfig(process.env);console.log('Storage publisher configuration present');return}
 const report=JSON.parse(await readFile(new URL('../.radar-data/fuel-activity.json',import.meta.url),'utf8'))
 console.log(JSON.stringify(await publishSnapshot(report,process.env)))
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch((err)=>{console.error(`Storage publication failed: ${err?.message ?? err}`);process.exitCode=1})
