'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const history=require('../lib/sales-recent-articles');
test('twelve distinct successful openings in most recent order',()=>{
  let value=history.empty();for(let i=0;i<15;i++)value=history.visit(value,String(i));
  assert.deepEqual(value.articleNumbers,['14','13','12','11','10','9','8','7','6','5','4','3']);
  value=history.visit(value,'5');assert.equal(value.articleNumbers[0],'5');assert.equal(value.articleNumbers.length,12);
  assert.equal(value.articleNumbers.filter(n=>n==='5').length,1);assert.throws(()=>history.normalize({version:1,articleNumbers:['1','1']}));
});
function fixture(){
 const routes={},storage=new Map(),session={employeeNumber:'a',isEmployee:true},articles=new Map();
 for(let i=0;i<15;i++)articles.set(String(i),{articleNumber:String(i),description:'Article '+i,active:true,
  identifiers:[{identifierValue:'SECONDARY-'+i,isPrimary:false},{identifierValue:'PRIMARY-'+i,isPrimary:true}],
  prices:[{priceType:'sales',priceBasis:'gross',currency:'EUR',qualityStatus:'confirmed',amount:'19.99'}]});
 const vault={seal:(v,c)=>JSON.stringify([c.connectorId,v]),async useSecret(v,c,f){const [owner,text]=JSON.parse(v);assert.equal(owner,c.connectorId);f(Buffer.from(text));}};
 const prefs={async get(owner,key){return storage.has(owner+key)?{value:storage.get(owner+key)}:null;},async upsert(owner,key,value){storage.set(owner+key,value);}};
 history.register({get:(p,f)=>routes['GET '+p]=f,post:(p,f)=>routes['POST '+p]=f,put:(p,f)=>routes['PUT '+p]=f},
 {catalog:{async getByArticleNumber(n){return articles.get(n);}},preferences:prefs,sessionFor:r=>r.session||session,
  assertFresh:async(r,s)=>{if(s.revoked)throw Object.assign(new Error('Berechtigung geändert.'),{status:403});},
  assertCsrf:r=>{assert.equal(r.csrf,true);},privateHeaders(){},vault,projectionFor:s=>({pricesRead:s.readPrices===true,costsRead:false})});
 const call=(method,path,body={},who=session)=>new Promise((resolve,reject)=>routes[method+' '+path]({method,body,csrf:true,session:who},{json:resolve},reject));
 return {call,storage,session,articles};
}
test('concurrent visits merge, history is account-bound, denied prices never leave the route',async()=>{
 const f=fixture();await Promise.all(Array.from({length:15},(_,i)=>f.call('POST','/api/sales/articles/recent',{articleNumber:String(i)})));
 const result=await f.call('GET','/api/sales/articles/recent');assert.equal(result.articles.length,12);assert.equal(result.articles[0].articleNumber,'14');assert.equal(result.articles[0].retailGross,undefined);
 const other=await f.call('GET','/api/sales/articles/recent',{}, {...f.session,employeeNumber:'b'});assert.equal(other.articles.length,0);
 const allowed=await f.call('GET','/api/sales/articles/recent',{}, {...f.session,readPrices:true});assert.equal(allowed.articles[0].retailGross,'19.99');
 assert.equal(allowed.articles[0].primaryIdentifier,'PRIMARY-14');
 assert.equal([...f.storage.values()].some(value=>value.includes('Article ')),false);
 await assert.rejects(f.call('POST','/api/sales/articles/recent',{articleNumber:'not-present'}));
 assert.equal((await f.call('GET','/api/sales/articles/recent')).articles[0].articleNumber,'14');
 await assert.rejects(f.call('GET','/api/sales/articles/recent',{}, {...f.session,isEmployee:false}));
});
test('table choices persist independently of article master and respect current price rights',async()=>{
 const f=fixture();await f.call('POST','/api/sales/articles/recent',{articleNumber:'1'});
 await f.call('PUT','/api/sales/articles/recent/preferences',{columns:['articleNumber','description','purchaseNet'],columnWidths:{description:310},sort:'recent'});
 const result=await f.call('GET','/api/sales/articles/recent');assert.equal(result.preferences.sort,'recent');assert.deepEqual(result.preferences.columns,['articleNumber','description']);assert.equal(result.preferences.columnWidths.description,310);
});

test('recent articles use current catalog values, skip missing items and hide malformed or ambiguous prices',async()=>{
 const f=fixture();await f.call('POST','/api/sales/articles/recent',{articleNumber:'1'});await f.call('POST','/api/sales/articles/recent',{articleNumber:'2'});
 f.articles.get('1').description='Updated description';f.articles.get('1').prices[0].amount='invalid';f.articles.delete('2');
 let result=await f.call('GET','/api/sales/articles/recent',{}, {...f.session,readPrices:true});
 assert.equal(result.articles.length,1);assert.equal(result.articles[0].description,'Updated description');assert.equal(result.articles[0].retailGross,null);
 f.articles.get('1').prices=[{priceType:'sales',priceBasis:'gross',currency:'EUR',qualityStatus:'confirmed',amount:'9.99'},{priceType:'sales',priceBasis:'gross',currency:'EUR',qualityStatus:'confirmed',amount:'10.99'}];
 result=await f.call('GET','/api/sales/articles/recent',{}, {...f.session,readPrices:true});assert.equal(result.articles[0].retailGross,null);
 await assert.rejects(f.call('POST','/api/sales/articles/recent',{articleNumber:'3'},{...f.session,revoked:true}),error=>error.status===403);
 assert.equal((await f.call('GET','/api/sales/articles/recent')).articles[0].articleNumber,'1');
});
