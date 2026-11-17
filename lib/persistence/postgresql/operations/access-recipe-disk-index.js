'use strict';
// Fixed-size metadata records only: no source values, passwords or key material.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const RECORD_BYTES=83,PAGE_RECORDS=512,PAGE_BYTES=RECORD_BYTES*PAGE_RECORDS,CACHE_BYTES=64*1024**2;
const MAX_ENTRIES=32000000,RESERVE=10*1024**3,SPACE_INTERVAL=8*1024**2,HEX=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function trustedSort(){
 if(process.platform!=='linux')fail('PG_DEPLOY_INDEX_SORT_UNAVAILABLE');
 const tool='/usr/bin/sort',allowed=new Set([tool,'/usr/lib/cargo/bin/coreutils/sort']);
 // Ubuntu's platform sort is a root-owned uutils symlink. Check every lexical
 // node (including targets before '..'), without trusting PATH or link modes.
 function inspect(raw,depth=0){
  if(depth>32||!raw.startsWith('/'))fail('PG_DEPLOY_INDEX_SORT_UNTRUSTED');
  const parts=raw.split('/').filter(Boolean);let current='/';
  const root=fs.lstatSync(current);if(!root.isDirectory()||root.uid!==0||(root.mode&0o022))fail('PG_DEPLOY_INDEX_SORT_UNTRUSTED');
  for(let i=0;i<parts.length;i++){
   if(parts[i]==='.')continue;if(parts[i]==='..'){current=path.dirname(current);continue;}
   const next=current==='/'?'/'+parts[i]:current+'/'+parts[i],s=fs.lstatSync(next);
   if(s.uid!==0)fail('PG_DEPLOY_INDEX_SORT_UNTRUSTED');
   if(s.isSymbolicLink()){
    const link=fs.readlinkSync(next),target=link.startsWith('/')?link:path.dirname(next)+'/'+link;
    return inspect(target+(i+1<parts.length?'/'+parts.slice(i+1).join('/'):''),depth+1);
   }
   if((s.mode&0o022)||(i===parts.length-1?!s.isFile():!s.isDirectory()))fail('PG_DEPLOY_INDEX_SORT_UNTRUSTED');
   current=next;
  }
  return current;
 }
 const resolved=inspect(tool);if(!allowed.has(resolved)||fs.realpathSync(tool)!==resolved)fail('PG_DEPLOY_INDEX_SORT_UNTRUSTED');
 return tool;
}
function createDiskRecipeIndex({directory,checkBudget=()=>{},maxEntries=MAX_ENTRIES}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof checkBudget!=='function'||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>MAX_ENTRIES)fail('PG_DEPLOY_INDEX_CONFIGURATION');
 const parent=path.resolve(directory),uid=process.getuid?.();
 function privateDirectory(name){
  const s=fs.lstatSync(name);
  if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(name)!==name||uid!==undefined&&(s.uid!==uid||(s.mode&0o777)!==0o700))fail('PG_DEPLOY_INDEX_DIRECTORY');
  return s;
 }
 checkBudget();privateDirectory(parent);
 function capacity(name,required){const s=fs.statfsSync(name),free=s.bavail*s.bsize;if(!Number.isSafeInteger(free)||free<required)fail('PG_DEPLOY_INDEX_DISK_RESERVE');}
 capacity(parent,RESERVE+SPACE_INTERVAL);
 const root=fs.mkdtempSync(path.join(parent,'gp-access-recipe-index-'));fs.chmodSync(root,0o700);const rootIdentity=privateDirectory(root);
 const temp=path.join(root,'sort-work');fs.mkdirSync(temp,{mode:0o700});const tempIdentity=privateDirectory(temp);
 const owned=new Map(),pages=new Map(),buffer=Buffer.alloc(RECORD_BYTES*1024);let used=0,rawCount=0,written=0,nextSpace=0,size=0,state='writing',rawFd,sortedFd;
 function own(name){
  const file=path.join(root,name),fd=fs.openSync(file,'wx',0o600),s=fs.fstatSync(fd);owned.set(file,{dev:s.dev,ino:s.ino});return fd;
 }
 function checkedFile(file,identity){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.dev!==identity.dev||s.ino!==identity.ino||uid!==undefined&&(s.uid!==uid||(s.mode&0o077)))fail('PG_DEPLOY_INDEX_FILE');
  return s;
 }
 try{rawFd=own('raw.records');}catch(error){fs.rmdirSync(temp);fs.rmdirSync(root);throw error;}
 function flush(){
  checkBudget();if(!used)return;
  if(written+used>=nextSpace){capacity(root,RESERVE+2*(written+used)+SPACE_INTERVAL);nextSpace=written+used+SPACE_INTERVAL;}
  let offset=0;while(offset<used){const count=fs.writeSync(rawFd,buffer,offset,used-offset);if(count<=0)fail('PG_DEPLOY_INDEX_WRITE');offset+=count;}
  written+=used;used=0;checkBudget();
 }
 function append(digest,locatorId,ordinal){
  if(state!=='writing')fail('PG_DEPLOY_INDEX_STATE');
  if(typeof digest!=='string'||!HEX.test(digest)||[locatorId,ordinal].some(n=>!Number.isSafeInteger(n)||n<0||n>0xffffffff))fail('PG_DEPLOY_INDEX_RECORD');
  if(rawCount>=maxEntries)fail('PG_DEPLOY_INDEX_LIMIT');
  const line=digest+'\t'+locatorId.toString(16).padStart(8,'0')+'\t'+ordinal.toString(16).padStart(8,'0')+'\n';
  if(used+RECORD_BYTES>buffer.length)flush();buffer.write(line,used,RECORD_BYTES,'ascii');used+=RECORD_BYTES;rawCount++;
 }
 async function finalize(){
  if(state!=='writing')fail('PG_DEPLOY_INDEX_STATE');checkBudget();
  const tool=trustedSort();
  state='sorting';let output,error;
  try{
   flush();fs.fsyncSync(rawFd);fs.closeSync(rawFd);rawFd=undefined;capacity(root,RESERVE+2*written);
   output=own('sorted.records');error=own('sort.stderr');
   await new Promise((resolve,reject)=>{
    let primary,killTimer;
    const child=spawn(tool,['--stable','--unique','--field-separator=\t','-k1,1','-S64M','-T',temp,path.join(root,'raw.records')],
     {env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'},stdio:['ignore',output,error]});
    child.once('error',error=>{primary ||= error;});
    const timer=setInterval(()=>{try{checkBudget();capacity(root,RESERVE);}catch(error){if(!primary){primary=error;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);}}},250);
    child.once('close',code=>{clearInterval(timer);clearTimeout(killTimer);if(primary)reject(primary);else if(code!==0)reject(Object.assign(new Error('PG_DEPLOY_INDEX_SORT_FAILED'),{code:'PG_DEPLOY_INDEX_SORT_FAILED'}));else resolve();});
   });
   checkBudget();fs.fsyncSync(output);fs.closeSync(output);output=undefined;fs.closeSync(error);error=undefined;
   const file=path.join(root,'sorted.records'),info=checkedFile(file,owned.get(file));
   if(info.size%RECORD_BYTES||info.size>rawCount*RECORD_BYTES)fail('PG_DEPLOY_INDEX_SORT_OUTPUT');
   size=info.size/RECORD_BYTES;sortedFd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   const opened=fs.fstatSync(sortedFd);if(opened.ino!==info.ino||opened.dev!==info.dev)fail('PG_DEPLOY_INDEX_FILE');
   state='ready';buffer.fill(0);return {size};
  }catch(error){state='failed';throw error;}finally{if(output!==undefined)fs.closeSync(output);if(error!==undefined)fs.closeSync(error);}
 }
 function page(index){
  if(state!=='ready')fail('PG_DEPLOY_INDEX_STATE');
  const number=Math.floor(index/PAGE_RECORDS);let value=pages.get(number);
  if(value){pages.delete(number);pages.set(number,value);return value;}
  checkBudget();value=Buffer.allocUnsafe(Math.min(PAGE_RECORDS,size-number*PAGE_RECORDS)*RECORD_BYTES);let offset=0;
  while(offset<value.length){const count=fs.readSync(sortedFd,value,offset,value.length-offset,number*PAGE_BYTES+offset);if(count<=0)fail('PG_DEPLOY_INDEX_READ');offset+=count;}
  if(pages.size>=Math.floor(CACHE_BYTES/PAGE_BYTES))pages.delete(pages.keys().next().value);pages.set(number,value);return value;
 }
 function record(index){
  const bytes=page(index),offset=(index%PAGE_RECORDS)*RECORD_BYTES,line=bytes.toString('ascii',offset,offset+RECORD_BYTES);
  if(!/^[a-f0-9]{64}\t[a-f0-9]{8}\t[a-f0-9]{8}\n$/.test(line))fail('PG_DEPLOY_INDEX_RECORD');
  return [line.slice(0,64),[parseInt(line.slice(65,73),16),parseInt(line.slice(74,82),16)]];
 }
 function lookup(digest){
  if(state!=='ready')fail('PG_DEPLOY_INDEX_STATE');if(typeof digest!=='string'||!HEX.test(digest))fail('PG_DEPLOY_INDEX_RECORD');
  checkBudget();let lo=0,hi=size-1;
  while(lo<=hi){const mid=Math.floor((lo+hi)/2),entry=record(mid);if(entry[0]===digest)return entry[1];if(entry[0]<digest)lo=mid+1;else hi=mid-1;}
  return undefined;
 }
 function* entries(){
  if(state!=='ready')fail('PG_DEPLOY_INDEX_STATE');let previous;
  for(let index=0;index<size;index++){if(index%PAGE_RECORDS===0)checkBudget();const entry=record(index);if(previous!==undefined&&entry[0]<=previous)fail('PG_DEPLOY_INDEX_SORT_OUTPUT');previous=entry[0];yield entry;}
 }
 function dispose(){
  if(state==='disposed')return;if(state==='sorting')fail('PG_DEPLOY_INDEX_BUSY');
  if(rawFd!==undefined){fs.closeSync(rawFd);rawFd=undefined;}if(sortedFd!==undefined){fs.closeSync(sortedFd);sortedFd=undefined;}buffer.fill(0);pages.clear();
  const r=privateDirectory(root),s=privateDirectory(temp);
  if(r.dev!==rootIdentity.dev||r.ino!==rootIdentity.ino||s.dev!==tempIdentity.dev||s.ino!==tempIdentity.ino)fail('PG_DEPLOY_INDEX_DIRECTORY');
  const allowed=new Set(['sort-work',...[...owned.keys()].map(file=>path.basename(file))]);
  if(fs.readdirSync(root).some(name=>!allowed.has(name))||fs.readdirSync(temp).length)fail('PG_DEPLOY_INDEX_UNKNOWN_FILES');
  for(const [file,identity] of owned)if(fs.existsSync(file))checkedFile(file,identity);
  for(const file of owned.keys())if(fs.existsSync(file))fs.unlinkSync(file);
  fs.rmdirSync(temp);fs.rmdirSync(root);state='disposed';
 }
 return Object.freeze({append,finalize,lookup,entries,dispose,get size(){return size;},get directory(){return root;}});
}
module.exports={createDiskRecipeIndex,RECORD_BYTES};
