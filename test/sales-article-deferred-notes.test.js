'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../public/sales-article-deferred-notes');
const response={article:{articleNumber:'102004',notes:{items:[{text:'Synthetic'}],available:true}}};
test('Notes load only on demand, share an in-flight request and load once',async()=>{
 let calls=0,resolve;const seen=[],errors=[];
 const control=create({articleNumber:'102004',current:()=>true,api:url=>{calls++;assert.equal(url,'/api/sales/articles/detail?articleNumber=102004&section=notes');return new Promise(r=>resolve=r);},onData:x=>seen.push(x),onError:x=>errors.push(x)});
 assert.equal(calls,0);const first=control.activate();assert.equal(first,control.activate());assert.equal(calls,1);
 resolve(response);await first;await control.activate();assert.equal(calls,1);assert.deepEqual(seen,[response.article.notes]);assert.deepEqual(errors,[]);
});
for(const reason of ['article-or-rights-changed','destroyed'])test('Notes discard an in-flight response when '+reason,async()=>{
 let resolve,current=true;const seen=[];
 const control=create({articleNumber:'102004',current:()=>current,api:()=>new Promise(r=>resolve=r),onData:x=>seen.push(x),onError:x=>seen.push(x)});
 const pending=control.activate();if(reason==='destroyed')control.destroy();else current=false;
 resolve(response);await pending;await control.activate();assert.deepEqual(seen,[]);
});
test('Notes preserve permission failures, reject wrong articles and allow explicit retries',async()=>{
 const denied=Object.assign(new Error('denied'),{status:403});const errors=[],seen=[];let attempt=0;
 const control=create({articleNumber:'102004',current:()=>true,api:async()=>{if(++attempt===1)throw denied;if(attempt===2)return {article:{...response.article,articleNumber:'other'}};return response;},onData:x=>seen.push(x),onError:x=>errors.push(x)});
 await control.activate();assert.equal(errors[0],denied);await control.activate();assert.equal(errors.length,2);assert.deepEqual(seen,[]);
 await control.activate();assert.deepEqual(seen,[response.article.notes]);
});
