'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FORMAT='grabenplaner-postgresql-pair';
const SHA=/^[a-f0-9]{64}$/;
function syncFile(file){const fd=fs.openSync(file,process.platform==='win32'?'r+':'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDirectory(directory){if(process.platform!=='win32')syncFile(directory);}
function safeRoot(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)===path.parse(root).root||fs.realpathSync(root)!==root)throw new Error('PG_PAIR_ROOT');
 const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)))throw new Error('PG_PAIR_ROOT');
 return root;
}
function safePath(root,name){
 if(typeof name!=='string'||name.length>500||!name.split('/').every(p=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)&&p!=='.'&&p!=='..'))throw new Error('PG_PAIR_COMPONENT_PATH');
 const target=path.resolve(root,...name.split('/'));if(!target.startsWith(root+path.sep))throw new Error('PG_PAIR_COMPONENT_PATH');return target;
}
async function digest(file){
 const before=fs.lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new Error('PG_PAIR_COMPONENT_TYPE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
 const same=stat=>stat.dev===before.dev&&stat.ino===before.ino&&stat.size===before.size&&stat.mtimeMs===before.mtimeMs&&stat.ctimeMs===before.ctimeMs;
 try{
  if(!same(fs.fstatSync(fd)))throw new Error('PG_PAIR_COMPONENT_CHANGED');
  let count;while((count=fs.readSync(fd,buffer))>0)hash.update(buffer.subarray(0,count));
  if(!same(fs.fstatSync(fd))||!same(fs.lstatSync(file)))throw new Error('PG_PAIR_COMPONENT_CHANGED');
  return {bytes:before.size,sha256:hash.digest('hex')};
 }finally{fs.closeSync(fd);}
}
async function inventory(root,directory=root,{content=true}={}){
 const result=[];
 for(const name of fs.readdirSync(directory).sort()){
  const file=path.join(directory,name),relative=path.relative(root,file).split(path.sep).join('/');safePath(root,relative);
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('PG_PAIR_COMPONENT_TYPE');
  if(stat.isDirectory())result.push(...await inventory(root,file,{content}));else {
   if(!stat.isFile()||stat.nlink!==1)throw new Error('PG_PAIR_COMPONENT_TYPE');
   result.push({file:relative,...(content?await digest(file):{bytes:stat.size})});
  }
 }
 return result;
}
async function verifyPairBundle(directory,markerFile,{expectedSha256,verifyContent=true}={}){
 safeRoot(directory);
 if(path.dirname(markerFile)!==path.dirname(directory)||!path.basename(markerFile).endsWith('.complete.json'))throw new Error('PG_PAIR_MARKER_PATH');
 await digest(markerFile);
 if(fs.statSync(markerFile).size>4096)throw new Error('PG_PAIR_MARKER_SIZE');
 const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));
 if(marker.format!==FORMAT||marker.schemaVersion!==1||marker.bundle!==path.basename(directory)||!SHA.test(marker.manifestSha256)||expectedSha256&&marker.manifestSha256!==expectedSha256)throw new Error('PG_PAIR_MARKER');
 const manifestPath=path.join(directory,'manifest.json');
 const manifestDigest=await digest(manifestPath);
 if(manifestDigest.bytes>4*1024*1024||manifestDigest.sha256!==marker.manifestSha256)throw new Error('PG_PAIR_MANIFEST_HASH');
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(manifest.format!==FORMAT||manifest.schemaVersion!==1||manifest.snapshotId!==marker.snapshotId||!Array.isArray(manifest.databases)||manifest.databases.map(d=>d.domain).join(',')!=='core,sales'||!Array.isArray(manifest.files))throw new Error('PG_PAIR_MANIFEST');
 const names=new Set();for(const entry of manifest.files){safePath(directory,entry.file);if(names.has(entry.file)||!SHA.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0)throw new Error('PG_PAIR_COMPONENT');names.add(entry.file);}
 if(manifest.databases[0].database===manifest.databases[1].database)throw new Error('PG_PAIR_DATABASE_SET');
 for(const database of manifest.databases)if(!/^[a-z][a-z0-9_]{0,62}$/.test(database.database)||database.file!==database.domain+'.dump'||!names.has(database.file))throw new Error('PG_PAIR_DATABASE_SET');
 for(const file of ['configuration.env','roles.sql'])if(!names.has(file))throw new Error('PG_PAIR_REQUIRED_COMPONENT');
 const actual=(await inventory(directory,directory,{content:verifyContent})).filter(e=>e.file!=='manifest.json');
 if(actual.length!==manifest.files.length||actual.some((entry,i)=>entry.file!==manifest.files[i].file||entry.bytes!==manifest.files[i].bytes||verifyContent&&entry.sha256!==manifest.files[i].sha256))throw new Error('PG_PAIR_COMPONENT_HASH');
 return {verified:true,verificationScope:verifyContent?'complete-file-content':'manifest-and-sizes',manifest,manifestSha256:marker.manifestSha256,files:actual.length,bytes:actual.reduce((n,e)=>n+e.bytes,0)};
}
async function sealPairBundle(directory,{databases,checkpoint,snapshotId=crypto.randomUUID(),createdAt=new Date().toISOString()}={}){
 safeRoot(directory);
 const manifestPath=path.join(directory,'manifest.json'),markerFile=directory+'.complete.json';
 if(fs.existsSync(manifestPath)||fs.existsSync(markerFile))throw new Error('PG_PAIR_ALREADY_SEALED');
 const manifest={format:FORMAT,schemaVersion:1,snapshotId,createdAt,databases,checkpoint,files:await inventory(directory)};
 for(const entry of manifest.files)syncFile(safePath(directory,entry.file));
 fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 syncFile(manifestPath);syncDirectory(directory);
 const manifestSha256=(await digest(manifestPath)).sha256;
 const pending=directory+'.pending.complete.json';
 fs.writeFileSync(pending,JSON.stringify({format:FORMAT,schemaVersion:1,snapshotId,bundle:path.basename(directory),manifestSha256})+'\n',{flag:'wx',mode:0o600});
 syncFile(pending);await verifyPairBundle(directory,pending);
 fs.linkSync(pending,markerFile);fs.unlinkSync(pending);syncDirectory(path.dirname(directory));
 return {providerId:'postgresql-pair',bundle:directory,commitMarker:markerFile,sha256:manifestSha256,createdAt};
}
module.exports={FORMAT,safeRoot,safePath,digest,inventory,verifyPairBundle,sealPairBundle};
