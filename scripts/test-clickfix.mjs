/** Real Chromium + React regression suite; only DSH services and log data are fixtures. */
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const temporary=mkdtempSync(join(tmpdir(),'dsh-brick-clickfix-'))
const moduleBundle=join(temporary,'modules.js')
execFileSync(process.execPath,[join(root,'scripts/build-client-hotfix.mjs')],{env:{...process.env,DSH_TEST_BUNDLE:moduleBundle},stdio:'inherit'})
const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM?{executablePath:process.env.PLAYWRIGHT_CHROMIUM}:{}),args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'})
const errors=[], results=[]
page.on('pageerror',e=>errors.push(String(e)))
const check=(name,ok)=>{results.push({test:name,passed:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);assert.ok(ok,name)}
try {
await page.setContent(`<!DOCTYPE html><html><head><base href="http://brick.test/"><style>
body{margin:0;background:#151517;color:#e5e7eb;font-family:system-ui;--dsw-alias-state-business-primary:#38bdf8;--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#202026;--dsw-alias-label-primary:#eee}
#scroll{position:fixed;inset:50px 0 0;overflow:auto;--dsh-composer-height:80px}.row{margin-left:450px;width:720px;min-height:140px;padding:20px;box-sizing:border-box;background:#202026;margin-bottom:20px}
#spacer1{height:700px}#spacer2{height:1000px}#tail{height:2600px}
</style></head><body><div id="scroll" data-conversation-scroll><div id="spacer1"></div><div id="rows-a"><div class="row" data-chat-turn="1" data-chat-node-key="10:assistant-step1:1" data-chat-group-part="reasoning">A reasoning</div></div><div id="spacer2"></div><div id="rows-b"><div class="row" data-chat-turn="1" data-chat-node-key="20:assistant-step1:2" data-chat-group-part="response">B answer</div></div><div id="tail"></div></div><div id="dock"></div></body></html>`)
if (process.env.JUPYTERLAB_STATIC) {
  // Optional offline source for this environment's genuine React 18.2 runtime. Not shipped.
  await page.addScriptTag({content:`window.__wmods={};window.__wcache={};window.webpackChunk_jupyterlab_application_top=[];window.webpackChunk_jupyterlab_application_top.push=(a)=>Object.assign(__wmods,a[1]);window.__wreq=function(id){if(id===44914)return __wreq(96540);if(__wcache[id])return __wcache[id].exports;const m={exports:{}};__wcache[id]=m;__wmods[id](m,m.exports,__wreq);return m.exports;}`})
  for(const file of ['6540.51c00e890179a4832552.js','961.29c067b15a524e556eed.js','9085.5a959b5878e7afd8a878.js']) await page.addScriptTag({path:join(process.env.JUPYTERLAB_STATIC,file)})
  await page.addScriptTag({content:`window.__testExternals={'react':__wreq(96540),'react/jsx-runtime':__wreq(21020)};window.__ReactDOM=__wreq(22551)`})
} else {
  const react=dirname(require.resolve('react/package.json')), dom=dirname(require.resolve('react-dom/package.json'))
  await page.addScriptTag({path:join(react,'umd/react.production.min.js')})
  await page.addScriptTag({path:join(dom,'umd/react-dom.production.min.js')})
  const runtime=readFileSync(join(react,'cjs/react-jsx-runtime.production.min.js'),'utf8')
  await page.addScriptTag({content:`{const m={exports:{}};((module,exports,require)=>{${runtime}\n})(m,m.exports,()=>React);window.__testExternals={'react':React,'react/jsx-runtime':m.exports};window.__ReactDOM=ReactDOM;}`})
}
check('Real React 18 runtime with hooks',await page.evaluate(()=>__testExternals.react.version.startsWith('18.')&&typeof __testExternals.react.useEffect==='function'))
await page.addScriptTag({path:join(root,'tests/clickfix.fixture.js')})
await page.addScriptTag({path:join(root,'lib/client.js')})
await page.addScriptTag({path:moduleBundle})
await page.evaluate(()=>__fixture.start())
const brick=(step,session='S')=>page.locator(`[data-cache-badge-brick="${session}:1:${step}:0"][data-cache-badge-face="cache"]`)
const panel=()=>page.locator('[data-cache-badge-panel]')
const ready=()=>page.locator('[data-cache-badge-transcript-state="ready"]').waitFor()
const landed=()=>page.locator('[data-cache-badge-landed]')
await brick(1).waitFor();await page.waitForTimeout(300)
await page.evaluate(()=>document.querySelector('#scroll').scrollTop=2800)
const originalScroll=await page.evaluate(()=>document.querySelector('#scroll').scrollTop)
await brick(1).click();await ready()
check('Single click automatically opens conversation, not statistics',await panel().locator('[data-cache-badge-transcript="assistant"]').innerText()==='S ANSWER A')
check('Preview contains matching input and reasoning',(await panel().innerText()).includes('S USER PROMPT')&&(await panel().innerText()).includes('S REASONING A'))
check('Single click neither scrolls nor highlights main transcript',await page.evaluate(()=>document.querySelector('#scroll').scrollTop)===originalScroll&&await landed().count()===0)
check('Loaded preview makes no history request',await page.evaluate(()=>__fixture.loads.length)===0)
await panel().getByRole('button',{name:'close',exact:true}).click()
await brick(1).dblclick({delay:60});await landed().waitFor()
check('Double click closes preview',await panel().count()===0)
check('Double click marks exact step',await landed().getAttribute('data-chat-node-key')==='10:assistant-step1:1')
check('Double click actually moves conversation',await page.evaluate(()=>document.querySelector('#scroll').scrollTop)<1000)
check('Landing has visible accent',await page.evaluate(()=>getComputedStyle(document.querySelector('[data-cache-badge-landed]')).boxShadow)!=='none')
await page.waitForTimeout(1400)
check('Accent survives beyond the old 1.1 second limit',await landed().count()===1)
await brick(2).focus();await page.keyboard.press('Enter');await ready()
check('Enter opens matching preview',await panel().locator('[data-cache-badge-transcript="assistant"]').innerText()==='S ANSWER B')
await brick(2).focus();await page.keyboard.press('Shift+Enter');await landed().waitFor()
check('Shift+Enter locates without preview',await panel().count()===0&&await landed().getAttribute('data-chat-node-key')==='20:assistant-step1:2')
await brick(1).click();await ready();await page.getByRole('button',{name:'在主对话中定位'}).click();await landed().waitFor()
check('Preview button uses same locate path',await panel().count()===0&&await landed().getAttribute('data-chat-node-key')==='10:assistant-step1:1')
await page.evaluate(()=>{const p=document.querySelector('#rows-a');p.innerHTML='';const w=document.createElement('div');w.hidden='until-found';w.addEventListener('beforematch',()=>{__fixture.beforematches++;w.removeAttribute('hidden')});w.append(__fixture.addRow(1,'reasoning','Hidden reasoning'));p.append(w,__fixture.addRow(1,'response','Visible response'))})
await brick(1).dblclick({delay:40});await page.waitForTimeout(600)
check('Native beforematch is dispatched to hidden ancestor',await page.evaluate(()=>__fixture.beforematches)===1)
check('Declared hidden reasoning is not skipped for visible response',await landed().getAttribute('data-chat-group-part')==='reasoning')
await page.evaluate(()=>{document.querySelector('#rows-a').innerHTML='';setTimeout(()=>{const p=document.querySelector('#rows-a'),b=document.createElement('button'),w=document.createElement('div');b.dataset.turnProcess='1';b.setAttribute('aria-expanded','false');w.hidden=true;w.append(__fixture.addRow(1,'reasoning','Delayed reasoning'));b.addEventListener('click',()=>{__fixture.toggles++;b.setAttribute('aria-expanded','true');w.hidden=false});p.append(b,w)},850)})
await brick(1).dblclick({delay:40});await page.waitForTimeout(1600)
check('Disclosure arriving 850ms late is opened',await page.evaluate(()=>__fixture.toggles)===1&&await landed().count()===1)
// A response may mount before reasoning; it is not an exact beginning for a reasoning target.
await page.evaluate(()=>{const p=document.querySelector('#rows-a');p.innerHTML='';p.append(__fixture.addRow(1,'response','Response arrived first'));setTimeout(()=>p.prepend(__fixture.addRow(1,'reasoning','Reasoning arrived later')),600)})
await brick(1).dblclick({delay:40});await page.waitForTimeout(950)
check('Later reasoning mount is not replaced by earlier visible response',await landed().getAttribute('data-chat-group-part')==='reasoning')
// A stale in-flight navigation must not scroll after a newer brick is selected.
await page.evaluate(()=>{document.querySelector('#rows-a').innerHTML='';setTimeout(()=>document.querySelector('#rows-a').append(__fixture.addRow(1,'reasoning','Late cancelled row')),1200)})
await brick(1).dblclick({delay:40});await brick(2).click();await ready();await page.waitForTimeout(1400)
check('Newer single click cancels older asynchronous navigation',await landed().count()===0&&(await panel().innerText()).includes('S ANSWER B'))
// A stale preview must not replace the newer brick when old history finally arrives.
await panel().getByRole('button',{name:'close',exact:true}).click()
await page.evaluate(()=>{__fixture.saved=__fixture.snapshots.S;__fixture.snapshots.S={entries:__fixture.saved.entries.filter(x=>x.event.seq>=11),hasMore:true};__fixture.loadHook=()=>new Promise(r=>setTimeout(()=>{__fixture.snapshots.S=__fixture.saved;r()},1100))})
await brick(1).click();await page.waitForTimeout(380);await brick(2).click();await ready();await page.waitForTimeout(1500)
check('Late history read cannot replace newer preview',await panel().locator('[data-cache-badge-transcript="assistant"]').innerText()==='S ANSWER B')
await page.evaluate(()=>{__fixture.loadHook=undefined;__fixture.snapshots.S=__fixture.saved})
await panel().getByRole('button',{name:'close',exact:true}).click()
await page.evaluate(()=>document.querySelector('#rows-a').innerHTML='')
await brick(1).dblclick({delay:40});await page.locator('[data-cache-badge-notice="error"]').waitFor({timeout:7000})
check('Missing target never highlights adjacent step',await landed().count()===0)
check('Missing target reports a visible failure',(await page.locator('[data-cache-badge-notice="error"]').innerText()).includes('未找到'))
await page.evaluate(()=>__fixture.render('T'));await brick(2,'T').waitFor();await page.waitForTimeout(300)
await brick(2,'T').click();await ready()
check('Session switch binds preview to new session',await panel().locator('[data-cache-badge-transcript="assistant"]').innerText()==='T ANSWER B')
const eventChecks=await page.evaluate(async()=>{
 const nav=__brickModules('src/client/navigation.ts');const ev=(seq,type,data)=>({type:'event',event:{seq,type,data}})
 const entries=[ev(1,'turn/start',{turn:1}),ev(10,'assistant/attempt',{turn:1,step:1}),ev(20,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'SUCCESS'}]}})]
 const face={eventSource:{getSnapshot:()=>({entries,hasMore:false})},loadThrough:async()=>{}}
 const failed=nav.readTranscript(face,1,1,10,{exactAttempt:true,callIds:[]}),good=nav.readTranscript(face,1,1,20,{exactAttempt:true,callIds:[]})
 let window={entries:entries.slice(1),hasMore:true},loads=[]
 const paging={eventSource:{getSnapshot:()=>window},loadThrough:async(seq)=>{loads.push(seq);window={entries,hasMore:false}}}
 await nav.ensureTurnTranscriptLoaded(paging,{seq:10,turn:1})
 return {failed:failed.assistant,text:failed.text,success:good.text,future:nav.covers(face,100),empty:nav.covers({eventSource:{getSnapshot:()=>({entries:[],hasMore:false})}},1),turnPaged:loads[0]===9}
})
check('Failed attempt does not borrow successful retry text',eventChecks.failed==='attempt'&&eventChecks.text===''&&eventChecks.success==='SUCCESS')
check('Empty/future seq is not considered covered',!eventChecks.future&&!eventChecks.empty)
check('Preview loads actual turn start when settlement alone is loaded',eventChecks.turnPaged)
// Existing row kinds must continue to resolve exactly, independently of assistant steps.
const kinds=await page.evaluate(async()=>{
 const reveal=__brickModules('src/client/reveal.ts'),root=document.querySelector('#scroll');const answers=[]
 for (const [kind,key,extra] of [['tool-call','tool-callcall_TEST',{turn:1,step:1,callId:'call_TEST'}],['retry-chain','model-retryretry_TEST',{turn:1,step:1,retryId:'retry_TEST'}],['compaction','compactioncompact_TEST',{compactionId:'compact_TEST'}]]) {
  const row=document.createElement('div');row.className='row';row.dataset.chatNodeKey='10:'+key;root.append(row)
  const result=await reveal.revealBrick(root,{kind,...extra},{settleMs:0});answers.push(result.accuracy==='exact'&&result.element===row);row.remove()
 }
 return answers
})
check('Tool-call target still lands on its exact call',kinds[0])
check('Retry-chain target still lands on its exact retry row',kinds[1])
check('Compaction target still lands on its exact checkpoint row',kinds[2])
check('No unhandled browser error',errors.length===0)
console.log(`\n${results.length} checks passed (Chromium, React 18; mocked DSH services, NOT a live DSH instance).`)
if(process.env.DSH_TEST_REPORT) writeFileSync(process.env.DSH_TEST_REPORT,JSON.stringify({runtime:'Chromium + React 18; DSH service fixtures',results,errors},null,2))
} finally {await browser.close();rmSync(temporary,{recursive:true,force:true})}
