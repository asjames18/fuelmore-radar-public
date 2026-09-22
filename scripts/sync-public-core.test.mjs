import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
const script=fileURLToPath(new URL('./sync-public-core.mjs',import.meta.url))
const hash=value=>createHash('sha256').update(value).digest('hex')
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()
async function fixture(run) {
 const root=await mkdtemp(join(tmpdir(),'radar-core-')),source=join(root,'public'),target=join(root,'personal')
 await mkdir(join(source,'src'),{recursive:true});await mkdir(join(target,'src'),{recursive:true})
 for(const dir of [source,target]){git(dir,'init','-b','main');git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid')}
 git(source,'remote','add','origin','https://github.com/asjames18/fuelmore-radar-public.git')
 await writeFile(join(target,'src/main.tsx'),'personal entry\n')
 await writeFile(join(target,'src/App.tsx'),'shared v1\n')
 const release=async (version,text)=>{
  await writeFile(join(source,'src/main.tsx'),'public entry\n')
  await writeFile(join(source,'src/App.tsx'),text)
  await writeFile(join(source,'public-core-manifest.json'),JSON.stringify({schemaVersion:1,version,files:{'src/main.tsx':hash('public entry\n'),'src/App.tsx':hash(text)}}))
  git(source,'add','.');git(source,'commit','-m',version);git(source,'tag','v'+version)
  return git(source,'rev-parse','HEAD')
 }
 const call=(version,commit,apply=true)=>spawnSync(process.execPath,[script,source,'v'+version,commit,...(apply?['--apply']:[])],{cwd:target,encoding:'utf8'})
 try {await run({source,target,release,call})}finally{await rm(root,{recursive:true,force:true})}
}
it('pins the public release, previews upgrades, and updates shared code while preserving personal entry',()=>fixture(async({target,release,call})=>{
 const first=await release('0.1.0','shared v1\n')
 let result=call('0.1.0',first);assert.equal(result.status,0,result.stderr)
 let lock=JSON.parse(await readFile(join(target,'public-core.lock.json'),'utf8'))
 assert.equal(lock.commit,first);assert.deepEqual(Object.keys(lock.files),['src/App.tsx'])
 const second=await release('0.2.0','shared v2\n')
 result=call('0.2.0',second,false);assert.equal(result.status,0,result.stderr)
 assert.equal(await readFile(join(target,'src/App.tsx'),'utf8'),'shared v1\n')
 result=call('0.2.0',second);assert.equal(result.status,0,result.stderr)
 assert.equal(await readFile(join(target,'src/App.tsx'),'utf8'),'shared v2\n')
 assert.equal(await readFile(join(target,'src/main.tsx'),'utf8'),'personal entry\n')
 lock=JSON.parse(await readFile(join(target,'public-core.lock.json'),'utf8'));assert.equal(lock.commit,second)
}))
it('refuses a local shared-code edit without overwriting it or advancing the lock',()=>fixture(async({target,release,call})=>{
 const first=await release('0.1.0','shared v1\n');assert.equal(call('0.1.0',first).status,0)
 await writeFile(join(target,'src/App.tsx'),'local change\n')
 const second=await release('0.2.0','shared v2\n');const result=call('0.2.0',second)
 assert.notEqual(result.status,0);assert.match(result.stderr,/Local shared code differs/)
 assert.equal(await readFile(join(target,'src/App.tsx'),'utf8'),'local change\n')
 assert.equal(JSON.parse(await readFile(join(target,'public-core.lock.json'),'utf8')).commit,first)
}))
it('rejects a moved or incorrectly pinned tag before writing a lock',()=>fixture(async({target,release,call})=>{
 await release('0.1.0','shared v1\n');const result=call('0.1.0','0'.repeat(40))
 assert.notEqual(result.status,0);assert.match(result.stderr,/Release commit mismatch/)
 await assert.rejects(readFile(join(target,'public-core.lock.json')),e=>e.code==='ENOENT')
}))
it('rejects shared files omitted from a release manifest',()=>fixture(async({source,target,release,call})=>{
 await release('0.1.0','shared v1\n')
 await writeFile(join(source,'src/unlisted.ts'),'unlisted module\n')
 const manifest=JSON.parse(await readFile(join(source,'public-core-manifest.json'),'utf8'));manifest.version='0.2.0'
 await writeFile(join(source,'public-core-manifest.json'),JSON.stringify(manifest));git(source,'add','.');git(source,'commit','-m','incomplete manifest');git(source,'tag','v0.2.0')
 const result=call('0.2.0',git(source,'rev-parse','HEAD'))
 assert.notEqual(result.status,0);assert.match(result.stderr,/Manifest omits shared source/)
 await assert.rejects(readFile(join(target,'public-core.lock.json')),e=>e.code==='ENOENT')
}))
it('refuses symlinked local shared files before applying any change',()=>fixture(async({target,release,call})=>{
 const {symlink}=await import('node:fs/promises')
 const commit=await release('0.1.0','shared v1\n')
 await writeFile(join(target,'outside.ts'),'shared v1\n');await rm(join(target,'src/App.tsx'))
 await symlink(join(target,'outside.ts'),join(target,'src/App.tsx'))
 const result=call('0.1.0',commit)
 assert.notEqual(result.status,0);assert.match(result.stderr,/Symlink in managed path/)
 assert.equal(await readFile(join(target,'outside.ts'),'utf8'),'shared v1\n')
}))
it('applies added and removed shared modules across pinned releases',()=>fixture(async({source,target,release,call})=>{
 const first=await release('0.1.0','shared v1\n');assert.equal(call('0.1.0',first).status,0)
 const manifest=JSON.parse(await readFile(join(source,'public-core-manifest.json'),'utf8'))
 manifest.version='0.2.0';manifest.files['src/new.ts']=hash('new module\n')
 await writeFile(join(source,'src/new.ts'),'new module\n');await writeFile(join(source,'public-core-manifest.json'),JSON.stringify(manifest))
 git(source,'add','.');git(source,'commit','-m','add module');git(source,'tag','v0.2.0')
 let result=call('0.2.0',git(source,'rev-parse','HEAD'));assert.equal(result.status,0,result.stderr)
 assert.equal(await readFile(join(target,'src/new.ts'),'utf8'),'new module\n')
 manifest.version='0.3.0';delete manifest.files['src/new.ts']
 await rm(join(source,'src/new.ts'));await writeFile(join(source,'public-core-manifest.json'),JSON.stringify(manifest))
 git(source,'add','-A');git(source,'commit','-m','remove module');git(source,'tag','v0.3.0')
 result=call('0.3.0',git(source,'rev-parse','HEAD'));assert.equal(result.status,0,result.stderr)
 await assert.rejects(readFile(join(target,'src/new.ts')),e=>e.code==='ENOENT')
 assert.equal(await readFile(join(target,'src/main.tsx'),'utf8'),'personal entry\n')
}))
