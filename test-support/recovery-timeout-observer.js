'use strict';
// Diagnostic preload for an isolated recovery candidate, never a live setting.
const path=require('node:path'),crypto=require('node:crypto');
const installed=Symbol.for('grabenplaner.recovery-timeout-observer');
function classify(error){
 const code=typeof error?.code==='string'&&/^(?:[0-9A-Z]{5}|PERSISTENCE_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|QUERY_TIMEOUT)$/.test(error.code)?error.code:null;
 let kind='database-error';
 if(error?.message==='canceling statement due to statement timeout')kind='statement-timeout';
 else if(error?.message==='Query read timeout'||code==='QUERY_TIMEOUT')kind='driver-query-timeout';
 else if(['Connection terminated due to connection timeout','timeout exceeded when trying to connect'].includes(error?.message)||code==='ETIMEDOUT')kind='connection-timeout';
 else if(code==='57014')kind='query-cancelled';
 else if(code==='PERSISTENCE_TIMEOUT')kind='provider-timeout';
 return {kind,...(code?{code}:{})};
}
function frames(stack,root){
 const prefix=path.resolve(root)+path.sep,result=[];
 for(const line of String(stack||'').split('\n')){
  const match=line.match(/(?:\(|\s)([^()]+):(\d+):(\d+)\)?$/);if(!match)continue;
  const file=path.resolve(match[1]);if(!file.startsWith(prefix))continue;
  const relative=path.relative(root,file).replaceAll('\\','/');
  if(!/^(?:lib|server-tools|test-support)\/[a-zA-Z0-9_./-]+\.js$/.test(relative)&&relative!=='server.js')continue;
  result.push({file:relative,line:Number(match[2]),column:Number(match[3])});
  if(result.length===8)break;
 }
 return result;
}
function install({pg,errors,emit,root}){
 if(pg[installed])return;pg[installed]=true;
 function report(event){try{emit(event);}catch{/* Observations cannot alter the result. */}}
 const Original=errors.PersistenceError;
 errors.PersistenceError=class extends Original{
  constructor(code,options){
   super(code,options);
   if(code==='PERSISTENCE_TIMEOUT')report({event:'provider-timeout',...classify(this),frames:frames(this.stack,root)});
  }
 };
 function wrap(prototype,method){
  const original=prototype[method];
  prototype[method]=function(...args){
   const start=performance.now(),client=this;
   function failed(error){
    const sql=method==='query'?(typeof args[0]==='string'?args[0]:args[0]?.text):null;
    const limits={};for(const key of ['statement_timeout','query_timeout','idle_in_transaction_session_timeout']){
     const value=client.connectionParameters?.[key];if(Number.isSafeInteger(value)&&value>=0)limits[key]=value;
    }
    report({event:method==='query'?'driver-query-failed':'pool-connect-failed',...classify(error),milliseconds:Math.round(performance.now()-start),limits,
     ...(typeof sql==='string'?{statementSha256:crypto.createHash('sha256').update(sql).digest('hex')}:{ }),frames:frames(error?.stack,root)});
   }
   if(typeof args.at(-1)==='function'){
    const callback=args.at(-1);args[args.length-1]=function(error,...values){if(error)failed(error);return callback.call(this,error,...values);};
   }
   let value;try{value=original.apply(this,args);}catch(error){failed(error);throw error;}
   return value&&typeof value.then==='function'?value.catch(error=>{failed(error);throw error;}):value;
  };
 }
 wrap(pg.Client.prototype,'query');wrap(pg.Pool.prototype,'connect');
}
module.exports={install,classify,frames};
