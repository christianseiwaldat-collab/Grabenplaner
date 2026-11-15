'use strict';
// Trusted composition and authenticated-source loader only. Never an HTTP proof API.
const C=require('./data-import-contract');
const T=require('./data-import-source-tolerance');
const FORMAT='gp-known-af-independent-count-v1', RECEIPT='gp.known-af-independent-count.v1';
const KNOWN=C.freeze({kind:'trade',sourceSystem:'tradefoto.history.trade',sourceInstance:'tradefoto-trade',sourceTable:'ARTIKEL_FILIALEN',
  profileHash:'6f0b0798b089440320a755b9999334aad7ef858a28cb1efacf2e63437eb52a41',
  applicationSchemaSha256:'6eb145ac270d384c290e3f8f67d888c31b6bf75f13b04ac312cbcc1255d6ef7e',
  physicalContractSha256:'819108532d5dfdb76dd4de7a3bc7081f73717e620e0a470b6db3152d922d09ca'});
const INDEX_NAMES=Object.freeze(['ARTIKEL_STAMMARTIKEL_FILIALEN','FilialID','PrimaryKey','{BE4D7347-7E8D-4A32-BC21-7DE4F38D1AAA}']);
const REQUEST_KEYS=['sourceId','scopeId','ownerId','sourceRevision','kind','fileSha256','bytes','runId','sourceSystem','sourceInstance','sourceTable','profileHash','applicationSchemaSha256','physicalContractSha256','declaredRows','expectedRows'];
const HELPER_BINDING=['fileSha256','bytes','sourceSystem','sourceInstance','sourceTable','profileHash','applicationSchemaSha256','physicalContractSha256'];
const sourceContext=row=>['source',row.scopeId,row.ownerId,row.id,row.revision];
const invalid=()=>C.fail('IMPORT_SOURCE_PROOF_INVALID',409);
function strict(value,keys){if(!C.plain(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();C.exact(value,keys);return value;}
function same(a,b){if(!C.equal(a,b))invalid();}
function request(value){
  strict(value,REQUEST_KEYS);C.sha(value.sourceId);C.id(value.scopeId);C.id(value.ownerId);C.integer(value.sourceRevision,1,Number.MAX_SAFE_INTEGER);
  C.sha(value.fileSha256);C.integer(value.bytes,4096,512*1024*1024);C.sha(value.runId);C.integer(value.declaredRows);C.integer(value.expectedRows);
  for(const [key,expected]of Object.entries(KNOWN))if(value[key]!==expected)invalid();
  if(value.declaredRows===value.expectedRows)invalid();return value;
}
function helperResult(value,expected){
  request(expected);strict(value,['format','passed','binding','counts','metadataMatchedBeforeRowCursor','physicalOrdinaryTable','externalLinksDenied','primaryIndexChecked','indexes','allFourIndexesExact']);
  if(value.format!==FORMAT||value.passed!==true)invalid();strict(value.binding,HELPER_BINDING);
  for(const key of HELPER_BINDING)if(value.binding[key]!==expected[key])invalid();
  strict(value.counts,['headerRows','logicalRows','uniqueLogicalRowIds']);
  for(const n of Object.values(value.counts))C.integer(n);
  if(value.counts.headerRows!==expected.declaredRows||value.counts.logicalRows!==expected.expectedRows||value.counts.uniqueLogicalRowIds!==expected.expectedRows)invalid();
  for(const key of ['metadataMatchedBeforeRowCursor','physicalOrdinaryTable','externalLinksDenied','primaryIndexChecked','allFourIndexesExact'])if(value[key]!==true)invalid();
  if(!Array.isArray(value.indexes)||value.indexes.length!==4)invalid();
  value.indexes.forEach((index,ordinal)=>{
    strict(index,['name','rows','uniqueRowIds','duplicates','extra','missing','exactCoverage']);
    if(index.name!==INDEX_NAMES[ordinal]||index.exactCoverage!==true)invalid();
    for(const key of ['rows','uniqueRowIds','duplicates','extra','missing'])C.integer(index[key]);
    if(index.rows!==expected.expectedRows||index.uniqueRowIds!==expected.expectedRows||index.duplicates!==0||index.extra!==0||index.missing!==0)invalid();
  });return value;
}
function verifier(value){strict(value,['protocol','descriptorSha256','completeTreeSha256']);if(value.protocol!==FORMAT)invalid();C.sha(value.descriptorSha256);C.sha(value.completeTreeSha256);return value;}
function policies(values){if(!Array.isArray(values)||values.length>8)invalid();values.forEach(verifier);return values;}
function evidence(value){strict(value,['request','result','verifier','verifiedAt']);request(value.request);helperResult(value.result,value.request);verifier(value.verifier);C.utc(value.verifiedAt);return value;}
function createReceipt(value){
  evidence(value);const body={format:RECEIPT,request:JSON.parse(C.canonical(value.request)),result:JSON.parse(C.canonical(value.result)),
    verifier:JSON.parse(C.canonical(value.verifier)),verifiedAt:value.verifiedAt};
  return C.freeze({...body,evidenceSha256:C.fingerprint(body)});
}
function validateReceipt(receipt){
  strict(receipt,['format','request','result','verifier','verifiedAt','evidenceSha256']);if(receipt.format!==RECEIPT)invalid();
  evidence({request:receipt.request,result:receipt.result,verifier:receipt.verifier,verifiedAt:receipt.verifiedAt});C.sha(receipt.evidenceSha256);
  const {evidenceSha256,...body}=receipt;if(C.fingerprint(body)!==evidenceSha256)invalid();return receipt;
}
function sourceBinding(row,data,{allowPurged=false}={}){
  C.sha(row.id);C.id(row.scopeId);C.id(row.ownerId);C.integer(row.revision,1,Number.MAX_SAFE_INTEGER);
  if(data.kind!=='trade'||data.complete!==true||!Array.isArray(data.tables))invalid();C.sha(data.fileSha256);C.integer(data.bytes,4096,512*1024*1024);
  const tables=data.tables.filter(table=>table.name===KNOWN.sourceTable);if(tables.length!==1||tables[0].profileHash!==KNOWN.profileHash||!tables[0].run)invalid();
  const table=tables[0],run=table.run;C.sha(run.id);C.integer(table.declaredRows);C.integer(run.receivedRows);
  const expectedRows=run.expectedRows??(allowPurged&&run.status==='purged'?run.receivedRows:undefined);C.integer(expectedRows);
  if(run.receivedRows!==expectedRows)invalid();
  return request({sourceId:row.id,scopeId:row.scopeId,ownerId:row.ownerId,sourceRevision:row.revision,...KNOWN,
    fileSha256:data.fileSha256,bytes:data.bytes,runId:run.id,declaredRows:table.declaredRows,expectedRows});
}
function manifestFor(value){return {sourceInstance:value.sourceInstance,schemaSha256:value.applicationSchemaSha256,fileSha256:value.fileSha256,declaredRows:value.declaredRows,expectedRows:value.expectedRows};}
const profile={sourceSystem:KNOWN.sourceSystem,sourceTable:KNOWN.sourceTable,fingerprint:KNOWN.profileHash,schemaSha256:KNOWN.applicationSchemaSha256};
function staticMatch(value,registry){return T.matchingSourceTolerance(manifestFor(value),profile,registry);}
function makeProof(receipt){const r=receipt.request;return T.defineDataImportSourceTolerance({id:'independent-af-v2-'+receipt.evidenceSha256.slice(0,48),recordedAt:receipt.verifiedAt,
  approvalReference:'explicit-owner-receipt-required',reason:'Unabhängig geprüfte logische Zeilenzahl mit vollständiger Abdeckung durch die vier festgelegten Indizes.',
  evidenceReference:'source-count-proof:'+receipt.evidenceSha256,sourceSystem:r.sourceSystem,sourceInstance:r.sourceInstance,sourceTable:r.sourceTable,
  profileHash:r.profileHash,schemaSha256:r.applicationSchemaSha256,fileSha256:r.fileSha256,declaredRows:r.declaredRows,expectedRows:r.expectedRows,requiresExplicitApproval:true});}
function authenticateSource(protection,row){
  const data=protection.open(row.payload,sourceContext(row));
  if(protection.digest(['source',{scopeId:row.scopeId,ownerId:row.ownerId},data.kind,data.fileSha256])!==row.id)C.fail('IMPORT_SOURCE_INTEGRITY',409);
  return data;
}
function loadSourceProofRegistry({protection,sourceRow,sourceTolerances=[],acceptedVerifierAssets=[]}){
  const registry=T.sourceToleranceRegistry(sourceTolerances),allowed=policies(acceptedVerifierAssets),data=authenticateSource(protection,sourceRow);
  if(!Object.hasOwn(data,'independentCountProof'))return {registry,receipt:null,proof:null,available:false};
  const receipt=validateReceipt(data.independentCountProof),current=sourceBinding(sourceRow,data,{allowPurged:true});
  const {sourceRevision:captured,...binding}=receipt.request,{sourceRevision:revision,...actual}=current;
  if(captured>revision)invalid();same(binding,actual);
  const existing=staticMatch(current,registry);
  if(existing)return {registry,receipt,proof:existing,available:true};
  if(!allowed.some(policy=>C.equal(policy,receipt.verifier)))return {registry,receipt,proof:null,available:false,reason:'IMPORT_SOURCE_VERIFIER_UNAVAILABLE'};
  const proof=makeProof(receipt);return {registry:T.sourceToleranceRegistry([...registry,proof]),receipt,proof,available:true};
}
function verificationRequest({sourceRow,sourceData,sourceTolerances=[],acceptedVerifierAssets=[]}){
  if(sourceData.kind!=='trade'||sourceData.complete!==true||sourceData.retirement||!['reviewing','ready','needs_review'].includes(sourceData.status))return null;
  const table=sourceData.tables?.find(table=>table.name===KNOWN.sourceTable);
  if(table?.profileHash!==KNOWN.profileHash||!table.run?.gates?.includes('SOURCE_ROW_COUNT_MISMATCH'))return null;
  const value=sourceBinding(sourceRow,sourceData);
  if(sourceData.independentCountProof){const receipt=validateReceipt(sourceData.independentCountProof);
    const {sourceRevision:captured,...binding}=receipt.request,{sourceRevision:revision,...current}=value;
    if(captured>revision)invalid();same(binding,current);
    if(policies(acceptedVerifierAssets).some(policy=>C.equal(policy,receipt.verifier)))return null;}
  if(staticMatch(value,T.sourceToleranceRegistry(sourceTolerances)))return null;
  return C.freeze(value);
}
function verificationSummary({sourceRow,sourceData,registry,receipt,reason}){
  const table=sourceData.tables?.find(table=>table.name===KNOWN.sourceTable);
  if(sourceData.kind!=='trade'||sourceData.complete!==true||table?.profileHash!==KNOWN.profileHash||!table.run?.gates?.includes('SOURCE_ROW_COUNT_MISMATCH')&&!receipt)return {required:false,verified:false};
  const value=sourceBinding(sourceRow,sourceData,{allowPurged:true}),proof=staticMatch(value,registry);
  return {required:!proof,verified:!!proof,...(proof?{checkedAt:proof.recordedAt}:{}),...(reason?{reason}:{})};
}
module.exports={FORMAT,RECEIPT,KNOWN,INDEX_NAMES,request,helperResult,evidence,createReceipt,validateReceipt,sourceBinding,
  loadSourceProofRegistry,verificationRequest,verificationSummary,authenticateSource,sourceContext,validateVerifierPolicy:verifier,matchingProof:staticMatch};
