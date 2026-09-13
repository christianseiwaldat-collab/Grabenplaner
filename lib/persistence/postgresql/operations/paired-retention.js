'use strict';
const fs=require('node:fs'),path=require('node:path');
const {safeRoot,verifyPairBundle}=require('./paired-bundle');
async function prunePairedSnapshots(root,{keepDays=20,now=Date.now()}={}){
 safeRoot(root);if(!Number.isInteger(keepDays)||keepDays<1||keepDays>1000||!Number.isFinite(now))throw new Error('PG_PAIR_RETENTION_POLICY');
 const points=[];
 for(const name of fs.readdirSync(root).sort()){
  if(!/^[a-f0-9-]{36}\.pair\.complete\.json$/.test(name))continue;
  const directory=path.join(root,name.replace(/\.complete\.json$/,'')),marker=path.join(root,name);
  const proof=await verifyPairBundle(directory,marker),created=Date.parse(proof.manifest.createdAt);
  if(!Number.isFinite(created)||created>now+5*60000)throw new Error('PG_PAIR_RETENTION_DATE');
  points.push({directory,marker,created,day:new Date(created).toISOString().slice(0,10)});
 }
 points.sort((a,b)=>b.created-a.created||b.directory.localeCompare(a.directory));
 const days=new Set(),keep=new Set();
 for(const point of points)if(!days.has(point.day)&&days.size<keepDays){days.add(point.day);keep.add(point.directory);}
 const removed=[];
 // Everything is verified before the first removal. Unknown/incomplete points
 // and other backup formats are deliberately outside this ownership contract.
 for(const point of points){
  if(keep.has(point.directory))continue;
  if(path.dirname(point.directory)!==root||fs.realpathSync(point.directory)!==point.directory)throw new Error('PG_PAIR_RETENTION_PATH');
  fs.unlinkSync(point.marker);fs.rmSync(point.directory,{recursive:true});removed.push(path.basename(point.directory));
 }
 return {providerId:'postgresql-pair',verifiedPoints:points.length,retainedPoints:keep.size,retainedDays:days.size,removed};
}
module.exports={prunePairedSnapshots};
