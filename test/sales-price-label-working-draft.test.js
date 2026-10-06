'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Draft=require('../public/sales-price-label-working-draft'),Labels=require('../public/sales-price-labels');
const snapshot=extra=>({schemaVersion:1,draftId:crypto.randomUUID(),articleNumbers:'107506',priceType:'sales',options:Labels.normalizeOptions({}),filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''},name:'Entwurf',library:{mode:'new',templateId:'',templateVersion:null,title:'Kamera',visibility:'private',recipients:[]},selectedArticleNumber:'107506',paperPage:0,rawSettings:{labelWidthMm:''},...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('working draft validates bounded explicit form state without requiring printable paper; rejects injected/private fields',()=>{
 const draft=snapshot({options:Labels.normalizeOptions({labelWidthMm:500,labelHeightMm:500})});assert.deepEqual(Draft.normalize(draft,Labels.normalizeOptions),draft);
 for(const changed of [{...draft,password:'secret'},snapshot({library:{...draft.library,recipients:['a','a']}}),snapshot({rawSettings:{password:'secret'}}),snapshot({articleNumbers:'x'.repeat(12001)})])assert.throws(()=>Draft.normalize(changed,Labels.normalizeOptions));
});
test('hydrate first; serialize autosave and preserve later input while earlier save completes',async()=>{
 const loaded=deferred(),first=deferred(),calls=[];let revisions=0;
 const store=Draft.createStore({key:()=> 'account-a',normalizeOptions:Labels.normalizeOptions,delay:100000,api:async(_url,options={})=>{
  if(!options.method)return loaded.promise;const body=JSON.parse(options.body);calls.push(body);if(calls.length===1)await first.promise;return{revision:++revisions,draft:body.draft};}});
 const activation=store.activate();assert.equal(store.change(snapshot()),false);loaded.resolve({revision:0,draft:null});await activation;
 const early=snapshot();store.change(early);const saving=store.flush();store.change({...early,name:'Spätere Eingabe'});first.resolve();await saving;
 assert.equal(calls.length,2);assert.equal(calls[0].revision,0);assert.equal(calls[1].revision,1);assert.equal(store.value.name,'Spätere Eingabe');assert.equal(store.status,'saved');store.invalidate();
});
test('a different signed actor cannot see a prior draft or accept its late read',async()=>{
 const waiting=deferred();let actor='a';const store=Draft.createStore({key:()=>actor,normalizeOptions:Labels.normalizeOptions,api:()=>waiting.promise});
 const activation=store.activate();actor='b';store.invalidate();waiting.resolve({revision:1,draft:snapshot()});await activation;assert.equal(store.value,null);assert.equal(store.ready,false);
});
test('failed autosave keeps local input; retry recognizes uncertain committed snapshot and does not silently overwrite other tabs',async()=>{
 let server={revision:0,draft:null},lose=true;const store=Draft.createStore({key:()=> 'a',normalizeOptions:Labels.normalizeOptions,delay:100000,api:async(_url,options={})=>{
  if(!options.method)return server;const body=JSON.parse(options.body);server={revision:server.revision+1,draft:body.draft};if(lose){lose=false;throw new Error('Lost acknowledgment');}return server;}});
 await store.activate();const draft=snapshot();store.change(draft);assert.equal(await store.flush(),false);assert.equal(store.hasUnsaved,true);assert.equal(await store.retry(),true);assert.equal(store.status,'saved');
 store.change({...draft,name:'Local'});server={revision:2,draft:{...draft,name:'Other tab'}};assert.equal(await store.retry(),false);assert.equal(store.value.name,'Local');assert.equal(store.status,'conflict');store.invalidate();
});
test('lost acknowledgment is bound to the exact own mutation while later local input is preserved and saved',async()=>{
 let server={revision:0,draft:null,lastMutationId:null},lose=true;
 const store=Draft.createStore({key:()=> 'a',normalizeOptions:Labels.normalizeOptions,delay:100000,api:async(_url,options={})=>{
  if(!options.method)return server;const body=JSON.parse(options.body);server={revision:server.revision+1,draft:body.draft,lastMutationId:body.mutationId};if(lose){lose=false;throw new Error('Lost acknowledgment');}return server;}});
 await store.activate();const first=snapshot();store.change(first);await store.flush();store.change({...first,name:'Later input'});assert.equal(store.status,'error');assert.equal(await store.flush(),false);
 assert.equal(await store.retry(),true);assert.equal(server.revision,2);assert.equal(server.draft.name,'Later input');assert.equal(store.status,'saved');store.invalidate();
});
