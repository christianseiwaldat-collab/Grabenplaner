'use strict';
const {definePersistenceStatement}=require('../../contract');
const STATEMENTS=Object.freeze(Object.fromEntries(['core','sales'].map(domain=>[domain,
  definePersistenceStatement({id:'database-transaction-activity.'+domain,operation:'queryOne',parameters:{},columns:{alive:'safe_integer'}})])));
const CATALOG=Object.freeze(Object.fromEntries(Object.entries(STATEMENTS).map(([domain,statement])=>[domain,
  Object.freeze({statement,sql:'SELECT 1::bigint AS alive',parameterOrder:[],returning:false})])));

// Work can move between the two databases for longer than one participant's
// idle timeout. Touch only an idle participant while real work is progressing;
// there is deliberately no timer keeping abandoned transactions alive.
function createTransactionActivity({now=()=>performance.now(),intervalMs=5000}={}) {
  const participants=new Map();
  async function refreshOthers(domain) {
    for(const [other,state] of participants) {
      if(other===domain||state.running||now()-state.last<intervalMs)continue;
      if(!state.refresh)state.refresh=(async()=>{
        const result=await state.raw.queryOne(STATEMENTS[other],{});
        if(result?.alive!==1)throw new Error('BOUNDARY_TRANSACTION_ACTIVITY_INVALID');
        state.last=now();
      })().finally(()=>{state.refresh=null;});
      await state.refresh;
    }
  }
  function attach(domain,raw) {
    if(!STATEMENTS[domain]||participants.has(domain))throw new Error('BOUNDARY_TRANSACTION_ACTIVITY_DOMAIN');
    const state={raw,last:now(),running:0,refresh:null};participants.set(domain,state);
    return Object.freeze(Object.fromEntries(['queryOne','queryAll','execute'].map(method=>[method,async(...args)=>{
      state.running++;
      try {
        if(state.refresh)await state.refresh;
        await refreshOthers(domain);
        const result=await raw[method](...args);state.last=now();
        await refreshOthers(domain);
        return result;
      }finally{state.running--;}
    }])));
  }
  return {attach,detach:domain=>participants.delete(domain)};
}
module.exports={CATALOG,STATEMENTS,createTransactionActivity};
