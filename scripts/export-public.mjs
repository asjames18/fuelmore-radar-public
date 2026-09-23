import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root=fileURLToPath(new URL('..',import.meta.url))
const owner=await readFile(join(root,'src/lib/owner.ts'),'utf8')
const privateAddresses=[...owner.matchAll(/0x[0-9a-f]{40}/gi)].map(m=>m[0].toLowerCase())
const base=join(root,'public-export');await mkdir(base,{recursive:true})
const output=await mkdtemp(join(base,'candidate-'))
const excluded=/^(src\/(main\.tsx|main\.public\.tsx|lib\/owner(?:\.test)?\.ts|components\/(OwnerCockpit|FuelPlanner|SourceHealth|RiskPanel|AnalyticsPanel)(?:\.test)?\.tsx))$/
const manifest={schemaVersion:1,version:JSON.parse(await readFile(join(root,'package.json'))).version,files:{}}
async function put(path,content) {
 if(privateAddresses.some(address=>content.toLowerCase().includes(address)) || /alch_[A-Za-z0-9_-]{12,}/.test(content))throw new Error(`Private content in ${path}`)
 await mkdir(dirname(join(output,path)),{recursive:true});await writeFile(join(output,path),content)
 manifest.files[path]=createHash('sha256').update(content).digest('hex')
}
async function copyTree(path) {
 for(const entry of await readdir(join(root,path),{withFileTypes:true})) {
  if(entry.name.startsWith('.') || entry.isSymbolicLink())continue
  const file=join(path,entry.name)
  if(excluded.test(file))continue
  if(entry.isDirectory())await copyTree(file)
  else await put(file,await readFile(join(root,file),'utf8'))
 }
}
await copyTree('src');await copyTree('server');await copyTree('docs/provenance')
for(const path of ['index.html','package-lock.json','tsconfig.json','tsconfig.app.json','tsconfig.node.json','eslint.config.js','.env.example','scripts/dev.mjs','scripts/check-rpc.mjs'])await put(path,await readFile(join(root,path),'utf8'))
await put('src/main.tsx',await readFile(join(root,'src/main.public.tsx'),'utf8'))
await put('scripts/dev.mjs',(await readFile(join(root,'scripts/dev.mjs'),'utf8')).replace("['node_modules/vite/bin/vite.js']","['node_modules/vite/bin/vite.js','--mode','public']"))
for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md'])await put(name,await readFile(join(root,'release/public',name),'utf8'))
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
pkg.private=false;pkg.license='MIT';pkg.scripts.build='tsc -b && vite build --mode public';pkg.scripts.preview='vite preview --mode public';delete pkg.scripts['build:public'];delete pkg.scripts['dev:public'];delete pkg.scripts['export:public'];delete pkg.scripts['sync:core'];delete pkg.scripts['test:core'];pkg.scripts.test=pkg.scripts.test.replace(' && npm run test:core','')
await put('package.json',JSON.stringify(pkg,null,2)+'\n')
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));lock.packages[''].license='MIT'
await put('package-lock.json',JSON.stringify(lock,null,2)+'\n')
let notices='Dependency notices from package-lock.json and installed packages\n'
for(const [path,entry] of Object.entries(lock.packages)) {
 if(!path)continue
 notices+=`\n## ${path} ${entry.version ?? ''}\nLicense: ${entry.license ?? 'See original package'}\n`
 for(const name of await readdir(join(root,path)).catch(()=>[]))if(/^(licen[sc]e|copying|notice)(\.|$)/i.test(name)) {
  const content=await readFile(join(root,path,name),'utf8').catch(()=>null)
  if(content)notices+=`\n${name}\n${content}\n`
 }
}
await put('public/third-party-licenses.txt',notices)
await put('.gitignore','node_modules\ndist-public\n.env\n.env.*\n!.env.example\n.dev.vars*\n.wrangler\n.radar-data\n*.tsbuildinfo\n._*\n')
let vite=await readFile(join(root,'vite.config.ts'),'utf8')
vite=vite.replace("html.replace('/src/main.tsx', '/src/main.public.tsx')",'html')
await put('vite.config.ts',vite)
await put('.github/workflows/ci.yml', `name: Verify public source
on: [push, pull_request]
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run lint
      - run: npm run build
`)
await put('wrangler.jsonc',JSON.stringify({name:'fuelmore-radar-public',main:'server/worker.mjs',compatibility_date:'2026-09-15',triggers:{crons:['*/15 * * * *']},ratelimits:[{name:'RPC_RATE_LIMITER',namespace_id:'46631902',simple:{limit:600,period:60}}],kv_namespaces:[{binding:'ACTIVITY',id:'REPLACE_WITH_PUBLIC_KV_ID'},{binding:'COCKPIT_CACHE',id:'efbf0ca8482f4ec487a23974a66c170a'}],d1_databases:[{binding:'DB',database_id:'e30ac5d4-9f16-4d29-82f0-c4bf48befeee'}],assets:{directory:'./dist-public',binding:'ASSETS',not_found_handling:'single-page-application',run_worker_first:['/rpc*','/api/*']}},null,2)+'\n')
await writeFile(join(output,'public-core-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(`Public candidate prepared: ${output}`)
