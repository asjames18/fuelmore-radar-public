#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository='https://github.com/asjames18/fuelmore-radar-public.git'
const digest=value=>createHash('sha256').update(value).digest('hex')
const safePath=path=>typeof path==='string' && /^[a-zA-Z0-9_./-]+$/.test(path) && path.split('/').every(part=>part && part!=='.' && part!=='..')
const managed=path=>safePath(path) && (
  path.startsWith('server/') || path.startsWith('docs/provenance/') || path==='scripts/check-rpc.mjs' ||
  (path.startsWith('src/') && !/^src\/(main(?:\.public)?\.tsx|lib\/owner(?:\.test)?\.ts|components\/(OwnerCockpit|FuelPlanner|SourceHealth|RiskPanel|AnalyticsPanel)(?:\.test)?\.tsx)$/.test(path))
)
const git=(cwd,args,input)=>execFileSync('git',args,{cwd,input,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']})
async function localFile(root,path) {
  let current=root
  for(const part of path.split('/')) {
    current=join(current,part)
    const stat=await lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error})
    if(!stat)return null
    if(stat.isSymbolicLink())throw new Error('Symlink in managed path')
  }
  return readFile(current)
}
function releaseFiles(source,commit) {
  const bytes=git(source,['show',`${commit}:public-core-manifest.json`])
  const manifest=JSON.parse(bytes)
  if(manifest.schemaVersion!==1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.files || Array.isArray(manifest.files))throw new Error('Invalid public manifest')
  const files={}
  for(const path of Object.keys(manifest.files).sort()) {
    if(!safePath(path) || !/^[a-f0-9]{64}$/.test(manifest.files[path]))throw new Error('Invalid manifest file')
    // Validate even excluded entry/config files so the release manifest remains auditable.
    const mode=git(source,['ls-tree',commit,'--',path]).toString().split(' ')[0]
    if(mode!=='100644' && mode!=='100755')throw new Error('Non-regular release file')
    if(digest(git(source,['show',`${commit}:${path}`]))!==manifest.files[path])throw new Error('Release manifest hash mismatch')
    if(managed(path))files[path]=manifest.files[path]
  }
  const tracked=git(source,['ls-tree','-r','-z','--name-only',commit]).toString().split('\0').filter(Boolean)
  if(tracked.some(path=>managed(path) && !(path in files)))throw new Error('Manifest omits shared source')
  if(!Object.keys(files).length)throw new Error('Empty shared core')
  return {files,version:manifest.version,manifestSha256:digest(bytes)}
}

/** Vendor reviewed neutral source from a pinned public release; never import edition configuration. */
export async function syncPublicCore({source,target,ref,expectedCommit,apply=false}) {
  if(!/^v\d+\.\d+\.\d+$/.test(ref) || !/^[a-f0-9]{40}$/.test(expectedCommit))throw new Error('Supply a release tag and full commit SHA')
  source=await realpath(source);target=await realpath(target)
  if(await realpath(git(target,['rev-parse','--show-toplevel']).toString().trim())!==target)throw new Error('Run from the personal repository root')
  if(git(source,['remote','get-url','origin']).toString().trim()!==repository)throw new Error('Unexpected public repository')
  const commit=git(source,['rev-parse','--verify',`${ref}^{commit}`]).toString().trim()
  if(commit!==expectedCommit)throw new Error('Release commit mismatch')
  const next=releaseFiles(source,commit)
  if(ref!==`v${next.version}`)throw new Error('Release version mismatch')
  const lockPath='public-core.lock.json'
  const previousBytes=await localFile(target,lockPath)
  const previous=previousBytes?JSON.parse(previousBytes):null
  if(previous) {
    if(previous.schemaVersion!==1 || previous.repository!==repository || !/^[a-f0-9]{40}$/.test(previous.commit))throw new Error('Invalid core lock')
    const prior=releaseFiles(source,previous.commit)
    if(previous.manifestSha256!==prior.manifestSha256 || JSON.stringify(previous.files)!==JSON.stringify(prior.files))throw new Error('Core lock differs from previous release')
  }
  const expected=previous?.files ?? next.files
  for(const [path,hash]of Object.entries(expected)) {
    if(!managed(path))throw new Error('Invalid managed path')
    const value=await localFile(target,path)
    if(!value || digest(value)!==hash)throw new Error(`Local shared code differs: ${path}`)
  }
  for(const path of Object.keys(next.files)) {
    if(!(path in expected) && await localFile(target,path)!==null)throw new Error(`New shared path already exists: ${path}`)
  }
  const paths=[...new Set([...Object.keys(expected),...Object.keys(next.files)])]
  const patch=previous?git(source,['diff','--no-ext-diff','--no-textconv','--binary','--no-renames',previous.commit,commit,'--',...paths]):Buffer.alloc(0)
  if(patch.length)git(target,['apply','--check','--whitespace=nowarn','-'],patch)
  const lock={schemaVersion:1,repository,release:ref,commit,...next}
  if(apply) {
    // Stage the lock first; git apply is atomic unless explicitly asked for rejects.
    const temp=join(target,`${lockPath}.tmp`)
    await writeFile(temp,JSON.stringify(lock,null,2)+'\n',{flag:'wx'})
    let applied=false
    try {
      if(patch.length){git(target,['apply','--whitespace=nowarn','-'],patch);applied=true}
      await rename(temp,join(target,lockPath))
    } catch(error) {
      if(applied)git(target,['apply','--reverse','--whitespace=nowarn','-'],patch)
      throw error
    } finally { await rm(temp,{force:true}) }
  }
  return {release:ref,commit,managedFiles:Object.keys(next.files).length,changedFiles:paths.filter(path=>expected[path]!==next.files[path]).length,applied:apply}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [source,ref,expectedCommit,...flags]=process.argv.slice(2)
  if(!source || flags.some(flag=>flag!=='--apply')){console.error('Usage: sync-public-core.mjs PUBLIC_CHECKOUT TAG FULL_COMMIT_SHA [--apply]');process.exitCode=1}
  else syncPublicCore({source,target:process.cwd(),ref,expectedCommit,apply:flags.includes('--apply')})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error instanceof Error && error.message && !error.stderr?error.message:'Public core sync failed; no release accepted');process.exitCode=1})
}
