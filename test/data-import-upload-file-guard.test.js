'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const {registerDataImportRoutes}=require('../lib/data-import-routes');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
const {SOURCE_CATALOG,SOURCE_KINDS}=require('../lib/data-import-source-catalog');
const UI=require('../public/data-import');
const session=()=>({employeeNumber:'synthetic',accountId:'synthetic-account',permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
async function fixture(t){
 const state={session:session(),csrf:true,rawFactory:0,rawReader:0,context:0,begin:0,enqueue:0},app=express(),raw=express.raw;
 t.mock.method(express,'raw',(...args)=>{state.rawFactory++;const parser=raw(...args);return(...params)=>{state.rawReader++;return parser(...params);};});
 const routes=registerDataImportRoutes(app,{runtime:{context:async()=>{state.context++;return {available:true};}},jobs:{beginUpload(){state.begin++;return()=>{};},async enqueue(_get,{buffer,kind,fileName}){state.enqueue++;assert.equal(buffer.length,4096);state.accepted={kind,fileName};return {id:'source',status:'queued'};}},
  requireSession(_r,p){if(!state.session)throw Object.assign(new Error(),{status:401});if(!state.session.permissions.includes(p))throw Object.assign(new Error(),{status:403});return state.session;},refreshSession:async()=>state.session,assertCsrf(){if(!state.csrf)throw Object.assign(new Error(),{status:403});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await routes.stop();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url='http://127.0.0.1:'+server.address().port;
 async function headersOnly(kind,name){return new Promise((resolve,reject)=>{const req=http.request(url+'/api/data-import/upload/'+kind,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':512*1024*1024,'X-Import-File-Name':encodeURIComponent(name)}},res=>{let data='';res.setEncoding('utf8');res.on('data',b=>data+=b);res.on('end',()=>{resolve({httpStatus:res.statusCode,...JSON.parse(data)});req.destroy();});});req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('Early rejection waited for missing body')));req.flushHeaders();});}
 async function upload(kind,name){const headers={'Content-Type':'application/octet-stream'};if(name!==undefined)headers['X-Import-File-Name']=encodeURIComponent(name);const res=await fetch(url+'/api/data-import/upload/'+kind,{method:'POST',headers,body:Buffer.alloc(4096)});return {httpStatus:res.status,...await res.json()};}
 return {state,headersOnly,upload};
}
test('all nine exact unsupported filenames reject over real HTTP before any body or job admission',async t=>{
 const f=await fixture(t),blocked=SOURCE_CATALOG.filter(s=>!s.available);assert.equal(blocked.length,9);
 for(const source of blocked)for(const kind of SOURCE_KINDS){const r=await f.headersOnly(kind,source.fileName.toUpperCase());assert.equal(r.httpStatus,422,source.fileName);assert.equal(r.code,'IMPORT_SOURCE_UNSUPPORTED');assert.match(r.error,/kein Import angebunden/);}
 assert.deepEqual([f.state.rawFactory,f.state.rawReader,f.state.context,f.state.begin,f.state.enqueue],[0,0,0,0,0]);
});
test('each exact known supported filename rejects a different route before raw body reading',async t=>{
 const f=await fixture(t);for(const source of SOURCE_CATALOG.filter(s=>s.available))for(const other of SOURCE_KINDS.filter(kind=>kind!==source.kind)){const r=await f.headersOnly(other,source.fileName);assert.equal(r.httpStatus,422);assert.equal(r.code,'IMPORT_SOURCE_FILE_KIND_MISMATCH');}
 assert.deepEqual([f.state.rawFactory,f.state.rawReader,f.state.context,f.state.begin,f.state.enqueue],[0,0,0,0,0]);
});
test('authentication CSRF and whole-import rights still precede filename classification',async t=>{
 const f=await fixture(t);f.state.session=null;assert.equal((await f.headersOnly('trade','Shopware.accdb')).httpStatus,401);
 f.state.session=session();f.state.csrf=false;assert.equal((await f.headersOnly('trade','Shopware.accdb')).httpStatus,403);
 f.state.csrf=true;f.state.session.permissions=f.state.session.permissions.filter(p=>p!==P.PREPARE);assert.equal((await f.headersOnly('trade','Shopware.accdb')).httpStatus,403);
 assert.deepEqual([f.state.rawFactory,f.state.rawReader,f.state.context,f.state.begin,f.state.enqueue],[0,0,0,0,0]);
});
test('all six supported names custom names and missing legacy filename retain normal upload admission',async t=>{
 const f=await fixture(t);for(const source of SOURCE_CATALOG.filter(s=>s.available)){assert.equal((await f.upload(source.kind,source.fileName)).httpStatus,202);assert.equal(f.state.accepted.kind,source.kind);}
 for(const name of ['Eigener Export 2026.accdb','Shopware backup.accdb','Kopie meines Datenstands.accdb']){assert.equal((await f.upload('trade',name)).httpStatus,202);assert.equal(f.state.accepted.fileName,name);}
 assert.equal((await f.upload('trade',undefined)).httpStatus,202);assert.deepEqual([f.state.rawFactory,f.state.rawReader,f.state.begin,f.state.enqueue],[10,10,10,10]);assert.deepEqual(SOURCE_KINDS,['trade','cash','bestell','weum','inventur','lieferantenrechnungen']);
});
test('UI classification uses exact unsupported catalog names and retains existing recognized cross-kind protection',()=>{
 for(const source of SOURCE_CATALOG){assert.equal(UI.fileSelectionIssue(source.fileName,source.kind,SOURCE_CATALOG),source.available?null:'IMPORT_SOURCE_UNSUPPORTED');if(source.available)assert.equal(UI.fileSelectionIssue(source.fileName,source.kind==='trade'?'cash':'trade',SOURCE_CATALOG),'IMPORT_SOURCE_FILE_KIND_MISMATCH');}
 for(const name of ['Eigener Export.accdb','Shopware backup.accdb','RIO Sicherung.accdb'])assert.equal(UI.fileSelectionIssue(name,'trade',SOURCE_CATALOG),null);
 assert.equal(UI.fileSelectionIssue('Trade_DatenBestell Kopie.accdb','trade',SOURCE_CATALOG),'IMPORT_SOURCE_FILE_KIND_MISMATCH');
});
test('actual UI submit rejects known unsupported and cross-kind files before preferences or upload requests',async t=>{
 const handlers={},requests=[],names=['next','sources','detail','message','log','stop','form','file','kind','kind-hint','upload-title','password','file-name','upload','overview','upload-timeout','upload-timeout-status'];
 const fields=Object.fromEntries(names.map(name=>[name,{hidden:true,innerHTML:'',textContent:'',value:name==='kind'?'trade':name==='upload-timeout'?'30':'',files:[],disabled:false,querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false,replaceChildren(){},setAttribute(){},removeAttribute(){},scrollIntoView(){},focus(){}}]));
 const body={innerHTML:'',querySelector:s=>fields[/data-i="([^"]+)"/.exec(s)?.[1]],addEventListener:(name,fn)=>handlers[name]=fn,removeEventListener(){},replaceChildren(){}},root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
 const view=UI.mount(root,{api:async(url,options={})=>{requests.push({url,method:options.method||'GET'});if(url.endsWith('/context'))return {available:true,projection:{read:true,prepare:true},sourceCatalog:SOURCE_CATALOG,maxBytes:512*1024*1024,backgroundEnabled:true};if(url.endsWith('/sources/search'))return {items:[],next:null};if(url.endsWith('/sources/overview'))return {items:[],complete:true};throw Error('Rejected file unexpectedly performed a request: '+url);}});t.after(()=>view.destroy());await new Promise(r=>setImmediate(r));
 for(const kind of SOURCE_KINDS)for(const source of SOURCE_CATALOG.filter(s=>!s.available||s.kind!==kind)){fields.kind.value=kind;fields.file.files=[{name:source.fileName,size:4096}];const before=requests.length;await handlers.submit({target:fields.form,preventDefault(){}});assert.equal(requests.length,before);assert.match(fields.message.textContent,source.available?/anderen Datenbank/:/kein Import angebunden/);}
 assert.equal(requests.some(r=>r.method!=='GET'&&!r.url.endsWith('/sources/search')),false);
});
