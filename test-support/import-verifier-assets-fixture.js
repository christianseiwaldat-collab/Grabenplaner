'use strict';
// Small test fixtures only. Synthetic ELF/class/JAR bytes are never executed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const P=require('../lib/import-verifier-runtime-assets');
const ASSET_ID='known-af-v2-temurin17.0.21_9-jackcess4.0.12-r1';
const INPUTS='scripts/security/import-verifier-assets/'+ASSET_ID;
const INDEX='lib/import-verifier-runtime-assets.json';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function save(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
function json(file,value){save(file,JSON.stringify(value));}
function within(root,name){assert(typeof name==='string'&&!path.isAbsolute(name)&&name.split(/[\\/]/).every(p=>p&&p!=='.'&&p!=='..'));const out=path.resolve(root,name);assert(out.startsWith(root+path.sep));return out;}
function temporary(t){const parent=fs.realpathSync(os.tmpdir());if(process.platform==='win32')assert.equal(path.parse(parent).root.toUpperCase(),'C:\\');const root=fs.mkdtempSync(path.join(parent,'gp-af-asset-policy-'));t.after(()=>{assert.equal(fs.realpathSync(root),root);assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});});return root;}
function actualSourceFixture(t){
 const root=temporary(t),source=path.resolve(__dirname,'..'),lock=JSON.parse(fs.readFileSync(within(source,INPUTS+'/acquisition-lock.json'),'utf8'));
 assert.equal(lock.trackedFiles.length,29);assert(lock.trackedFiles.reduce((n,f)=>n+f.bytes,0)<1024*1024);
 const names=[INDEX,...['descriptor.json','acquisition-lock.json','materialization-plan.json'].map(n=>INPUTS+'/'+n),...lock.trackedFiles.map(f=>f.source)];
 assert.equal(new Set(names).size,names.length);let total=0;
 for(const name of names){const src=within(source,name),stat=fs.lstatSync(src);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<2*1024*1024);const b=fs.readFileSync(src);total+=b.length;assert(total<2*1024*1024);save(within(root,name),b);}
 return {root,inputs:within(root,INPUTS),lock,indexPath:within(root,INDEX),lockPath:within(root,INPUTS+'/acquisition-lock.json'),planPath:within(root,INPUTS+'/materialization-plan.json'),readIndex:()=>JSON.parse(fs.readFileSync(within(root,INDEX),'utf8')),saveLock:()=>json(within(root,INPUTS+'/acquisition-lock.json'),lock)};
}
function syntheticPhysicalFixture(t){
 const root=temporary(t),assetId='synthetic-policy-r1',prefix='lib/import-verifier-assets/'+assetId,asset=within(root,prefix),payload=new Map();
 const elf=Buffer.alloc(64);Buffer.from([127,69,76,70,2,1]).copy(elf);elf.writeUInt16LE(62,18);
 for(const name of P.EXECUTABLES)payload.set(name,Buffer.from(elf));
 payload.set('jre/lib/server/libjvm.so',Buffer.from('synthetic non-executable library'));
 payload.set('helper/classes/KnownAfCountVerifier.class',Buffer.from([202,254,186,190,0,0,0,61]));
 for(let n=0;n<4;n++)payload.set('jars/component-'+n+'.jar',Buffer.from('synthetic jar placeholder '+n));
 for(const name of ['license-manifest.json','provenance-manifest.json','runtime-components.cdx.json'])payload.set(name,Buffer.from('{}'));
 const ref=name=>({path:name,bytes:payload.get(name).length,sha256:sha(payload.get(name))});
 const files=[...payload.keys()].sort().map(name=>({...ref(name),mode:P.EXECUTABLES.includes(name)?0o755:0o644}));
 const descriptor={format:'gp-af-verifier-runtime-assets-v1',schemaVersion:1,assetId,platform:{os:'linux',arch:'x64',libc:'glibc'},installPrefix:prefix,javaPath:'jre/bin/java',jars:P.COORDINATES.map((coordinate,n)=>({...ref('jars/component-'+n+'.jar'),coordinate})),helperClassesRoot:'helper/classes',helperMainClass:'KnownAfCountVerifier',classFiles:[ref('helper/classes/KnownAfCountVerifier.class')],files,completeTreeSha256:P.fingerprint(files),executableAllowlist:P.EXECUTABLES.map(name=>({path:name,sha256:ref(name).sha256})),licenseManifest:ref('license-manifest.json'),provenanceManifest:ref('provenance-manifest.json')};
 for(const [name,bytes]of payload)save(within(asset,name),bytes);
 function persist(){descriptor.completeTreeSha256=P.fingerprint(descriptor.files);json(within(asset,'descriptor.json'),descriptor);json(within(root,INDEX),{format:'gp-af-verifier-runtime-assets-index-v1',schemaVersion:1,currentAsset:assetId,assets:[{assetId,descriptorPath:prefix+'/descriptor.json',sha256:sha(fs.readFileSync(within(asset,'descriptor.json')))}]});}
 function replace(name,bytes){save(within(asset,name),bytes);const file=descriptor.files.find(f=>f.path===name);assert(file);file.bytes=bytes.length;file.sha256=sha(bytes);for(const list of [descriptor.jars,descriptor.classFiles,descriptor.executableAllowlist])for(const ref of list)if(ref.path===name){ref.sha256=file.sha256;if(Object.hasOwn(ref,'bytes'))ref.bytes=file.bytes;}persist();}
 persist();return{root,asset,assetId,prefix,descriptor,persist,replace};
}
module.exports={ASSET_ID,INPUTS,INDEX,sha,json,save,within,temporary,actualSourceFixture,syntheticPhysicalFixture};
