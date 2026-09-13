'use strict';
// Database-dependent callbacks must complete before the surrounding business
// operation commits. Execute in order on its single transaction connection.
const operations={};
for(const kind of ['forEach','map','flatMap','filter','find','some','every']){
 operations[kind]=async function(values,callback,thisArg){
  const result=[];
  for(let index=0;index<values.length;index++){
   if(!(index in values))continue;
   const value=values[index],selected=await callback.call(thisArg,value,index,values);
   if(kind==='map')result[index]=selected;
   if(kind==='flatMap')result.push(...(Array.isArray(selected)?selected:[selected]));
   if(kind==='filter'&&selected)result.push(value);
   if(kind==='find'&&selected)return value;
   if(kind==='some'&&selected)return true;
   if(kind==='every'&&!selected)return false;
  }
  if(kind==='some')return false;
  if(kind==='every')return true;
  if(kind==='forEach'||kind==='find')return undefined;
  return result;
 };
}
module.exports=Object.freeze(operations);
