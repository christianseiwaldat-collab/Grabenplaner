'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{TextDecoder}=require('node:util');
const C=require('./data-import-contract'),P=require('./data-import-known-af-proof');
const DEFAULTS=require('./data-import-af-verifier-policy');
const VERIFIED=new WeakSet(),MAX_OUTPUT=65536,MAX_ERROR=4096;
const DESCRIPTOR_KEYS=['format','schemaVersion','assetId','platform','installPrefix','javaPath','jars','helperClassesRoot','helperMainClass','classFiles','files','completeTreeSha256','executableAllowlist','licenseManifest','provenanceManifest'];
const COORDINATES=Object.freeze(['com.healthmarketscience.jackcess:jackcess:4.0.12','org.apache.commons:commons-lang3:3.18.0','commons-logging:commons-logging:1.2','com.google.code.gson:gson:2.13.2']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(code='IMPORT_SOURCE_VERIFIER_UNAVAILABLE')=>C.fail(code,409);
function strict(value,keys){if(!C.plain(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();C.exact(value,keys);}
function relative(value){if(typeof value!=='string'||!value||value.length>240||/[\u0000-\u001f\u007f\\:]/u.test(value)||path.posix.isAbsolute(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))fail();return value;}
function within(root,value){relative(value);const target=path.resolve(root,...value.split('/'));if(!target.startsWith(path.resolve(root)+path.sep))fail();return target;}
function assetFile(value,keys=['path','bytes','sha256']){strict(value,keys);relative(value.path);C.integer(value.bytes,1,128*1024*1024);C.sha(value.sha256);if(keys.includes('mode')&&![0o644,0o755].includes(value.mode))fail();return value;}
function protectedAsset(stat,executable){
  if(process.platform!=='linux')return;
  if(stat.uid!==0||(stat.mode&0o022)!==0||(stat.mode&0o7000)!==0)fail();
  if(executable!==undefined&&Boolean(stat.mode&0o111)!==executable)fail();
}
async function readPinned(root,file,signal){
  const target=within(root,file.path);let current=path.resolve(root);
  for(const part of file.path.split('/').slice(0,-1)){current=path.join(current,part);const s=await fsp.lstat(current);if(!s.isDirectory()||s.isSymbolicLink())fail();protectedAsset(s);}
  const named=await fsp.lstat(target);if(!named.isFile()||named.isSymbolicLink()||named.size!==file.bytes||named.nlink!==1)fail();
  protectedAsset(named,file.mode===0o755);
  const h=await fsp.open(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const hash=crypto.createHash('sha256');let total=0;
  try{const before=await h.stat();if(before.ino!==named.ino||before.dev!==named.dev||before.size!==file.bytes)fail();
    const buffer=Buffer.alloc(1024*1024);try{for(;;){if(signal?.aborted)fail('IMPORT_SOURCE_INTERRUPTED');const {bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      if(total===0&&file.mode===0o755&&(bytesRead<64||buffer.readUInt32BE(0)!==0x7f454c46||buffer[4]!==2||buffer[5]!==1||buffer.readUInt16LE(18)!==62))fail();
      total+=bytesRead;if(total>file.bytes)fail();hash.update(buffer.subarray(0,bytesRead));}}
    finally{buffer.fill(0);}const after=await h.stat();if(total!==file.bytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash.digest('hex')!==file.sha256)fail();
    // Bundle0644/0755 becomes root:servicegroup0640/0750 after installation.
    // Pin execute semantics and immutability, not the group's read bit layout.
    protectedAsset(after,file.mode===0o755);
  }finally{await h.close();}return target;
}
async function assetTree(root,descriptorName,files){
  const actual=[];async function walk(dir,prefix='',depth=0){if(depth>12)fail();const entries=await fsp.readdir(dir,{withFileTypes:true});
    for(const entry of entries){const rel=prefix+entry.name;if(entry.isSymbolicLink())fail();if(entry.isDirectory())await walk(path.join(dir,entry.name),rel+'/',depth+1);
      else if(entry.isFile()){if(rel!==descriptorName)actual.push(rel);if(actual.length>1000)fail();}else fail();}}
  await walk(root);if(!C.equal(actual.sort(),files.map(file=>file.path).sort()))fail();
}
function validateAssetDescriptor(d){
  strict(d,DESCRIPTOR_KEYS);if(d.format!=='gp-af-verifier-runtime-assets-v1'||d.schemaVersion!==1)fail();C.id(d.assetId);
  strict(d.platform,['os','arch','libc']);if(d.platform.os!=='linux'||d.platform.arch!=='x64'||d.platform.libc!=='glibc')fail();
  relative(d.installPrefix);relative(d.javaPath);relative(d.helperClassesRoot);
  if(d.installPrefix!=='lib/import-verifier-assets/'+d.assetId||d.javaPath!=='jre/bin/java'||d.helperClassesRoot!=='helper/classes'||d.helperMainClass!=='KnownAfCountVerifier')fail();
  if(!Array.isArray(d.files)||!d.files.length||d.files.length>1000||!Array.isArray(d.jars)||d.jars.length!==4||!Array.isArray(d.classFiles)||!d.classFiles.length||d.classFiles.length>16)fail();
  d.files.forEach(file=>assetFile(file,['path','bytes','sha256','mode']));if(new Set(d.files.map(file=>file.path)).size!==d.files.length||d.files.reduce((n,f)=>n+f.bytes,0)>512*1024*1024)fail();
  const sorted=[...d.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);if(!C.equal(d.files,sorted)||C.fingerprint(d.files)!==d.completeTreeSha256)fail();
  const byPath=new Map(d.files.map(file=>[file.path,file]));
  const included=file=>{const stored=byPath.get(file.path);if(!stored||stored.bytes!==file.bytes||stored.sha256!==file.sha256)fail();};
  d.jars.forEach(file=>{assetFile(file,['path','bytes','sha256','coordinate']);included(file);if(!COORDINATES.includes(file.coordinate))fail();});
  if(!C.equal(d.jars.map(file=>file.coordinate),COORDINATES))fail();
  d.classFiles.forEach(file=>{assetFile(file);included(file);if(!file.path.startsWith(d.helperClassesRoot+'/')||!file.path.endsWith('.class'))fail();});
  const fixedClasses=['KnownAfCountVerifier$Deadline.class','KnownAfCountVerifier$Input.class','KnownAfCountVerifier$Options.class','KnownAfCountVerifier$Rejected.class','KnownAfCountVerifier.class'];
  if(!C.equal(d.classFiles.map(file=>file.path).sort(),fixedClasses.map(name=>d.helperClassesRoot+'/'+name).sort()))fail();
  for(const key of ['licenseManifest','provenanceManifest']){assetFile(d[key]);included(d[key]);}
  if(!Array.isArray(d.executableAllowlist)||!d.executableAllowlist.length||d.executableAllowlist.length>16)fail();
  d.executableAllowlist.forEach(file=>{strict(file,['path','sha256']);relative(file.path);C.sha(file.sha256);const stored=byPath.get(file.path);if(!stored||stored.sha256!==file.sha256||stored.mode!==0o755)fail();});
  if(!d.executableAllowlist.some(file=>file.path===d.javaPath)||d.files.some(file=>file.mode===0o755&&!d.executableAllowlist.some(allowed=>allowed.path===file.path)))fail();
  return d;
}
async function resolveAssets(options,signal){
  if(!options.assetRoot||!options.descriptorPath||!options.descriptorSha256)fail();C.sha(options.descriptorSha256);
  const root=path.resolve(options.assetRoot);if(root.includes(path.delimiter))fail();
  const rootStat=await fsp.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())fail();
  protectedAsset(rootStat);
  if(await fsp.realpath(root)!==root)fail();
  if(options.appRoot){const appRoot=path.resolve(options.appRoot);if(root!==appRoot&&!root.startsWith(appRoot+path.sep))fail();
    let current=root;for(;;){const stat=await fsp.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail();protectedAsset(stat);if(current===appRoot)break;
      const parent=path.dirname(current);if(parent===current)fail();current=parent;}}
  const descriptorName=relative(options.descriptorPath),descriptorFile=within(root,descriptorName),s=await fsp.lstat(descriptorFile);
  if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>262144||s.nlink!==1)fail();
  protectedAsset(s,false);
  const handle=await fsp.open(descriptorFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let bytes;
  try{const opened=await handle.stat();if(opened.ino!==s.ino||opened.dev!==s.dev||opened.size!==s.size)fail();
    const buffer=Buffer.alloc(s.size+1);let offset=0;for(;;){if(signal?.aborted)fail('IMPORT_SOURCE_INTERRUPTED');const r=await handle.read(buffer,offset,buffer.length-offset,null);if(!r.bytesRead)break;offset+=r.bytesRead;if(offset>s.size)fail();}
    const after=await handle.stat();if(offset!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs)fail();bytes=buffer.subarray(0,offset);
  }finally{await handle.close();}
  if(sha(bytes)!==options.descriptorSha256)fail();let d;try{d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail();}
  validateAssetDescriptor(d);
  if(process.platform!=='linux'||process.arch!=='x64'||!process.report?.getReport?.().header.glibcVersionRuntime)fail();
  if(options.appRoot&&path.resolve(options.appRoot,...d.installPrefix.split('/'))!==root)fail();
  await assetTree(root,descriptorName,d.files);for(const file of d.files)await readPinned(root,file,signal);
  return {root,java:within(root,d.javaPath),classpath:[within(root,d.helperClassesRoot),...d.jars.map(file=>within(root,file.path))].join(path.delimiter),
    verifier:{protocol:P.FORMAT,descriptorSha256:options.descriptorSha256,completeTreeSha256:d.completeTreeSha256}};
}
const PYTHON_EXEC='import os,resource,sys\nresource.setrlimit(resource.RLIMIT_CORE,(0,0))\nresource.setrlimit(resource.RLIMIT_CPU,(85,85))\nresource.setrlimit(resource.RLIMIT_FSIZE,(0,0))\nos.execve(sys.argv[1],sys.argv[1:],dict(os.environ))';
async function executeProcess({assets,buffer,request,signal,pythonExecutable='/usr/bin/python3',spawnImpl=spawn}){
  if(pythonExecutable!=='/usr/bin/python3')fail();
  const args=['-I','-B','-c',PYTHON_EXEC,assets.java,'-Dfile.encoding=UTF-8','-Djava.io.tmpdir=/nonexistent/gp-import-verifier-no-temp',
    '-Xmx768m','-XX:MaxDirectMemorySize=16m','-XX:-HeapDumpOnOutOfMemoryError','-XX:-CreateCoredumpOnCrash','-XX:-UsePerfData','-XX:ErrorFile=/dev/null',
    '-cp',assets.classpath,'KnownAfCountVerifier','--bytes',String(request.bytes),'--sha256',request.fileSha256,'--deadline-ms','80000','--row-limit','2000000','--json-cap','65536'];
  const child=spawnImpl(pythonExecutable,args,{cwd:assets.root,shell:false,detached:true,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',PATH:'/usr/bin:/bin'}});
  let output=[],errors=[],outBytes=0,errorBytes=0,failure=null;
  const stop=code=>{failure ||= code;try{if(child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
  const abort=()=>stop('IMPORT_SOURCE_INTERRUPTED');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const closed=new Promise(resolve=>{child.once('error',()=>{failure ||= 'IMPORT_SOURCE_VERIFIER_UNAVAILABLE';});child.once('close',(code,sig)=>resolve({code,sig}));});
  child.stdout.on('data',chunk=>{outBytes+=chunk.length;if(outBytes>MAX_OUTPUT)stop('IMPORT_SOURCE_VERIFIER_OUTPUT_LIMIT');else output.push(chunk);});
  child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>MAX_ERROR)stop('IMPORT_SOURCE_VERIFIER_OUTPUT_LIMIT');else errors.push(chunk);});
  child.stdout.on('error',()=>stop('IMPORT_SOURCE_VERIFICATION_FAILED'));
  child.stderr.on('error',()=>stop('IMPORT_SOURCE_VERIFICATION_FAILED'));
  child.stdin.on('error',()=>{failure ||= 'IMPORT_SOURCE_VERIFICATION_FAILED';});
  try{
    for(let offset=0;offset<buffer.length;offset+=1024*1024){if(failure||signal?.aborted)break;const chunk=buffer.subarray(offset,offset+1024*1024);
      await new Promise((resolve,reject)=>child.stdin.write(chunk,error=>error?reject(error):resolve()));}
    child.stdin.end();const ended=await closed;if(failure)fail(failure);
    return {stdout:Buffer.concat(output),stderr:Buffer.concat(errors),exitCode:ended.code};
  }catch(error){stop(error instanceof C.DataImportError?error.code:'IMPORT_SOURCE_VERIFICATION_FAILED');await closed;if(error instanceof C.DataImportError)throw error;fail(failure);}
  finally{signal?.removeEventListener('abort',abort);if(child.exitCode===null&&child.signalCode===null){stop('IMPORT_SOURCE_INTERRUPTED');await closed;}output=[];errors=[];}
}
function assertVerifiedHelperEvidence(value){if(!VERIFIED.has(value))fail('IMPORT_SOURCE_PROOF_UNTRUSTED');return value;}
function createKnownAfSourceVerifier(options={}){
  if(!C.plain(options))fail();
  options={...(DEFAULTS.runtime?{...DEFAULTS.runtime,appRoot:path.resolve(__dirname,'..'),assetRoot:path.resolve(__dirname,'..',DEFAULTS.runtime.installPrefix)}:{}),...options};
  const {clock=()=>new Date().toISOString(),executor=null,toolchain=null}=options;
  if(typeof clock!=='function'||executor!==null&&typeof executor!=='function')fail();
  // No IO, platform resolution, process spawn, key access or environment fallback here.
  return Object.freeze({async verify({request,buffer,signal}){
    P.request(request);if(!Buffer.isBuffer(buffer)||buffer.length!==request.bytes||sha(buffer)!==request.fileSha256)fail('IMPORT_SOURCE_HASH_MISMATCH');
    if(signal?.aborted)fail('IMPORT_SOURCE_INTERRUPTED');const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(),90000);let reply,policy;
    try{
      if(executor){if(!toolchain)fail();policy=P.validateVerifierPolicy(toolchain);reply=await executor({request,buffer,signal:controller.signal});}
      else{const assets=await resolveAssets(options,controller.signal);policy=assets.verifier;reply=await executeProcess({assets,buffer,request,signal:controller.signal,pythonExecutable:options.pythonExecutable,spawnImpl:options.spawnImpl});}
      if(controller.signal.aborted)fail(signal?.aborted?'IMPORT_SOURCE_INTERRUPTED':'IMPORT_SOURCE_VERIFIER_TIMEOUT');
      strict(reply,['stdout','stderr','exitCode']);if(!Buffer.isBuffer(reply.stdout)||!Buffer.isBuffer(reply.stderr)||reply.stdout.length>MAX_OUTPUT||reply.stderr.length>MAX_ERROR)fail('IMPORT_SOURCE_VERIFIER_OUTPUT_LIMIT');
      if(reply.exitCode!==0||reply.stderr.length!==0)fail('IMPORT_SOURCE_VERIFICATION_FAILED');let result;
      try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply.stdout));}catch{fail('IMPORT_SOURCE_VERIFICATION_FAILED');}
      P.helperResult(result,request);const value=JSON.parse(C.canonical({request,result,verifier:policy,verifiedAt:C.utc(clock())}));P.evidence(value);C.freeze(value);VERIFIED.add(value);return value;
    }catch(error){if(controller.signal.aborted&&!signal?.aborted)fail('IMPORT_SOURCE_VERIFIER_TIMEOUT');if(error instanceof C.DataImportError)throw error;fail('IMPORT_SOURCE_VERIFIER_UNAVAILABLE');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }});
}
module.exports={createKnownAfSourceVerifier,assertVerifiedHelperEvidence,resolveAssets,validateAssetDescriptor,runKnownAfVerifierProcess:executeProcess};
