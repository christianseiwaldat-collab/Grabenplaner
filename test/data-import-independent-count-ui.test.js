'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/data-import');
const projection={read:true,prepare:true,apply:true};
const source=()=>({id:'source',kind:'trade',fileName:'Trade_Daten.accdb',revision:7,status:'needs_review',complete:true,activationEnabled:true,independentCountVerification:{required:true,verified:false},tables:[{name:'ARTIKEL_FILIALEN',declaredRows:2,run:{id:'run',receivedRows:3,status:'needs_review',counts:{create:3},gates:['SOURCE_ROW_COUNT_MISMATCH'],availableSourceTolerances:[]}}]});
test('missing raw bytes offer the existing binary upload picker while count approval and apply stay unavailable',()=>{
 const html=UI.renderSource(source(),projection);assert.match(html,/data-i-upload="trade" >Dateistand zur Quellprüfung auswählen/);assert.match(html,/Bereits eingelesene Daten bleiben erhalten/);assert.match(html,/geänderte Datei wird als neuer Import behandelt/);assert.doesNotMatch(html,/data-i-action="approve-counts"/);assert.match(html,/data-i-action="apply" disabled/);
});
test('retained encrypted upload points to retry instead of requesting duplicate upload',()=>{
 const value=source();Object.assign(value,{uploadFileAvailable:true,background:{status:'failed',phase:'reviewing',error:'IMPORT_SOURCE_VERIFICATION_FAILED'}});const html=UI.renderSource(value,projection);assert.match(html,/Mit „Prüfung fortsetzen“/);assert.match(html,/data-i-job="retry"/);assert.doesNotMatch(html,/data-i-upload="trade"/);assert.match(html,/data-i-action="apply" disabled/);
});
test('active independent verification has a specific status and no available approval action',()=>{
 const value=source();Object.assign(value,{active:true,uploadFileAvailable:true,background:{status:'reviewing',phase:'reviewing',independentCountVerification:true}});const html=UI.renderSource(value,projection);assert.match(html,/Quellenzähler werden unabhängig geprüft/);assert.match(html,/Die unabhängige Quellenprüfung läuft/);assert.doesNotMatch(html,/data-i-action="approve-counts"/);assert.match(html,/data-i-action="apply" disabled/);
});
test('verified evidence still needs separate owner approval; verification never enables business apply',()=>{
 const value=source();value.independentCountVerification={required:false,verified:true};value.tables[0].run.availableSourceTolerances=[{id:'verified',fingerprint:'a'.repeat(64),expectedRows:3,declaredRows:2,evidenceReference:'protected-receipt',requiresExplicitApproval:true,recordedAt:'2026-11-11T21:00:00.000Z'}];const html=UI.renderSource(value,projection);assert.match(html,/data-i-action="approve-counts" >Geprüfte/);assert.match(html,/Persönliche Freigabe ausstehend/);assert.match(html,/data-i-action="apply" disabled/);assert.doesNotMatch(html,/data-i-upload="trade"/);
});
test('reverification requires preparation rights and cannot override another source gate',()=>{
 const value=source();assert.match(UI.renderSource(value,{...projection,prepare:false}),/data-i-upload="trade" disabled/);value.tables[0].run.gates.push('SOURCE_SCHEMA_CHANGED');assert.match(UI.renderSource(value,projection),/data-i-action="apply" disabled/);assert.doesNotMatch(UI.renderSource(value,projection),/data-i-action="approve-counts" >Geprüfte/);
});
test('reverification picker reuses the existing upload form and sends no JSON proof or business operation',async t=>{
 const value=source(),requests=[],handlers={};let picked=0;
 const names=['next','sources','detail','message','log','stop','form','file','kind','kind-hint','upload-title','password','file-name','upload','overview','upload-timeout','upload-timeout-status'];
 const fields=Object.fromEntries(names.map(name=>[name,{hidden:true,innerHTML:'',textContent:'',value:'',files:[],disabled:false,querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false,replaceChildren(){},setAttribute(){},removeAttribute(){},scrollIntoView(){},focus(){},click(){if(name==='file')picked++;}}]));
 const body={innerHTML:'',querySelector:s=>fields[/data-i="([^"]+)"/.exec(s)?.[1]],addEventListener:(name,fn)=>handlers[name]=fn,removeEventListener(){},replaceChildren(){}};
 const root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
 const view=UI.mount(root,{api:async(url,options={})=>{requests.push({url,method:options.method||'GET'});if(url.endsWith('/context'))return {available:true,projection,backgroundEnabled:true,maxBytes:512*1024*1024,sourceCatalog:[{kind:'trade',fileName:'Trade_Daten.accdb',available:true,group:'recommended'}]};if(url.endsWith('/sources/search'))return {items:[value],next:null};assert.equal(url,'/api/data-import/sources/source');return structuredClone(value);}});t.after(()=>view.destroy());
 await new Promise(r=>setImmediate(r));const click=dataset=>handlers.click({target:{closest:()=>({dataset,disabled:false,hasAttribute:()=>false})}});await click({iSource:'source'});const beforePicker=requests.length;await click({iUpload:'trade'});assert.equal(picked,1);assert.equal(fields.kind.value,'trade');assert.equal(fields.upload.hidden,false);assert.equal(requests.length,beforePicker);assert.equal(requests.some(r=>/proof|approve|apply/.test(r.url)),false);
});
