'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/data-import');
const {SOURCE_CATALOG}=require('../lib/data-import-source-catalog');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function mount(t,{minutes=30,prepare=true,save,upload,source}={}) {
  const fields=Object.fromEntries(['next','sources','detail','message','log','form','kind','kind-hint','file','password','file-name','upload','upload-title','upload-timeout','upload-timeout-status'].map(name=>[name,{
    hidden:true,innerHTML:'',textContent:'',value:'',files:[],disabled:false,dataset:{},hasAttribute:()=>false,querySelector:()=>null,replaceChildren(){},click(){},scrollIntoView(){},setAttribute(){},removeAttribute(){}
  }]));
  const handlers={},requests=[],body={innerHTML:'',querySelector:s=>fields[/data-i="([^"]+)"/.exec(s)?.[1]],addEventListener:(name,handler)=>handlers[name]=handler,removeEventListener(){},replaceChildren(){}};
  const root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
  const policy={minutes,minMinutes:1,maxMinutes:120},context={sourceCatalog:SOURCE_CATALOG,available:true,maxBytes:512*1024*1024,projection:{read:true,prepare},backgroundEnabled:true,uploadPolicy:policy};
  const api=async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/context'))return structuredClone(context);
    if(url.endsWith('/overview'))return{items:[],complete:true};
    if(url.endsWith('/sources/search'))return{items:[],next:null};
    if(url.endsWith('/preferences'))return save?save(options):{uploadPolicy:{...policy,minutes:JSON.parse(options.body).uploadTimeoutMinutes}};
    if(url.includes('/upload/'))return upload?upload(options):{id:'accepted'};
    if(source)return source();
    return{id:'accepted',kind:'cash',status:'queued',tables:[]};
  };
  const view=UI.mount(root,{api});t.after(()=>view.destroy());await tick();
  if(prepare)await handlers.click({target:{closest:()=>({dataset:{iUpload:'cash'},hasAttribute:()=>false})}});
  fields.file.files=[{name:'Kassen_Umsätze.accdb',size:338075648}];fields.file.value='selected.accdb';
  const submit=()=>handlers.submit({target:fields.form,preventDefault(){}}),change=()=>handlers.change({target:fields['upload-timeout']});
  return{fields,body,requests,view,submit,change};
}

test('personal server value loads with upload-only explanation and saves the edited minutes',async t=>{
  const f=await mount(t,{minutes:48});
  assert.equal(f.fields['upload-timeout'].value,'48');
  assert.match(f.body.innerHTML,/Upload-Zeitlimit \(Minuten\)/);
  assert.match(f.body.innerHTML,/min="1" max="120" step="1"/);
  assert.match(f.body.innerHTML,/nur für die Dateiübertragung; der Hintergrundimport läuft anschließend unabhängig weiter/);
  f.fields['upload-timeout'].value='65';await f.change();
  const saved=f.requests.filter(r=>r.url.endsWith('/preferences'));assert.equal(saved.length,1);
  assert.equal(saved[0].options.method,'PUT');assert.deepEqual(JSON.parse(saved[0].options.body),{uploadTimeoutMinutes:65});
  assert.equal(f.fields['upload-timeout'].disabled,false);assert.match(f.fields['upload-timeout-status'].textContent,/gespeichert/);
});

test('upload awaits an outstanding preference save and locks the control through acceptance',async t=>{
  const saving=deferred(),uploading=deferred(),f=await mount(t,{save:()=>saving.promise,upload:()=>uploading.promise});
  f.fields['upload-timeout'].value='90';const changing=f.change(),submitting=f.submit();await tick();
  assert.equal(f.fields['upload-timeout'].disabled,true);assert.equal(f.requests.filter(r=>r.url.includes('/upload/')).length,0);
  saving.resolve({uploadPolicy:{minutes:90,minMinutes:1,maxMinutes:120}});await changing;await tick();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/preferences')).length,1);assert.equal(f.requests.filter(r=>r.url.includes('/upload/')).length,1);
  assert.equal(f.fields['upload-timeout'].disabled,true);uploading.resolve({id:'accepted'});await submitting;
  assert.equal(f.fields['upload-timeout'].disabled,false);assert.equal(f.fields.file.value,'');
});

test('submit persists a valid edit without a change event; invalid or failed saves send no upload',async t=>{
  const valid=await mount(t);valid.fields['upload-timeout'].value='120';await valid.submit();
  const actions=valid.requests.filter(r=>r.url.endsWith('/preferences')||r.url.includes('/upload/'));
  assert.deepEqual(actions.map(r=>r.url),['/api/data-import/preferences','/api/data-import/upload/cash']);
  assert.deepEqual(JSON.parse(actions[0].options.body),{uploadTimeoutMinutes:120});
  for(const value of ['','0','1.5','121']){
    const f=await mount(t);f.fields['upload-timeout'].value=value;await f.submit();
    assert.equal(f.requests.filter(r=>r.url.includes('/upload/')||r.url.endsWith('/preferences')).length,0);
    assert.match(f.fields.message.textContent,/1 bis 120 ganzen Minuten/);assert.equal(f.fields.file.value,'selected.accdb');f.view.destroy();
  }
  const f=await mount(t,{save:()=>{throw new Error('Speichern fehlgeschlagen');}});f.fields['upload-timeout'].value='120';await f.submit();
  assert.equal(f.requests.filter(r=>r.url.endsWith('/preferences')).length,1);assert.equal(f.requests.filter(r=>r.url.includes('/upload/')).length,0);
  assert.match(f.fields.message.textContent,/Speichern fehlgeschlagen/);assert.equal(f.fields.file.value,'selected.accdb');assert.equal(f.fields['upload-timeout'].disabled,false);
});

test('HTTP 408 retains the chosen file and explains the upload limit; later status failure does not ask for another upload',async t=>{
  const error=()=>Object.assign(new Error('Aktion fehlgeschlagen (HTTP 408).'),{status:408});
  const f=await mount(t,{upload:()=>{throw error();}});const selected=f.fields.file.files[0];await f.submit();
  assert.equal(f.fields.file.files[0],selected);assert.equal(f.fields.file.value,'selected.accdb');assert.equal(f.fields.upload.hidden,false);
  assert.match(f.fields.message.textContent,/Dateiübertragung.*Zeitüberschreitung.*HTTP 408/);assert.match(f.fields.message.textContent,/Upload-Zeitlimit erhöhen/);
  assert.equal(f.fields['upload-timeout'].disabled,false);
  const accepted=await mount(t,{source:()=>{throw error();}});await accepted.submit();
  assert.doesNotMatch(accepted.fields.message.textContent,/erneut hochladen|Upload-Zeitlimit erhöhen/);
});

test('read-only users cannot save or upload; disposed preference saves cannot start an upload',async t=>{
  const denied=await mount(t,{prepare:false});assert.match(denied.body.innerHTML,/data-i="upload-timeout"[^>]+disabled/);
  denied.fields['upload-timeout'].value='60';await denied.change();await denied.submit();assert.equal(denied.requests.filter(r=>r.url.endsWith('/preferences')||r.url.includes('/upload/')).length,0);
  const saving=deferred(),f=await mount(t,{save:()=>saving.promise});f.fields['upload-timeout'].value='60';const changing=f.change(),submitting=f.submit();await tick();f.view.destroy();
  saving.resolve({uploadPolicy:{minutes:60,minMinutes:1,maxMinutes:120}});await Promise.all([changing,submitting]);assert.equal(f.requests.filter(r=>r.url.includes('/upload/')).length,0);
});
