"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express');
const {registerDataImportRoutes}=require('../lib/data-import-routes');
const {DATA_IMPORT_PERMISSIONS:P,DATA_IMPORT_PERMISSION_CATALOG,buildDataImportProjection}=require('../lib/data-import-access');
const {streamTradeFotoFullSource}=require('../lib/tradefoto-full-import-reader');
const UI=require('../public/data-import');
const MappingUI=require('../public/import-mappings');
const session=()=>({employeeNumber:'synthetic',accountId:'synthetic-account',permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
async function fixture(t) {
  const state={session:session(),calls:0,csrf:true,available:true,password:null},app=express();app.use(express.json({limit:'16kb'}));
  const runtime={context:async get=>({available:state.available,projection:buildDataImportProjection(await get())}),
    list:async get=>{await get();return {items:[]};},sourceOperation:async(get,_id,action,body)=>{await get();state.calls++;return {action,body};},
    upload:async(get,{buffer,password,onStarted})=>{await get();state.calls++;state.password=password;assert.ok(Buffer.isBuffer(buffer));onStarted({id:'a'.repeat(64),status:'reading'});buffer.fill(0);}};
  const mappings={operation:async(get,action,body)=>{await get();state.calls++;return {action,body};}};
  registerDataImportRoutes(app,{runtime,mappings,requireSession(_r,permission){if(!state.session)throw Object.assign(new Error('private'),{status:401});
    if(!state.session.permissions.includes(permission))throw Object.assign(new Error('private'),{status:403});return state.session;},
    refreshSession:async()=>state.session,assertCsrf(){if(!state.csrf)throw Object.assign(new Error('csrf-secret'),{status:403});}});
  const listener=app.listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));
  t.after(()=>new Promise(r=>listener.close(r)));
  const request=(url,options={})=>fetch(`http://127.0.0.1:${listener.address().port}${url}`,options);
  return {state,request};
}
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
test('Productive Block 1: real isolated reader reports malformed ACE files without leaking reader internals',async()=>{
  const buffer=Buffer.alloc(4096);buffer.write('Standard ACE DB',4);buffer[0x14]=3;
  await assert.rejects(streamTradeFotoFullSource({buffer,kind:'cash',onMessage:()=>{},timeoutMs:10000}),e=>/^IMPORT_/.test(e.code)&&!/SELECT|password/i.test(e.message));
});
test('Productive Block 1: preview markup escapes fields, exposes blocked counts, and cannot activate itself',()=>{
  const html=UI.renderSource({kind:'trade',fileSha256:'<script>secret</script>',status:'needs_review',tables:[{name:'<img>',declaredRows:2,run:{id:'a',receivedRows:1,status:'needs_review',counts:{invalid:1},gates:['SOURCE_ROW_COUNT_MISMATCH']}}],activationEnabled:false},{});
  assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/SOURCE_ROW_COUNT_MISMATCH/);assert.match(html,/data-i-action="apply" disabled/);
  const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert.match(app,/dataImportWorkspace\?\.destroy/);
  const ui=fs.readFileSync(path.join(__dirname,'../public/data-import.js'),'utf8');assert.doesNotMatch(ui,/localStorage|sessionStorage/);
  assert.match(ui,/visibilitychange/);assert.match(ui,/controller\?\.abort/);
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.equal(server.split('...DATA_IMPORT_PERMISSION_CATALOG').length-1,2);
  assert.match(server,/createDataImportRuntime\(\{[^}]*allowApply: false/);assert.match(server,/refreshSession: \(request\) => loadPortalSessionFromRequest\(request, \{ touch: false \}\)/);
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
