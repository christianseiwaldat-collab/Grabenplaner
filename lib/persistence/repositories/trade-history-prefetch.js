'use strict';
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {prefetch}=require('../../sales-article-reader-batch');
const empty=()=>({records:new Map(),versions:new Map(),segments:new Map(),references:new Map()});
// Reporting packets stay inside the caller's read transaction. The ordinary
// history decoder still authenticates every record and evaluates every grant.
async function prefetchHistory({tx,records}){
 if(!records.length)return null;
 const result=empty(),unique=[...new Map(records.map(r=>[r.id,r])).values()];
 for(let offset=0;offset<unique.length;offset+=100){
  const part=unique.slice(offset,offset+100),requests=part.map(r=>({recordId:r.id,revision:r.revision}));
  const versions=await prefetch(tx,S.version,requests),segments=await prefetch(tx,S.segments,requests),references=await prefetch(tx,S.references,requests);
  part.forEach((r,i)=>{const key=r.id+':'+r.revision;result.records.set(r.id,r);result.versions.set(key,versions[i]);result.segments.set(key,segments[i]);result.references.set(key,references[i]);});
 }
 return result;
}
function merge(target,packet){
 if(packet)for(const name of ['records','versions','segments','references'])for(const [key,value] of packet[name])target[name].set(key,value);
 return target;
}
module.exports={prefetchHistory,empty,merge};
