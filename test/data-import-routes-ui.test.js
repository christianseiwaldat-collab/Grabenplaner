"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express');
const {registerDataImportRoutes}=require('../lib/data-import-routes');
const {DATA_IMPORT_PERMISSIONS:P,DATA_IMPORT_PERMISSION_CATALOG,buildDataImportProjection}=require('../lib/data-import-access');
const {streamTradeFotoFullSource}=require('../lib/tradefoto-full-import-reader');
const UI=require('../public/data-import');
const MappingUI=require('../public/import-mappings');
const session=()=>({employeeNumber:'synthetic',accountId:'synthetic-account',permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
test('shutdown drains upload work after HTTP 202, blocks admission and records only sanitized errors',async t=>{
  const {createDataImportLifecycle}=require('../lib/data-import-lifecycle');
  const {DataImportError}=require('../lib/data-import-contract');
  const lifecycle=createDataImportLifecycle(),app=express(),logged=[];
  let release,saved=false,bytes;
  const checkpoint=new Promise(r=>release=r);
  const runtime={context:async()=>({available:true}),upload:async(_get,{buffer,onStarted})=>lifecycle.run(async signal=>{
    bytes=buffer;onStarted({id:'b'.repeat(64),status:'reading'});
    await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});
    await checkpoint;saved=true;throw new DataImportError('IMPORT_SOURCE_INTERRUPTED',409);
  })};
  const routes=registerDataImportRoutes(app,{runtime,lifecycle,onBackgroundError:code=>logged.push(code),requireSession:session,refreshSession:session,assertCsrf:()=>{}});
  const listener=app.listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));
  t.after(async()=>{release();await routes.stop();await new Promise(r=>listener.close(r));});
  const upload=()=>fetch(`http://127.0.0.1:${listener.address().port}/api/data-import/upload/trade`,{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(4096,3)});
  const response=await upload();assert.equal(response.status,202);await response.json();
  let drained=false;const stopping=routes.stop().then(()=>{drained=true;});
  await new Promise(r=>setImmediate(r));assert.equal(drained,false);assert.equal(saved,false);
  const rejected=await upload();assert.equal(rejected.status,503);assert.equal((await rejected.json()).code,'IMPORT_MAINTENANCE');
  release();await stopping;await new Promise(r=>setImmediate(r));
  assert.equal(saved,true);assert.ok(bytes.every(b=>b===0));assert.deepEqual(logged,['IMPORT_SOURCE_INTERRUPTED']);
});
async function fixture(t,{jobs=null}={}) {
  const state={session:session(),calls:0,csrf:true,available:true,password:null},app=express();app.use(express.json({limit:'16kb'}));
  const runtime={context:async get=>({available:state.available,projection:buildDataImportProjection(await get()),message:state.available?'ready':'Protected key unavailable'}),
    list:async get=>{await get();return {items:[]};},sourceOperation:async(get,_id,action,body)=>{await get();state.calls++;return {action,body};},
    upload:async(get,{buffer,kind,password,onStarted})=>{await get();state.calls++;state.kind=kind;state.password=password;assert.ok(Buffer.isBuffer(buffer));onStarted({id:'a'.repeat(64),status:'reading'});buffer.fill(0);}};
  const mappings={operation:async(get,action,body)=>{await get();state.calls++;return {action,body};}};
  registerDataImportRoutes(app,{runtime,mappings,jobs,requireSession(_r,permission){if(!state.session)throw Object.assign(new Error('private'),{status:401});
    if(!state.session.permissions.includes(permission))throw Object.assign(new Error('private'),{status:403});return state.session;},
    refreshSession:async()=>state.session,assertCsrf(){if(!state.csrf)throw Object.assign(new Error('csrf-secret'),{status:403});}});
  const listener=app.listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));
  t.after(()=>new Promise(r=>listener.close(r)));
  const request=(url,options={})=>fetch(`http://127.0.0.1:${listener.address().port}${url}`,options);
  return {state,request};
}

test('background upload acknowledges durable acceptance before any reader work and protects its controls',async t=>{
  let durable=false,admitted=false,held=false,released=false;
  const jobs={beginUpload(){admitted=true;held=true;return ()=>{held=false;released=true;};},
    async enqueue(get,{buffer}){assert.ok(held);assert.ok(Buffer.isBuffer(buffer));await get();durable=true;return {id:'a'.repeat(64),status:'queued',background:{status:'queued'}};},
    overlay:async source=>source,async action(get,id,action){await get();return {id,action};}};
  const f=await fixture(t,{jobs}),res=await f.request('/api/data-import/upload/trade',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(4096)});
  assert.equal(res.status,202);assert.equal((await res.json()).background.status,'queued');assert.ok(durable&&admitted&&released);assert.equal(f.state.calls,0);
  f.state.available=false;const context=await (await f.request('/api/data-import/context')).json();
  assert.equal(context.available,false);assert.equal(context.message,'Protected key unavailable');
  f.state.csrf=false;assert.equal((await f.request('/api/data-import/sources/'+ 'a'.repeat(64)+'/pause',{method:'POST'})).status,403);
  assert.equal((await f.request('/api/data-import/sources/'+ 'a'.repeat(64)+'/retry',{method:'POST'})).status,403);
});

test('background progress explains automatic retry without asking for another upload and escapes its error',()=>{
  const html=UI.renderSource({kind:'trade',status:'interrupted',error:'IMPORT_SOURCE_READ_TIMEOUT',tables:[],background:{status:'retrying',retries:1,maxRetries:3,nextAt:'2026-09-14T10:00:00.000Z',error:'<script>bad</script>'}},{prepare:true});
  assert.match(html,/kein erneuter Upload nötig/);assert.doesNotMatch(html,/Bitte denselben Dateistand erneut auswählen|<script>/);
  assert.match(html,/data-i-job="pause"/);
});

test('background takeover admission is a separate authenticated CSRF action, while its worker excludes interactive mutations',async t=>{
  let admitted=0;
  const jobs={async enqueueApply(get,id,input){await get();admitted++;return {id,background:{phase:'applying'},revision:input.expectedRevision};},
    async assertIdle(){throw Object.assign(new Error(),{code:'IMPORT_SOURCE_BUSY',status:409});}};
  const f=await fixture(t,{jobs}),url='/api/data-import/sources/'+'a'.repeat(64),options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:4})};
  assert.equal((await f.request(url+'/apply-background',options)).status,200);assert.equal(admitted,1);
  f.state.csrf=false;assert.equal((await f.request(url+'/apply-background',options)).status,403);assert.equal(admitted,1);
  f.state.csrf=true;assert.equal((await f.request(url+'/undo',options)).status,409);assert.equal(f.state.calls,0);
  const html=UI.renderSource({kind:'trade',status:'applying',currentStep:{table:'ARTIKEL_BILDER_V2',phase:'rechecking'},tables:[{name:'table',declaredRows:100,run:{receivedRows:100,status:'applying',counts:{applied:25},gates:[]}}],background:{phase:'applying',status:'applying'}},{prepare:true,apply:true});
  assert.match(html,/25 \/ 100 Zeilen/);assert.match(html,/Sie können den GP schließen/);assert.match(html,/Übernahme pausieren/);assert.match(html,/Prüfung wird vorbereitet/);
});
test('Productive Block 1: routes require personal company rights, CSRF and no-store, with no role-only grants',async t=>{
  const f=await fixture(t);let res=await f.request('/api/data-import/context');assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/no-store/);
  f.state.csrf=false;res=await f.request('/api/data-import/sources/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,403);
  f.state.session.isEmployee=false;assert.equal((await f.request('/api/data-import/context')).status,403);
  assert.ok(DATA_IMPORT_PERMISSION_CATALOG.every(p=>!p.eligibleRoles.includes('manager')&&!p.eligibleRoles.includes('it_admin')));
});
test('Productive Block 1: upload is authenticated before accepting large bodies and returns 202 with no credentials',async t=>{
  const f=await fixture(t),options={method:'POST',headers:{'Content-Type':'application/octet-stream','X-Import-Password':Buffer.from('Synthetisch-ä').toString('base64')},body:Buffer.alloc(4096)};
  const res=await f.request('/api/data-import/upload/cash',options);assert.equal(res.status,202);assert.equal(f.state.password,'Synthetisch-ä');
  assert.doesNotMatch(await res.text(),/Synthetisch|Password/);
  f.state.csrf=false;assert.equal((await f.request('/api/data-import/upload/cash',options)).status,403);assert.equal(f.state.calls,1);
  f.state.csrf=true;f.state.session.permissions=f.state.session.permissions.filter(p=>p!==P.PREPARE);
  assert.equal((await f.request('/api/data-import/upload/cash',options)).status,403);
});
test('Productive Block 1: wrong kinds, compression, MIME and missing vault cannot enter the reader',async t=>{
  const f=await fixture(t),send=(kind,headers={})=>f.request(`/api/data-import/upload/${kind}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',...headers},body:Buffer.alloc(4096)});
  assert.equal((await send('all')).status,422);assert.equal((await send('trade',{'Content-Encoding':'gzip'})).status,422);
  assert.equal((await send('trade',{'Content-Type':'text/plain'})).status,422);
  f.state.available=false;assert.equal((await send('cash')).status,503);assert.equal(f.state.calls,0);
});

test('Central imports: all three source kinds use the same protected upload route',async t=>{
  const f=await fixture(t),options={method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(4096)};
  for(const kind of ['cash','trade','bestell']) {
    const result=await f.request(`/api/data-import/upload/${kind}`,options);
    assert.equal(result.status,202);assert.equal(f.state.kind,kind);
    assert.deepEqual(await result.json(),{id:'a'.repeat(64),status:'reading'});
  }
  f.state.csrf=false;
  assert.equal((await f.request('/api/data-import/upload/bestell',options)).status,403);
  assert.equal(f.state.calls,3);
});
test('Productive Block 1: real isolated reader reports malformed ACE files without leaking reader internals',async()=>{
  const buffer=Buffer.alloc(4096);buffer.write('Standard ACE DB',4);buffer[0x14]=3;
  await assert.rejects(streamTradeFotoFullSource({buffer,kind:'cash',onMessage:()=>{},timeoutMs:10000}),e=>/^IMPORT_/.test(e.code)&&!/SELECT|password/i.test(e.message));
});

test('Central imports: the reader consumes owned upload bytes without detaching neighboring data',async()=>{
  const makeHeader=buffer=>{buffer.fill(0);buffer.write('Standard ACE DB',4);buffer[0x14]=3;return buffer;};
  const owned=makeHeader(Buffer.alloc(4096));
  const reading=streamTradeFotoFullSource({buffer:owned,kind:'bestell',consumeBuffer:true,onMessage:()=>{},timeoutMs:10000});
  assert.equal(owned.byteLength,0);
  await assert.rejects(reading,e=>/^IMPORT_/.test(e.code));
  const allocation=Buffer.alloc(4160,29),slice=makeHeader(allocation.subarray(32,4128));
  const slicedReading=streamTradeFotoFullSource({buffer:slice,kind:'bestell',consumeBuffer:true,onMessage:()=>{},timeoutMs:10000});
  assert.equal(slice.byteLength,4096);assert.ok(slice.every(byte=>byte===0));
  assert.ok(allocation.subarray(0,32).every(byte=>byte===29));
  assert.ok(allocation.subarray(4128).every(byte=>byte===29));
  await assert.rejects(slicedReading,e=>/^IMPORT_/.test(e.code));
});
test('Productive Block 1: preview markup escapes fields, exposes blocked counts, and cannot activate itself',()=>{
  const html=UI.renderSource({kind:'trade',fileSha256:'<script>secret</script>',status:'needs_review',tables:[{name:'<img>',declaredRows:2,run:{id:'a',receivedRows:1,status:'needs_review',counts:{invalid:1},gates:['SOURCE_ROW_COUNT_MISMATCH']}}],activationEnabled:false},{});
  assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/SOURCE_ROW_COUNT_MISMATCH/);assert.match(html,/data-i-action="apply" disabled/);
  const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert.match(app,/dataImportWorkspace\?\.destroy/);
  const ui=fs.readFileSync(path.join(__dirname,'../public/data-import.js'),'utf8');assert.doesNotMatch(ui,/localStorage|sessionStorage/);
  assert.match(ui,/visibilitychange/);assert.match(ui,/controller\?\.abort/);
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.equal(server.split('...DATA_IMPORT_PERMISSION_CATALOG').length-1,2);
  assert.match(server,/createDataImportRuntime\(\{[^}]*allowApply: true, sharedPayloads: true/);assert.match(server,/refreshSession: \(request\) => loadPortalSessionFromRequest\(request, \{ touch: false \}\)/);
});

test('compact cash preview shows full history and value verification without unsupported row undo or audit actions',()=>{
  const html=UI.renderSource({kind:'cash',storage:'cash-compact-v1',scope:'full',fileSha256:'a'.repeat(64),status:'ready',complete:true,
    verifiedRows:3,activationEnabled:false,tables:[{name:'Umsatz_KASSE',declaredRows:3,run:{id:'b'.repeat(64),receivedRows:3,status:'ready',counts:{},gates:[]}}]},
    {read:true,prepare:true,apply:true,undo:true});
  assert.match(html,/Gesamte Kassenhistorie · alle Zeiträume/);
  assert.match(html,/3 gespeicherte Zeilen vollständig zurückgelesen/);
  assert.match(html,/data-i-publish/);assert.doesNotMatch(html,/data-i-action="apply"/);
  assert.match(html,/data-i-rows=/);assert.doesNotMatch(html,/data-i-log=|data-i-undo-preview=/);
});
test('Productive Block 1: closing an account view cancels reads and ignores late private context',async()=>{
  let resolve;const wait=new Promise(r=>resolve=r),handlers={},body={textContent:'',querySelector:()=>null,replaceChildren(){this.textContent='';},addEventListener(){},removeEventListener(){}};
  const root={open:true,querySelector:()=>body,addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
  let signal;const ui=UI.mount(root,{api:(_url,options)=>{signal=options.signal;return wait;}});ui.destroy();assert.equal(signal.aborted,true);
  resolve({available:false,message:'private late response'});await new Promise(r=>setImmediate(r));assert.equal(body.textContent,'');
});

test('Productive Block 2: mapping endpoints retain authentication, CSRF and private response boundaries',async t=>{
  const f=await fixture(t);
  const get=await f.request('/api/data-import/mappings/context');assert.equal(get.status,200);assert.match(get.headers.get('cache-control'),/private, no-store/);
  const post=action=>f.request('/api/data-import/mappings/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({table:'KUNDEN'})});
  for(const action of ['search','targets','preview','apply','undo'])assert.equal((await post(action)).status,200);
  const before=f.state.calls;f.state.csrf=false;assert.equal((await post('apply')).status,403);assert.equal(f.state.calls,before);
  f.state.csrf=true;f.state.session.sessionKind='organization';assert.equal((await post('preview')).status,403);assert.equal(f.state.calls,before);
});

test('Productive Block 2: mapping UI escapes imported values and requires explicit decisions before confirming',()=>{
  const row={id:'source',revision:1,table:'KUNDEN',number:'000419',label:'<img onerror=secret>',customer:{firstName:'<script>secret</script>'},candidate:{id:'crm',revision:2,label:'Existing'},binding:null};
  const rows=MappingUI.renderRows([row]);assert.doesNotMatch(rows,/<img|<script/);assert.match(rows,/Sortierung der aktuellen Seite/);
  const editor=MappingUI.renderEditor(row,{write:true},false);assert.doesNotMatch(editor,/<img|<script/);assert.match(editor,/Nicht angegeben/);assert.doesNotMatch(editor, /data-m="type" required/);
  assert.match(editor,/Vorhandene CRM-Karte ausdrücklich verbinden/);assert.match(editor,/data-m="apply"[^>]*disabled/);
  const readOnly=MappingUI.renderEditor(row,{write:false},false);assert.doesNotMatch(readOnly,/data-m="edit"/);
  const source=fs.readFileSync(path.join(__dirname,'../public/import-mappings.js'),'utf8');assert.doesNotMatch(source,/localStorage|sessionStorage/);
  assert.match(source,/planHash: plan.planHash/);assert.match(source,/ticket === generation/);assert.match(source,/visibilitychange/);
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.match(server,/createDataImportMappingRuntime\(\{[^}]*allowMapping: false/);
  assert.match(server,/createManagedSalesHistoryRuntime\(\{[^}]*enabled: false/);
});

test('Productive Block 2: late mapping context is discarded after account view destruction',async()=>{
  let resolve;const response=new Promise(r=>resolve=r),handlers={};
  const body={textContent:'',querySelector:()=>null,replaceChildren(){this.textContent='';},addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
  const root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
  let signal;const ui=MappingUI.mount(root,{api:(_url,options)=>{signal=options.signal;return response;}});ui.destroy();assert.equal(signal.aborted,true);
  resolve({projection:{read:false},message:'private late data'});await new Promise(r=>setImmediate(r));assert.equal(body.textContent,'');
});

test('Productive Block 2: closing during context loading permits a fresh reopen without resurrecting the old reply',async()=>{
  for(const module of [MappingUI,require('../public/sales-history')]) {
    let resolve,calls=0;const pending=new Promise(r=>resolve=r),events={};
    const body={textContent:'',querySelector:()=>null,replaceChildren(){this.textContent='';},addEventListener(){},removeEventListener(){}};
    const root={open:true,querySelector:()=>body,addEventListener:(n,f)=>events[n]=f,removeEventListener:n=>delete events[n],removeAttribute(){}};
    const ui=module.mount(root,{api:()=>++calls===1?pending:Promise.resolve({available:false,projection:{read:false},message:'fresh context'})});
    root.open=false;events.toggle();root.open=true;events.toggle();await new Promise(r=>setImmediate(r));assert.equal(calls,2);
    const text=body.textContent;resolve({available:false,projection:{read:false},message:'obsolete private context'});await new Promise(r=>setImmediate(r));assert.equal(body.textContent,text);
    ui.destroy();assert.equal(body.textContent,'');
  }
});
