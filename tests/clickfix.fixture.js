// Real React + real browser, mocked DSH services/log only. No model request is made.
window.__fixture = { loads: [], views: [], beforematches: 0, toggles: 0, session: 'S' }
const event = (seq, type, data) => ({type:'event', event:{seq,type,time:seq*1000,data}})
function entriesFor(session) {
  return [event(1,'turn/start',{turn:1}), event(2,'user/message',{turn:1,content:[{type:'text',text:session+' USER PROMPT'}]}),
    event(3,'step/start',{turn:1,step:1}),
    event(10,'assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:session+' REASONING A'},{type:'text',text:session+' ANSWER A'}]}}),
    event(11,'step/start',{turn:1,step:2}),
    event(20,'assistant/message',{turn:1,step:2,message:{content:[{type:'text',text:session+' ANSWER B'}]}}),
    event(21,'turn/end',{turn:1})]
}
function record(session, step, seq) {
  return {observedBy:'host',identity:{id:`${session}:1:${step}:0`,sessionId:session,turn:1,step,attemptOrdinal:0},
    settlement:'message',settlementSeq:seq,route:{provider:'fixture',model:'fixture'},
    usage:{inputTokens:20,cacheReadTokens:1980,outputTokens:20},
    metrics:{promptTokens:2000,cacheHitRatio:0.99,chunkCount:3,textChars:10,reasoningChars:step===1?10:0,toolCallCount:0},
    request:{},tools:[],raw:{}}
}
window.__fixture.records = {S:[record('S',1,10),record('S',2,20)],T:[record('T',1,10),record('T',2,20)]}
window.__fixture.snapshots = {S:{entries:entriesFor('S'),hasMore:false},T:{entries:entriesFor('T'),hasMore:false}}
window.__fixture.faces = Object.fromEntries(['S','T'].map(session => [session, {
  eventSource:{getSnapshot:()=>window.__fixture.snapshots[session]},
  getSnapshot:()=>({hasMore:window.__fixture.snapshots[session].hasMore}),
  async loadThrough(seq) {window.__fixture.loads.push([session,seq]); await window.__fixture.loadHook?.(session,seq)},
}]))
window.fetch = async (url) => {
  const u = new URL(url)
  if (u.pathname.endsWith('/attempts')) {
    const id = u.searchParams.get('sessionId')
    return {ok:true, json:async()=>({sessionId:id,bricks:window.__fixture.records[id],endedTurns:[1],store:{blobs:0,bytes:0}})}
  }
  return {ok:false,status:404}
}
window.EventSource = class {addEventListener() {} close() {}}
const jsx = window.__testExternals['react/jsx-runtime'].jsx
window.__ModuleLoader__ = {load({factory}){window.__fixture.plugin=factory(id=>window.__testExternals[id])}}
window.__fixture.start = () => {
  const ctx = {
    get(name) {return name==='sessions' ? {binding(id){return {session:window.__fixture.faces[id]}}} : {events:{register(){return ()=>{}}}}},
    effect(){},
    slots:{inject(name,cb){cb()},register(options,Component){window.__fixture.Component=Component;return ()=>{}}},
  }
  window.__fixture.plugin.apply(ctx)
  window.__fixture.root = window.__ReactDOM.createRoot(document.querySelector('#dock'))
  window.__fixture.render = (session) => {window.__fixture.session=session;window.__fixture.root.render(jsx(window.__fixture.Component,{sessionId:session}))}
  window.__fixture.render('S')
}
window.__fixture.addRow = (step, part, text) => {
  const row=document.createElement('div'); row.className='row';row.dataset.chatTurn='1'; row.dataset.chatNodeKey=`${step===1?10:20}:assistant-step1:${step}`
  if (part) row.dataset.chatGroupPart=part
  row.textContent=text;return row
}
