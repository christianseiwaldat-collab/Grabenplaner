'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const C=require('./data-import-contract'),{MAX_BYTES}=require('./tradefoto-full-import-source');
const ID=/^[a-f0-9]{64}$/,BLOB=/^[a-f0-9]{64}\.[a-f0-9]{32}\.source$/;
const RETENTION_MS=72*60*60*1000,MAX_JOBS=6,MAX_SPOOL_BYTES=1536*1024*1024;
const context=id=>({namespace:'data-import-jobs',connectorId:id,field:'job',purpose:'temporary-background-validation'});

// A private, temporary spool outside the business backup source set. Its job
// envelope holds a per-file key in the existing vault; plaintext never hits disk.
function createDataImportJobStore({directory,vault,now=Date.now}) {
  const root=path.resolve(directory),uid=process.getuid?.(),writes=new Map();
  function target(name){if(!ID.test(name)&&!BLOB.test(name)&&!/^\.[a-f0-9]{32}\.tmp$/.test(name))C.fail('IMPORT_JOB_PATH_INVALID');return path.join(root,name);}
  function protectedStat(s){return !s.isSymbolicLink()&&s.nlink===1&&(uid===undefined||(s.uid===uid&&(s.mode&0o077)===0));}
  async function init(){
    if(path.resolve(await fsp.realpath(path.dirname(root)))!==path.dirname(root))C.fail('IMPORT_JOB_DIRECTORY_INVALID',503);
    try{await fsp.mkdir(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    const s=await fsp.lstat(root);
    if(!s.isDirectory()||s.isSymbolicLink()||path.resolve(await fsp.realpath(root))!==root||(uid!==undefined&&(s.uid!==uid||(s.mode&0o077))))C.fail('IMPORT_JOB_DIRECTORY_INVALID',503);
  }
  async function open(name,limit){
    const file=target(name),h=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {const s=await h.stat(),named=await fsp.lstat(file);
      if(!s.isFile()||!protectedStat(s)||!protectedStat(named)||s.ino!==named.ino||s.dev!==named.dev||s.size>limit)C.fail('IMPORT_JOB_FILE_INVALID');
      return h;
    }catch(e){await h.close();throw e;}
  }
  async function syncDirectory(){if(process.platform==='win32')return;const h=await fsp.open(root,'r');try{await h.sync();}finally{await h.close();}}
  async function remove(name){await writes.get(name);try{const h=await open(name,MAX_BYTES+262144);await h.close();await fsp.unlink(target(name));}catch(e){if(e.code!=='ENOENT')throw e;}}
  function save(job){
    C.sha(job.id);const secret=Buffer.from(JSON.stringify(job));let envelope;
    try{envelope=vault.seal(secret,context(job.id));}finally{secret.fill(0);}
    const writing=(writes.get(job.id)||Promise.resolve()).catch(()=>{}).then(()=>writeEnvelope(job.id,envelope));
    writes.set(job.id,writing);return writing.finally(()=>{if(writes.get(job.id)===writing)writes.delete(job.id);});
  }
  async function writeEnvelope(id,envelope){
    const temp='.'+crypto.randomBytes(16).toString('hex')+'.tmp',h=await fsp.open(target(temp),'wx',0o600);
    try{await h.writeFile(envelope);await h.sync();}finally{await h.close();}
    try{await fsp.rename(target(temp),target(id));await syncDirectory();}finally{await remove(temp);}
  }
  async function read(id){
    const h=await open(id,262144);let job;
    try{await vault.useSecret(await h.readFile('utf8'),context(id),bytes=>{job=JSON.parse(bytes.toString('utf8'));});}finally{await h.close();}
    if(job?.version!==1||job.id!==id||!['trade','cash','bestell'].includes(job.kind)||typeof job.owner!=='string'||!job.owner
      ||!['queued','reading','reviewing','retrying','paused','failed','completed'].includes(job.status)
      ||!Number.isSafeInteger(job.created)||!Number.isSafeInteger(job.expires)||job.expires-job.created!==RETENTION_MS
      ||!Number.isSafeInteger(job.retries)||job.retries<0||job.retries>3||!Number.isFinite(job.nextAt)
      ||!['reading','reviewing'].includes(job.phase)||job.blob&&(!BLOB.test(job.blob.name)||!job.blob.name.startsWith(id+'.')
        ||!Number.isSafeInteger(job.blob.bytes)||job.blob.bytes<4096||job.blob.bytes>MAX_BYTES))C.fail('IMPORT_JOB_STATE_INVALID');
    return job;
  }
  async function list(){await init();const names=await fsp.readdir(root),jobs=[];
    for(const name of names)if(ID.test(name))jobs.push(await read(name));
    const retained=new Set(jobs.map(j=>j.blob?.name).filter(Boolean));
    for(const name of names)if((BLOB.test(name)||/^\.[a-f0-9]{32}\.tmp$/.test(name))&&!retained.has(name)){
      const s=await fsp.lstat(target(name));if(now()-s.mtimeMs>RETENTION_MS)await remove(name);
    }
    return jobs;
  }
  async function capacity(bytes,jobs){
    if(jobs.length>=MAX_JOBS||jobs.reduce((n,j)=>n+(j.blob?.bytes||0),0)+bytes>MAX_SPOOL_BYTES)C.fail('IMPORT_JOB_QUEUE_FULL',409);
    let physical=0;for(const name of await fsp.readdir(root))if(BLOB.test(name))physical+=(await fsp.lstat(target(name))).size;
    if(physical+bytes>MAX_SPOOL_BYTES)C.fail('IMPORT_JOB_QUEUE_FULL',409);
    const free=await fsp.statfs(root);if(free.bavail*free.bsize<bytes+1024**3)C.fail('IMPORT_JOB_SPACE_REQUIRED',507);
  }
  async function encrypt(id,buffer,signal){
    const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),name=id+'.'+crypto.randomBytes(16).toString('hex')+'.source';
    const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(name));
    const h=await fsp.open(target(name),'wx',0o600);
    try{
      for(let offset=0;offset<buffer.length;offset+=1024*1024){
        if(signal?.aborted)C.fail('IMPORT_SOURCE_INTERRUPTED',409);
        const chunk=cipher.update(buffer.subarray(offset,offset+1024*1024));try{await h.writeFile(chunk);}finally{chunk.fill(0);}
      }
      await h.writeFile(cipher.final());await h.sync();
      return {name,key:key.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),bytes:buffer.length};
    }catch(e){await h.close();await remove(name);throw e;}finally{key.fill(0);await h.close();}
  }
  async function decrypt(blob,signal){
    const h=await open(blob.name,MAX_BYTES),key=Buffer.from(blob.key,'base64');let output;
    try{
      if((await h.stat()).size!==blob.bytes||key.length!==32)C.fail('IMPORT_JOB_FILE_INVALID');
      output=Buffer.allocUnsafeSlow(blob.bytes);
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(blob.iv,'base64'));
      decipher.setAAD(Buffer.from(blob.name));decipher.setAuthTag(Buffer.from(blob.tag,'base64'));let offset=0;
      const chunk=Buffer.alloc(1024*1024);let position=0;
      for(;;){
        if(signal?.aborted)C.fail('IMPORT_SOURCE_INTERRUPTED',409);
        const {bytesRead}=await h.read(chunk,0,chunk.length,position);if(!bytesRead)break;position+=bytesRead;
        const plain=decipher.update(chunk.subarray(0,bytesRead));if(offset+plain.length>output.length)C.fail('IMPORT_JOB_FILE_INVALID');plain.copy(output,offset);offset+=plain.length;plain.fill(0);
      }
      const last=decipher.final();last.copy(output,offset);offset+=last.length;last.fill(0);
      if(offset!==output.length)C.fail('IMPORT_JOB_FILE_INVALID');return output;
    }catch(e){output?.fill(0);if(e.code==='IMPORT_SOURCE_INTERRUPTED')throw e;C.fail('IMPORT_JOB_FILE_INVALID');}
    finally{key.fill(0);await h.close();}
  }
  return {init,list,read,save,capacity,encrypt,decrypt,remove,retentionMs:RETENTION_MS};
}
module.exports={createDataImportJobStore,RETENTION_MS,MAX_JOBS,MAX_SPOOL_BYTES};
