'use strict';
// Evaluate only the actual server Runtime factory statement, never server.js itself.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../lib/data-import-known-af-proof'),V=require('../lib/data-import-af-verifier'),F=require('../test-support/data-import-known-af-fixture');
test('actual server Runtime options retain the same nonempty default verifier policy as the Node asset factory',F.nativeImport,async t=>{
 const H=require('../lib/tradefoto-history-profiles'),raw={...Object.fromEntries(H.tableFor('trade',P.KNOWN.sourceTable).columns.map(column=>[column.name,null])),EAN:'0000000000701',FilialID:7,FBestand:8};
 await F.withFixture({values:{[P.KNOWN.sourceTable]:[raw,{...raw,EAN:'0000000000702'},{...raw,EAN:'0000000000703'}]},counts:{[P.KNOWN.sourceTable]:2}},async f=>{
 const policy=require('../lib/data-import-af-verifier-policy');assert.equal(policy.acceptedVerifierAssets.length,1);assert(policy.runtime);
 assert.equal(policy.runtime.descriptorSha256,policy.acceptedVerifierAssets[0].descriptorSha256);
 assert.equal(policy.runtime.descriptorSha256,'5730aa3a7269b2283cbe879cb52123d42a238606cd5840ec3f8108e4ba523d93');
 const text=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),matched=text.match(/^const dataImportRuntime=createDataImportRuntime\(([^\r\n]+)\);$/m);
 assert(matched,'Review required: actual server Runtime composition statement changed shape');
 let captured;const actual=require('../lib/persistence/repositories/data-import-runtime').createDataImportRuntime;
 const lifecycle=require('../lib/data-import-lifecycle').createDataImportLifecycle();
 const runtime=vm.runInNewContext('createDataImportRuntime('+matched[1]+')',{
  // Test-only source bytes/reader fixture; leave the server's policy options/defaults intact.
  createDataImportRuntime(options){captured=options;return actual({...options,readSource:f.options.readSource});},persistenceProvider:f.provider,integrationSecretVault:f.keyVault,dataImportLifecycle:lifecycle,
 },{timeout:1000});
 assert.equal(captured.allowApply,true);assert.equal(captured.sharedPayloads,true);assert.equal(captured.compactCash,true);assert.equal(captured.syncArticleCatalog,true);
 if(Object.hasOwn(captured,'acceptedVerifierAssets'))assert.deepEqual(captured.acceptedVerifierAssets,policy.acceptedVerifierAssets);
 t.after(async()=>{await runtime.stop();await lifecycle.stop();});
 const buffer=F.sourceBuffer();let source=await runtime.upload(f.getSession,{buffer:Buffer.from(buffer),kind:'trade',fileName:'Trade_Daten.accdb'});
 for(let n=0;source.status==='reviewing';n++){assert(n<700);source=await runtime.sourceOperation(f.getSession,source.id,'review',{expectedRevision:source.revision});}
 const request=await runtime.verificationRequest(f.getSession,source.id);assert(request);
 const verifier=V.createKnownAfSourceVerifier({toolchain:policy.acceptedVerifierAssets[0],executor:async({request:r})=>({exitCode:0,stderr:Buffer.alloc(0),stdout:Buffer.from(JSON.stringify({
  format:P.FORMAT,passed:true,binding:Object.fromEntries(['fileSha256','bytes','sourceSystem','sourceInstance','sourceTable','profileHash','applicationSchemaSha256','physicalContractSha256'].map(k=>[k,r[k]])),
  counts:{headerRows:r.declaredRows,logicalRows:r.expectedRows,uniqueLogicalRowIds:r.expectedRows},metadataMatchedBeforeRowCursor:true,physicalOrdinaryTable:true,externalLinksDenied:true,primaryIndexChecked:true,
  indexes:P.INDEX_NAMES.map(name=>({name,rows:r.expectedRows,uniqueRowIds:r.expectedRows,duplicates:0,extra:0,missing:0,exactCoverage:true})),allFourIndexesExact:true,
 }))})});
 const evidence=await verifier.verify({request,buffer});
 source=await runtime.attachIndependentCountProof(f.getSession,source.id,{expectedRevision:request.sourceRevision,evidence});
 assert.equal(source.independentCountVerification.verified,true,'A silently empty Runtime default would reject this actual pinned tuple');
 assert.equal(source.tables.find(table=>table.name===P.KNOWN.sourceTable).run.sourceToleranceReceipts.length,0);
 assert(source.tables.find(table=>table.name===P.KNOWN.sourceTable).run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));
 buffer.fill(0);
 });
});
