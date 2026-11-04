'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {install,BASE}=require('../lib/vps-storage-routes');
function fixture(){
 const routes=new Map(),calls=[],state={actor:{employeeNumber:'synthetic',accountId:'a',role:'developer',permissions:['system:diagnostics:technical','system:write']},eligible:true,csrf:true};
 install(Object.fromEntries(['get','post','put'].map(method=>[method,(path,work)=>routes.set(method+' '+path,work)])),{
  actor:()=>state.actor,freshActor:async()=>state.fresh||state.actor,csrf:()=>{if(!state.csrf)throw Object.assign(Error('CSRF'),{status:403});},
  eligible:()=>state.eligible,audit:async()=>{},control:async input=>{calls.push(input);return {acceptedAt:'2026-10-13T16:00:00.000Z',report:{available:true,checkedAt:null}};}
 });
 const request=async(method,path,body)=>{const response={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};await routes.get(method+' '+BASE+path)({body,method:method.toUpperCase()},response);return response;};
 return {state,calls,request};
}
test('storage status is private and only technical administrators reach the native control',async()=>{
 const f=fixture(),result=await f.request('get','');assert.equal(result.headers['Cache-Control'],'private, no-store');assert.equal(result.body.canWrite,true);
 f.state.actor={...f.state.actor,role:'manager'};await assert.rejects(f.request('get',''),e=>e.status===403);assert.equal(f.calls.length,1);
});
test('inspection is read-only authority; cleanup additionally requires system write, fresh actor and CSRF',async()=>{
 const f=fixture();f.state.actor.permissions=['system:diagnostics:technical'];await f.request('post','/inspect',{});
 const body={planSha256:'a'.repeat(64),confirmation:'VPS_STORAGE_CLEANUP'};
 await assert.rejects(f.request('post','/cleanup',body),e=>e.status===403);assert.equal(f.calls.length,1);
 f.state.actor.permissions.push('system:write');f.state.csrf=false;await assert.rejects(f.request('post','/cleanup',body));assert.equal(f.calls.length,1);
 f.state.csrf=true;f.state.fresh={...f.state.actor,accountId:'changed'};await assert.rejects(f.request('post','/cleanup',body),e=>e.status===403);assert.equal(f.calls.length,1);
});
test('cleanup accepts only an explicit preview digest and rejects paths or unconfirmed deletion',async()=>{
 const f=fixture();await assert.rejects(f.request('post','/cleanup',{planSha256:'a'.repeat(64)}),e=>e.status===400);
 await assert.rejects(f.request('post','/cleanup',{planSha256:'a'.repeat(64),confirmation:'VPS_STORAGE_CLEANUP',path:'/var'}),e=>e.status===400);
 assert.equal(f.calls.length,0);
 const result=await f.request('post','/retire-imports',{planSha256:'b'.repeat(64),confirmation:'VPS_STORAGE_RETIRE_IMPORTS'});
 assert.equal(result.statusCode,202);assert.equal(f.calls[0].action,'retire-imports');assert.equal(f.calls[0].planSha256,'b'.repeat(64));
});
test('local mode does not claim a current VPS measurement',async()=>{
 const f=fixture();f.state.eligible=false;const result=await f.request('get','');assert.equal(result.body.available,false);assert.equal(f.calls.length,0);
 await assert.rejects(f.request('post','/inspect',{}),e=>e.code==='VPS_STORAGE_SERVER_REQUIRED');assert.equal(f.calls.length,0);
});
