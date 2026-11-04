'use strict';
const fs=require('node:fs'),path=require('node:path');
const amu=require('../../../amu-storage');
const {inventory}=require('./paired-bundle');
const references=require('../application-operations/protected-storage');
const {encryptionConfiguration}=require('../../../../server-tools/linux/recovery/lib/recovery-shared');
const STORAGE_KEY=/^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
// Existing personnel versions allow 15 MiB; the current AUM policy allows up
// to 25 MiB. Recovery must retain those already valid stored documents.
const MAX_RECOVERY_DOCUMENT_BYTES=25*1024*1024;

// The caller supplies the still-retained Core dump snapshot. Neither the source
// tree nor its copied backup is initialized, repaired or modified by this check.
async function verifyProtectedRecoveryFiles(client,{sourceDirectory,environment,checkBudget=()=>{}}={}){
 checkBudget();
 sourceDirectory=path.resolve(sourceDirectory);
 const keys=encryptionConfiguration(new Map(Object.entries(environment)));
 const codec=amu.createAmuStorage({rootDirectory:sourceDirectory,encryptionKeys:{[keys.amuKeyId]:keys.amuKey},activeKeyId:keys.amuKeyId,maxDocumentBytes:MAX_RECOVERY_DOCUMENT_BYTES,readOnly:true,checkBudget});
 const storage=Object.freeze({unprotectRecord(...args){checkBudget();return codec.unprotectRecord(...args);},
  unprotectText(...args){checkBudget();return codec.unprotectText(...args);}});
 const database={prepare:sql=>({all:async()=>{checkBudget();return(await client.query(sql)).rows;},
  get:async()=>{checkBudget();return(await client.query(sql)).rows[0];}})};
 const required=await references.protectedStorageReferencesFromDatabase(database);
 if(required.some(key=>!STORAGE_KEY.test(key)))throw new Error('PG_PAIR_PROTECTED_REFERENCE');
 const requiredSet=new Set(required),available=new Set();
 const files=fs.existsSync(sourceDirectory)?await inventory(sourceDirectory,sourceDirectory,{content:false,checkBudget}):[];
 for(const file of files){
  checkBudget();
  if(file.file==='key-check.amu')continue;
  if(!file.file.startsWith('blobs/')||!STORAGE_KEY.test(file.file.slice(6)))throw new Error('PG_PAIR_PROTECTED_COMPONENT');
  const key=file.file.slice(6),buffer=codec.readBuffer(key);
  try{checkBudget();available.add(key);}finally{buffer.fill(0);}
 }
 if(required.some(key=>!available.has(key)))throw new Error('PG_PAIR_PROTECTED_FILE_MISSING');
 const records=await require('./paired-restore').protectedRecords(client,storage);
 const loans=await references.protectedLoanStorageSnapshotFromDatabase(database);
 const sickness=await references.protectedSicknessAmuStorageSnapshotFromDatabase(database);
 const checked=new Set();
 function read(metadata){
  checkBudget();
  const bytes=Number(metadata.byteSize);
  if(!requiredSet.has(metadata.storageKey)||checked.has(metadata.storageKey)||!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_RECOVERY_DOCUMENT_BYTES
   ||!['number','string'].includes(typeof metadata.byteSize)||!/^[a-f0-9]{64}$/.test(metadata.sha256||'')
   ||!['application/pdf','image/jpeg','image/png','image/webp','image/tiff'].includes(metadata.detectedMime))throw new Error('PG_PAIR_PROTECTED_METADATA');
  const buffer=codec.readBuffer({...metadata,byteSize:bytes});
  try{checkBudget();checked.add(metadata.storageKey);}finally{buffer.fill(0);}
 }
 function payload(row,namespace,recordId=row.id){
  const value=JSON.parse(storage.unprotectRecord(row.protected_payload,{namespace,recordId:String(recordId),field:'payload',employeeNumber:String(row.employee_number||'')},{allowLegacy:false}));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('PG_PAIR_PROTECTED_METADATA');
  return value;
 }
 for(const row of sickness.amuDocuments){
  const value=payload(row,'personnel-record-document');
  read({storageKey:row.storage_key,byteSize:value.byteSize,sha256:value.sha256,detectedMime:value.detectedMime,originalFilename:value.originalFilename||'Dokument'});
 }
 const versioned=new Set(sickness.personnelDocumentVersions.map(row=>String(row.id)));
 for(const row of [...sickness.personnelDocuments.filter(row=>!versioned.has(String(row.id))),...sickness.personnelDocumentVersions]){
  const value=payload(row,'personnel-record-attachment');
  read({storageKey:row.storage_key,byteSize:value.byteSize,sha256:value.sha256,detectedMime:value.detectedMime,originalFilename:value.originalFilename||'Dokument'});
 }
 for(const row of sickness.candidateDocuments){
  const value=JSON.parse(storage.unprotectRecord(row.protected_payload,require('../../../personnel-lifecycle').candidateDocumentVersionProtectionContext(row),{allowLegacy:false}));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('PG_PAIR_PROTECTED_METADATA');
  read({storageKey:row.storage_key,byteSize:row.size_bytes,sha256:row.content_sha256,detectedMime:row.media_type,originalFilename:value.originalFilename||'Dokument'});
 }
 for(const row of [...loans.documents,...loans.photos,...loans.photoAttachments])read({storageKey:row.storage_key,byteSize:row.byte_size,sha256:row.sha256,detectedMime:row.detected_mime,originalFilename:row.filename});
 for(const row of (await client.query('SELECT storage_key,content_sha256,byte_size,media_type,original_filename FROM gp.crm_customer_photos ORDER BY customer_id')).rows)
  read({storageKey:row.storage_key,byteSize:row.byte_size,sha256:row.content_sha256,detectedMime:row.media_type,originalFilename:row.original_filename});
 checkBudget();
 return {verified:true,encryptedFiles:available.size,fileReferences:required.length,protectedRecords:records,metadataFiles:checked.size,
  loanDocuments:loans.documents.length,loanPhotos:loans.photos.length,loanPhotoAttachments:loans.photoAttachments.length};
}
module.exports={verifyProtectedRecoveryFiles};
