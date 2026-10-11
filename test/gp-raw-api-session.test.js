'use strict';
// Actual main raw-response API session and mutation regression.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {functionSource}=require('../test-support/learning-workspace-ui');
const turn=()=>new Promise(setImmediate);
test('actual rawApi old401 detail cannot end a newly authenticated same-actor session; current401 still expires it',async()=>{
 const state={portalSession:{authenticated:true,user:{employeeNumber:'SYNTHETIC-A'}}},details=[];let logins=0;
 const context=vm.createContext({state,document:{cookie:''},elements:{loginGate:{}},location:{hostname:'synthetic.invalid'},fetch:async()=>({ok:false,status:401}),window:{GrabenplanerApiErrors:{fromResponse:()=>new Promise(resolve=>details.push(resolve))}},showLoginGate:()=>{logins++;},Error});
 vm.runInContext(functionSource('csrfHeader')+functionSource('rawApi'),context);
 const old=context.rawApi('/api/synthetic/private-read');await turn();
 state.portalSession=null;state.portalSession={authenticated:true,user:{employeeNumber:'SYNTHETIC-A'}};const fresh=state.portalSession;
 details.shift()({message:'expired',code:'EXPIRED'});await assert.rejects(old,e=>e.status===401&&e.code==='EXPIRED');assert.equal(logins,0,'old async401 must not expire new same-actor login');assert.equal(state.portalSession,fresh);
 const current=context.rawApi('/api/synthetic/current-read');await turn();details.shift()({message:'expired',code:'EXPIRED'});await assert.rejects(current,e=>e.status===401);assert.equal(logins,1,'current401 must still open login');
});
test('actual rawApi forwards original raw response and current mutation CSRF/header behavior',async()=>{
 const response={ok:true,status:204},requests=[];
 const context=vm.createContext({state:{portalSession:{}},document:{cookie:'grabenplaner_csrf=synthetic%20csrf'},elements:{loginGate:{}},location:{hostname:'synthetic.invalid'},fetch:async(url,options)=>{requests.push({url,options});return response;},window:{},decodeURIComponent,Error});
 vm.runInContext(functionSource('csrfHeader')+functionSource('rawApi'),context);
 assert.equal(await context.rawApi('/api/synthetic/write',{method:'post',headers:{'X-Synthetic':'yes'},body:'synthetic-body'}),response);
 assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.headers['X-CSRF-Token'],'synthetic csrf');assert.equal(requests[0].options.headers['X-Synthetic'],'yes');assert.equal(requests[0].options.body,'synthetic-body');
 await context.rawApi('/api/synthetic/read');assert.equal(requests[1].options.headers['X-CSRF-Token'],undefined);
});
