'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {PersistenceError,PERSISTENCE_ERROR_CODES}=require('../contract');

// Opt-in for complete read models, never a cache across requests. All catalog
// reads share one transaction; the boundary still reauthorizes before commit.
function createReadScope({getProvider,onOperation=()=>{},maximumEntries=256}) {
  const context=new AsyncLocalStorage();
  function invalid() {
    return new PersistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,{operation:'read-scope'});
  }
  function assertOutside() {
    const scope=context.getStore();
    if(scope){scope.failure ||= invalid();throw scope.failure;}
  }
  async function run(work) {
    const outer=context.getStore();
    if(outer){if(outer.closed)throw invalid();return work();}
    const provider=await getProvider();
    return provider.transaction(async tx=>{
      const scope={tx,queries:new Map(),entries:0,closed:false,failure:null,queue:Promise.resolve()};
      try {
        const result=await context.run(scope,work);
        if(scope.failure)throw scope.failure;
        return result;
      } finally {scope.closed=true;scope.queries.clear();}
    },{isolation:'serializable',readOnly:true});
  }
  async function query(statement,parameters) {
    const scope=context.getStore();
    if(scope?.closed)throw invalid();
    const execute=async()=>{
      onOperation(statement.id);
      const executor=scope?.tx || await getProvider();
      if(statement.operation==='queryOne'){
        const row=await executor.queryOne(statement,parameters);return row?[row]:[];
      }
      return executor.queryAll(statement,parameters);
    };
    if(!scope)return execute();
    // Parameters have already been normalized by the outer provider contract.
    // That contract also copies/validates each returned row for its caller.
    const key=JSON.stringify(parameters);
    let entries=scope.queries.get(statement);
    if(entries?.has(key))return entries.get(key);
    // A transaction owns one connection. Queue SQL explicitly instead of
    // flooding pg's connection with concurrent query calls from Promise.all.
    const pending=scope.queue.then(execute);
    scope.queue=pending.then(()=>{},error=>{scope.failure ||= error;});
    if(scope.entries<maximumEntries){
      if(!entries){entries=new Map();scope.queries.set(statement,entries);}
      entries.set(key,pending);scope.entries++;
    }
    return pending;
  }
  function join(options) {
    const scope=context.getStore();
    if(!scope)return null;
    if(scope.closed || !options.readOnly){scope.failure ||= invalid();throw scope.failure;}
    return {query,execute:async()=>assertOutside(),commit:async()=>{},
      rollback:async()=>{scope.failure ||= invalid();}};
  }
  return Object.freeze({run,query,assertOutside,join});
}
module.exports={createReadScope};
