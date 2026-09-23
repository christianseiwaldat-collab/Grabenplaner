'use strict';
const crypto=require('node:crypto'),assert=require('node:assert/strict');
async function unusedArticleNumber(request,{randomInt=crypto.randomInt}={}){
 // TradeFoto accepts only six significant digits. A random candidate is not
 // necessarily unused, including among archived articles or barcode matches.
 const used=new Set();
 for(let attempt=0;attempt<20;attempt++){
  const value=randomInt(900000,1000000);
  assert.ok(Number.isInteger(value)&&value>=900000&&value<=999999,'Synthetic article range');
  const number=String(value);if(used.has(number))continue;used.add(number);
  const result=await request('/api/sales/articles?status=all&query='+number);
  assert.ok(Array.isArray(result?.items)&&Number.isSafeInteger(result.total)&&result.total>=0,'Article search contract');
  if(result.total===0&&result.items.length===0)return number;
 }
 throw Object.assign(new Error('PG_RECOVERY_FIXTURE_UNAVAILABLE'),{code:'PG_RECOVERY_FIXTURE_UNAVAILABLE'});
}
module.exports={unusedArticleNumber};
