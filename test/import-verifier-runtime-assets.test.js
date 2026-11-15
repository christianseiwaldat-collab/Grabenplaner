'use strict';
// Structural policy tests: no real Java/JAR execution or downloaded payload.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const P=require('../lib/import-verifier-runtime-assets');
const F=require('../test-support/import-verifier-assets-fixture');
const POLICY=require('../lib/data-import-af-verifier-policy');
const DESCRIPTOR_SHA='5730aa3a7269b2283cbe879cb52123d42a238606cd5840ec3f8108e4ba523d93';
const TREE_SHA='1dcc2d6be1936c6d83a0798123e19e9b6452027f567ffdc92313420db939cfe6';
const EXECUTABLES=['jre/bin/java','jre/bin/jfr','jre/bin/jrunscript','jre/bin/keytool','jre/bin/rmiregistry','jre/lib/jexec','jre/lib/jspawnhelper'];
const fail=code=>e=>e?.code===code;

test('known source index, acquisition lock, descriptor and accepted runtime policy bind the same exact asset',t=>{
 const f=F.actualSourceFixture(t),index=f.readIndex(),descriptorBytes=fs.readFileSync(path.join(f.inputs,'descriptor.json')),descriptor=JSON.parse(descriptorBytes);
 assert.equal(index.currentAsset,F.ASSET_ID);assert.equal(index.assets.length,1);assert.equal(index.assets[0].sha256,DESCRIPTOR_SHA);assert.equal(F.sha(descriptorBytes),DESCRIPTOR_SHA);
 assert.equal(P.validateDescriptor(descriptor,F.ASSET_ID),descriptor);assert.equal(descriptor.completeTreeSha256,TREE_SHA);assert.equal(P.fingerprint(descriptor.files),TREE_SHA);assert.equal(descriptor.files.length,291);
 assert.deepEqual(P.EXECUTABLES,EXECUTABLES);assert.equal(descriptor.executableAllowlist.length,7);assert.equal(f.lock.trackedFiles.length,29);
 assert.equal(f.lock.descriptor.sha256,DESCRIPTOR_SHA);assert.equal(f.lock.completeTreeSha256,TREE_SHA);assert.equal(f.lock.runtimeIndex.sha256,F.sha(fs.readFileSync(f.indexPath)));assert.equal(f.lock.materializationPlan.sha256,F.sha(fs.readFileSync(f.planPath)));
 assert.equal(POLICY.runtime.descriptorSha256,DESCRIPTOR_SHA);assert.equal(POLICY.runtime.installPrefix,descriptor.installPrefix);assert(POLICY.acceptedVerifierAssets.some(a=>a.protocol==='gp-known-af-independent-count-v1'&&a.descriptorSha256===DESCRIPTOR_SHA&&a.completeTreeSha256===TREE_SHA));
 assert(!f.lock.trackedFiles.some(file=>file.path.startsWith('jre/')||file.path.startsWith('jars/')),'Large JRE/JAR payload stays outside tracked source evidence');
});
test('source-only inspection verifies small evidence without asserting installed payload or executable permission',t=>{
 const f=F.actualSourceFixture(t),result=P.inspectDeclaredRuntimeAssets(f.root);assert.equal(result.status,'declared_source_only');assert.equal(result.descriptorSha256,DESCRIPTOR_SHA);assert.equal(result.completeTreeSha256,TREE_SHA);assert.equal(result.filesDeclared,291);
 assert.deepEqual(result.executableModes,[]);assert.deepEqual(result.observation,{payloadBytesVerified:false,declaredSmallInputsVerified:true,javaExecuted:false,installedPayloadObserved:false,authenticityOrVulnerabilityClearance:false});
 assert.throws(()=>P.inspectRuntimeAssets(f.root),fail('ASSET_PARTIAL_INSTALLATION'));
});
test('old asset-free source remains empty, while a partial physical installation fails closed',t=>{
 const root=F.temporary(t);assert.equal(P.inspectRuntimeAssets(root),null);assert.equal(P.inspectDeclaredRuntimeAssets(root),null);fs.mkdirSync(path.join(root,'lib/import-verifier-assets'),{recursive:true});assert.throws(()=>P.inspectRuntimeAssets(root),fail('ASSET_PARTIAL_INSTALLATION'));assert.throws(()=>P.inspectDeclaredRuntimeAssets(root),fail('ASSET_PARTIAL_INSTALLATION'));
});
test('source declaration refuses any physical payload tree even alongside valid small evidence',t=>{
 const f=F.actualSourceFixture(t);fs.mkdirSync(path.join(f.root,'lib/import-verifier-assets'),{recursive:true});assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_DECLARATION_HAS_PAYLOAD'));
});
test('source index cannot silently broaden version count or point to a foreign descriptor',t=>{
 const f=F.actualSourceFixture(t),index=f.readIndex();index.assets.push({...index.assets[0]});F.json(f.indexPath,index);assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_INDEX'));index.assets.pop();index.assets[0].descriptorPath='lib/import-verifier-assets/foreign/descriptor.json';F.json(f.indexPath,index);assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_INDEX_ENTRY'));
});
test('source lock requires exact asset scope, complete tree and all 29 tracked references',t=>{
 const f=F.actualSourceFixture(t);f.lock.assetId='foreign';f.saveLock();assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_LOCK'));f.lock.assetId=F.ASSET_ID;f.lock.completeTreeSha256='0'.repeat(64);f.saveLock();assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_LOCK'));f.lock.completeTreeSha256=TREE_SHA;f.lock.trackedFiles.pop();f.saveLock();assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_LOCK'));
});
test('source tracked reference cannot redirect a payload or grant it executable mode',t=>{
 const f=F.actualSourceFixture(t),item=f.lock.trackedFiles[0],source=item.source;item.source='other/payload/'+item.path;f.saveLock();assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_REFERENCE'));item.source=source;item.mode=0o755;f.saveLock();assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_REFERENCE'));
});
test('same-size source evidence tampering and missing source bytes fail closed',t=>{
 const f=F.actualSourceFixture(t),target=F.within(f.root,f.lock.trackedFiles[0].source),bytes=fs.readFileSync(target);bytes[0]^=1;fs.writeFileSync(target,bytes);assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_BYTES'));fs.unlinkSync(target);assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ENOENT'));
});
test('source materialization plan remains byte-bound and undeclared inputs are rejected',t=>{
 const f=F.actualSourceFixture(t);fs.appendFileSync(f.planPath,' ');assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_PLAN'));fs.writeFileSync(f.planPath,fs.readFileSync(f.planPath).subarray(0,fs.statSync(f.planPath).size-1));fs.writeFileSync(path.join(f.inputs,'unlisted.jar'),'synthetic unexpected input');assert.throws(()=>P.inspectDeclaredRuntimeAssets(f.root),fail('ASSET_SOURCE_INPUT_SET'));
});
test('descriptor entrypoint, Maven identity and unrecognized fields cannot be broadened',t=>{
 const f=F.syntheticPhysicalFixture(t),copy=()=>JSON.parse(JSON.stringify(f.descriptor));let d=copy();d.helperMainClass='Other';assert.throws(()=>P.validateDescriptor(d,f.assetId),fail('ASSET_ENTRYPOINT'));d=copy();d.jars[0].coordinate='unknown:component:1';assert.throws(()=>P.validateDescriptor(d,f.assetId),fail('ASSET_MAVEN'));d=copy();d.downloadFallback='https://example.invalid';assert.throws(()=>P.validateDescriptor(d,f.assetId),fail('ASSET_SHAPE'));d=copy();d.platform.arch='arm64';assert.throws(()=>P.validateDescriptor(d,f.assetId),fail('ASSET_PLATFORM'));
});
test('tiny structural physical tree gives exactly seven individually pinned executable modes and no Java execution',t=>{
 const f=F.syntheticPhysicalFixture(t),result=P.inspectRuntimeAssets(f.root);assert.equal(result.executableModes.length,7);assert.deepEqual(result.executableModes.map(x=>x.path),EXECUTABLES.map(x=>f.prefix+'/'+x));assert(result.executableModes.every(x=>x.mode===0o755));assert.equal(result.observation.javaExecuted,false);assert.equal(result.observation.authenticityOrVulnerabilityClearance,false);assert(!result.executableModes.some(x=>x.path.endsWith('.jar')||x.path.endsWith('.so')));
});
for(const executable of EXECUTABLES)test('even repinned '+executable+' requires x64 little-endian ELF bytes',t=>{
 const f=F.syntheticPhysicalFixture(t),bad=Buffer.alloc(64);Buffer.from([127,69,76,70,2,1]).copy(bad);bad.writeUInt16LE(183,18);f.replace(executable,bad);assert.throws(()=>P.inspectRuntimeAssets(f.root),fail('ASSET_NOT_X64_ELF'));
});
test('extension or directory prefix cannot turn an unlisted library or JAR into an executable',t=>{
 const f=F.syntheticPhysicalFixture(t);f.descriptor.files.find(x=>x.path.endsWith('.so')).mode=0o755;f.persist();assert.throws(()=>P.inspectRuntimeAssets(f.root),fail('ASSET_EXECUTABLE_SET'));
});
test('missing physical payload and mismatched bytecode version are rejected',t=>{
 const f=F.syntheticPhysicalFixture(t),jar=path.join(f.asset,'jars/component-0.jar'),bytes=fs.readFileSync(jar);fs.unlinkSync(jar);assert.throws(()=>P.inspectRuntimeAssets(f.root),fail('ASSET_PHYSICAL_SET'));fs.writeFileSync(jar,bytes);f.replace('helper/classes/KnownAfCountVerifier.class',Buffer.from([202,254,186,190,0,0,0,65]));assert.throws(()=>P.inspectRuntimeAssets(f.root),fail('ASSET_NOT_JAVA17_CLASS'));
});
