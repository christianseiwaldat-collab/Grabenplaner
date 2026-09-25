'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{mount}=require('../public/trade-article-history');
const tick=()=>new Promise(setImmediate);
function fixture(t){
 const original=global.FormData;global.FormData=class{constructor(form){this.form=form;}*[Symbol.iterator](){for(const [key,field] of Object.entries(this.form.elements))yield [key,field.value];}};t.after(()=>{global.FormData=original;});
 const nodes=new Map();const node=k=>{if(!nodes.has(k))nodes.set(k,{hidden:false,disabled:false,innerHTML:'',textContent:'',replaceChildren(){this.innerHTML='';},querySelector(){return node(k+'-button');},close(){this.open=false;}});return nodes.get(k);};
 const root={innerHTML:'',querySelector:s=>node(s.match(/data-ah="([^"]+)"/)[1]),replaceChildren(){this.innerHTML='';}};
 node('form').elements={query:{value:''},status:{value:'archived'},searchMode:{value:'text'}};
 const pending=[],workspace=mount(root,{api:(path,query,signal)=>new Promise((resolve,reject)=>pending.push({path,query,signal,resolve,reject}))});
 const submit=()=>node('form').onsubmit({preventDefault(){}});
 return {node,root,pending,workspace,submit};
}
const response=(rows=[],next=null)=>({rows,next,scanned:100,available:true,sources:{archiveImports:1}});
const row=i=>({articleNumber:'D-'+i,label:'Synthetic '+i,status:'archived',candidates:[]});
test('Changing filters aborts the previous query and late results cannot reappear',async t=>{
 const f=fixture(t);f.workspace.activate();assert.equal(f.pending.length,0);f.submit();assert.equal(f.pending.length,1);
 f.node('form').elements.query.value='new';f.node('form').oninput();assert.equal(f.pending[0].signal.aborted,true);
 f.pending[0].resolve(response([row(1)],'cursor'));await tick();assert.equal(f.node('results').innerHTML,'');assert.equal(f.node('more').hidden,true);
 f.submit();f.pending[1].resolve(response([row(2)]));await tick();assert.match(f.node('results').innerHTML,/Synthetic 2/);assert.doesNotMatch(f.node('results').innerHTML,/Synthetic 1/);
 f.workspace.destroy();
});
test('Search pages stop after a bounded group and resume with the original selection',async t=>{
 const f=fixture(t);f.workspace.activate('camera');assert.equal(f.pending[0].query.status,'all');
 f.pending[0].resolve(response(Array.from({length:50},(_,i)=>row(i)),'continue'));await tick();assert.equal(f.pending.length,1);assert.equal(f.node('more').hidden,false);
 f.node('more').onclick();assert.equal(f.pending[1].query.cursor,'continue');assert.equal(f.pending[1].query.query,'camera');
 f.pending[1].resolve(response([row(99)]));await tick();assert.match(f.node('status').textContent,/51 Treffer/);assert.equal(f.node('more').hidden,true);
 f.workspace.destroy();
});
test('Leaving the page or destroying an account prevents late responses from restoring results',async t=>{
 const f=fixture(t);f.workspace.activate();f.submit();f.workspace.suspend();assert.equal(f.pending[0].signal.aborted,true);
 f.pending[0].resolve(response([row(1)]));await tick();assert.equal(f.node('results').innerHTML,'');
 f.workspace.activate();f.submit();f.workspace.destroy();f.pending[1].resolve(response([row(2)]));await tick();assert.equal(f.root.innerHTML,'');assert.equal(f.node('results').innerHTML,'');
});

test('Explicit exact search is forwarded unchanged with leading zeroes',async t=>{
 const f=fixture(t);f.workspace.activate();f.node('form').elements.query.value='000042';f.node('form').elements.searchMode.value='exact';f.submit();assert.equal(f.pending[0].query.query,'000042');assert.equal(f.pending[0].query.searchMode,'exact');f.pending[0].resolve(response([row(1)]));await tick();f.workspace.destroy();
});
