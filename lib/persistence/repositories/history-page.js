'use strict';
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {T}=require('../statements/trade-insights');
// One transaction, four bounded reads. Existing authenticated decoding still
// checks profile, identity, content hash, segments and reference indices.
async function historyPage(tx,parameters){
 const records=await tx.queryAll(S.list,parameters),versions=await tx.queryAll(T.versions,parameters),segments=await tx.queryAll(T.segments,parameters),references=await tx.queryAll(T.references,parameters);
 const grouped=rows=>{const map=new Map();for(const row of rows){const key=row.recordId+':'+row.revision;if(!map.has(key))map.set(key,[]);map.get(key).push(row);}return map;};
 return {records:new Map(records.map(r=>[r.id,r])),versions:new Map(versions.map(v=>[v.recordId+':'+v.revision,v])),segments:grouped(segments),references:grouped(references)};
}
module.exports={historyPage};
