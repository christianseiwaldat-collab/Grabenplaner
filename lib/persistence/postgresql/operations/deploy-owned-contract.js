'use strict';

const {normalizeScope,DEPLOY_SCOPE,validateSalesPlan}=require('./deploy-data-policy');
const {validateCashPlan}=require('./cash-rehydration');
const {validateImportSourceArchiveProof}=require('../../../data-import-source-archive');
const FORMAT='grabenplaner-postgresql-deploy-owned';
const HASH=/^[a-f0-9]{64}$/;
const ARCHIVE_DIRECTORY='private/import-sources/';
const INDEX='index.source-archive';
const BLOB=/^[a-f0-9]{64}\.source$/;
function validateRecovery(recovery){
 const fresh=recovery?.basis==='fresh-source-rebuild';
 if(!recovery||recovery.scope!==DEPLOY_SCOPE||recovery.fullRecovery!==false||recovery.requiresCashRehydration!==true
  ||recovery.requiresAccessRehydration!==true||recovery.archiveStorage!==(fresh?'none':'server-reference-v1'))
  throw new Error('PG_DEPLOY_RECOVERY_CONTRACT');
 const plan=validateSalesPlan(recovery.salesPlan);
 if(!plan.excludedTables.length)throw new Error('PG_DEPLOY_RECOVERY_EMPTY_PLAN');
 if(fresh){
  if(plan.basis!==recovery.basis||plan.policyId!==require('./deploy-data-policy').FRESH_POLICY_ID
   ||recovery.requiresFreshAccess!==true||recovery.accessPlan?.format!=='grabenplaner-access-owned-state-v4'
   ||recovery.accessPlan.basis!==recovery.basis||['sourceArchive','sourceReplayPlan','cashPlan'].some(key=>Object.hasOwn(recovery,key)))
   throw new Error('PG_DEPLOY_FRESH_SOURCE_CONTRACT');
  require('./access-owned-state').validateOwnedPlan(recovery.accessPlan);
  require('./access-fresh-rebuild').validateFreshPlan(recovery.freshSourcePlan);
 }else{
 if(plan.basis!==undefined)throw new Error('PG_DEPLOY_RECOVERY_BASIS');
 if(recovery.basis!==undefined||recovery.freshSourcePlan!==undefined||recovery.requiresFreshAccess!==undefined)throw new Error('PG_DEPLOY_RECOVERY_BASIS');
 if(!recovery.sourceArchive?.available||!HASH.test(recovery.sourceArchive.generationSha256||''))throw new Error('PG_DEPLOY_RECOVERY_SOURCE_PROOF');
 validateImportSourceArchiveProof(recovery.sourceArchive);
 validateCashPlan(recovery.cashPlan,{archiveProof:recovery.sourceArchive});
 if(recovery.accessPlan?.format==='grabenplaner-access-owned-state-v3'){
  require('./access-owned-state').validateOwnedPlan(recovery.accessPlan);
  require('./access-source-replay').validateReplayPlan(recovery.sourceReplayPlan,{archiveProof:recovery.sourceArchive});
  if(recovery.sourceReplayPlan.archiveGenerationSha256!==recovery.sourceArchive.generationSha256)throw new Error('PG_DEPLOY_RECOVERY_REPLAY_BINDING');
 }else{
  // The earlier local format remains verifiable, but newly created points use
  // a sparse owned graph and source-level replay instead of row recipes.
  require('./access-recovery-projection').validateProjectionPlan(recovery.accessPlan);
  if(recovery.accessPlan.stats.omittedValues>require('./access-value-recipes').DEFAULT_LIMITS.maxReferences)throw new Error('PG_DEPLOY_RECOVERY_PROJECTION_LIMIT');
  if(recovery.sourceReplayPlan!==undefined)throw new Error('PG_DEPLOY_RECOVERY_UNEXPECTED_REPLAY');
 }
 if(recovery.accessPlan.archiveGenerationSha256!==recovery.sourceArchive.generationSha256)throw new Error('PG_DEPLOY_RECOVERY_PROJECTION_BINDING');
 }
 if(JSON.stringify(recovery.accessPlan.tables.map(({schema,table})=>({schema,table})).sort((a,b)=>(a.schema+'.'+a.table).localeCompare(b.schema+'.'+b.table)))
    !==JSON.stringify([...plan.projectedTables].sort((a,b)=>(a.schema+'.'+a.table).localeCompare(b.schema+'.'+b.table))))throw new Error('PG_DEPLOY_RECOVERY_PROJECTION_BINDING');
 const sizes=recovery.rehydrationDatabaseBytes;
 if(!sizes||Object.keys(sizes).sort().join(',')!=='core,sales'||['core','sales'].some(domain=>!Number.isSafeInteger(sizes[domain])||sizes[domain]<=0))
  throw new Error('PG_DEPLOY_RECOVERY_SIZE_PROOF');
 return recovery;
}

// Source objects live once in the server archive. A reduced point contains the
// frozen authenticated key/index and exact object hashes, plus the owned-value
// projection. Original objects must be supplied and verified for reconstruction.
// Complete pairs remain self-contained and keep their existing contract.
function validateRecoveryFiles(recovery,files){
 validateRecovery(recovery);
 if(recovery.basis==='fresh-source-rebuild'){
  if(!Array.isArray(files)||files.some(entry=>typeof entry?.file==='string'&&entry.file.startsWith(ARCHIVE_DIRECTORY)))throw new Error('PG_DEPLOY_FRESH_SOURCE_ARCHIVE_UNEXPECTED');
  const projections=files.filter(entry=>entry.file===recovery.accessPlan.file);
  if(projections.length!==1||projections[0].sha256!==recovery.accessPlan.sha256||projections[0].bytes!==recovery.accessPlan.bytes)throw new Error('PG_DEPLOY_RECOVERY_PROJECTION_FILE');
  return {verified:true,files:0,externalSourceObjects:0,requiresFreshAccess:true};
 }
 const declared=recovery.sourceArchive.files;
 if(!Array.isArray(declared)||!declared.length||!Array.isArray(files))throw new Error('PG_DEPLOY_RECOVERY_ARCHIVE_FILES');
 const expected=new Map();
 for(const entry of declared){
  if(!entry||typeof entry.file!=='string'||entry.file!==INDEX&&!BLOB.test(entry.file)||!HASH.test(entry.sha256||'')
   ||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||expected.has(entry.file))throw new Error('PG_DEPLOY_RECOVERY_ARCHIVE_FILES');
  expected.set(entry.file,entry);
 }
 if(!expected.has(INDEX)||recovery.cashPlan.datasets.length&&!declared.some(entry=>BLOB.test(entry.file)))throw new Error('PG_DEPLOY_RECOVERY_ARCHIVE_FILES');
 const actual=files.filter(entry=>typeof entry?.file==='string'&&entry.file.startsWith(ARCHIVE_DIRECTORY));
 if(actual.length!==1||actual[0].file!==ARCHIVE_DIRECTORY+INDEX)throw new Error('PG_DEPLOY_RECOVERY_ARCHIVE_FILES');
 const seen=new Set();
 for(const entry of actual){
  const relative=entry.file.slice(ARCHIVE_DIRECTORY.length),proof=expected.get(relative);
  if(!proof||seen.has(relative)||entry.bytes!==proof.bytes||entry.sha256!==proof.sha256)throw new Error('PG_DEPLOY_RECOVERY_ARCHIVE_FILES');
  seen.add(relative);
 }
 const projection=files.find(entry=>entry.file===recovery.accessPlan.file);
 if(!projection||projection.sha256!==recovery.accessPlan.sha256||projection.bytes!==recovery.accessPlan.bytes)throw new Error('PG_DEPLOY_RECOVERY_PROJECTION_FILE');
 return {verified:true,files:actual.length,externalSourceObjects:declared.length-1};
}
function contract(scope='full',recovery){
 normalizeScope(scope);
 if(scope==='full'){
  if(recovery!==undefined)throw new Error('PG_DEPLOY_RECOVERY_UNEXPECTED');
  return {format:'grabenplaner-postgresql-pair',schemaVersion:1};
 }
 validateRecovery(recovery);
 return {format:FORMAT,schemaVersion:1,recovery};
}
module.exports={FORMAT,contract,validateRecovery,validateRecoveryFiles};
