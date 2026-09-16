'use strict';
// Cache database reads and authenticated immutable values in one bound
// transaction, never grants or a cross-transaction "unchanged" decision.
const C=require('../../data-import-contract');
const {IMPORT_READER_BATCHES:B}=require('../statements/import-reader-batches');
const batches=new Map(B.map(entry=>[entry.source,entry.batch])), caches=new WeakMap(),referenceExecutors=new WeakSet();
const protectionIds=new WeakMap();let protectionSequence=0;
const key=(statement,parameters)=>statement.id+':'+C.canonical(parameters);
function start(tx,coreReferences=false){if(!caches.has(tx))caches.set(tx,new Map());if(coreReferences)referenceExecutors.add(tx);}
function supportsReferences(tx){return referenceExecutors.has(tx);}
function put(tx,statement,parameters,value){const cache=caches.get(tx);if(cache&&cache.size<5000)cache.set(key(statement,parameters),{parameters,value});}
async function read(tx,statement,parameters){
 const saved=caches.get(tx)?.get(key(statement,parameters));
 if(saved)return saved.value;
 const value=await tx[statement.operation](statement,parameters);put(tx,statement,parameters,value);return value;
}
async function verified(tx,protection,kind,parameters,authenticate){
 const cache=caches.get(tx);if(!cache)return authenticate();
 if(!protectionIds.has(protection))protectionIds.set(protection,++protectionSequence);
 const id='verified:'+protectionIds.get(protection)+':'+kind+':'+C.canonical(parameters);
 if(cache?.has(id))return cache.get(id).value;
 const value=await authenticate();
 // Only successful authentication can populate this transaction-local cache.
 // Its complete header key and writer invalidation protect against stale data.
 if(cache&&cache.size<5000)cache.set(id,{parameters,value:C.freeze(value)});
 return value;
}
async function prefetch(tx,statement,requests){
 if(!batches.has(statement))throw new Error('Unknown import read packet');
 start(tx);
 const unique=[...new Map(requests.map(p=>[key(statement,p),p])).values()].filter(p=>!caches.get(tx).has(key(statement,p)));
 for(let from=0;from<unique.length;from+=C.LIMITS.batch){
  const part=unique.slice(from,from+C.LIMITS.batch),result=await tx.queryAll(batches.get(statement),{requests:part});
  const grouped=part.map(()=>[]);
  for(const {batchOrdinal,...row} of result){C.integer(batchOrdinal,1,part.length);grouped[batchOrdinal-1].push(row);}
  part.forEach((parameters,i)=>{
   if(statement.operation==='queryOne'&&grouped[i].length>1)C.fail('IMPORT_SOURCE_INTEGRITY');
   put(tx,statement,parameters,statement.operation==='queryOne'?grouped[i][0]||null:grouped[i]);
  });
 }
 return Promise.all(requests.map(p=>read(tx,statement,p)));
}
function invalidate(tx,{id,identityHash}){
 const cache=caches.get(tx);if(!cache)return;
 for(const [key,{parameters:p}] of cache)if(p.id===id||p.recordId===id||identityHash&&p.identityHash===identityHash)cache.delete(key);
}
module.exports={read,verified,prefetch,start,put,invalidate,supportsReferences};
