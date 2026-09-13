'use strict';
const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');
const {verifyInput}=require('../../lib/persistence/postgresql/transfer/history');
const {openSqliteLegacyDatabase,createSqlitePersistenceProvider}=require('../../lib/persistence/sqlite/provider');
const {SQLITE_APPLICATION_CATALOG}=require('../../lib/persistence/sqlite/application-catalog');
const {protectedStorageReferencesFromDatabase}=require('../../lib/persistence/sqlite/operations/maintenance');
const {validateEncryptionKeyForStorage,createAmuStorage}=require('../../lib/amu-storage');
const {createIntegrationSecretVault}=require('../../lib/integration-secret-vault');
const {loadManagedDataImportProtection}=require('../../lib/data-import-managed-protection');
const {createCashSnapshotStore}=require('../../lib/persistence/repositories/cash-snapshots');
const {CASH_SNAPSHOT_TABLES}=require('../../lib/persistence/statements/cash-snapshots');
const base='/home/gpadmin/grabenplaner-pg-migration-20260912';
async function main(){
  if(process.platform!=='linux'||fs.realpathSync(process.cwd())!==base+'/qualification')throw new Error('Dedicated qualification required');
  const root=base+'/historical-9/source';await verifyInput(root);
  // Parse data only. Never source the production environment or install its
  // mail/network/endpoints in this qualification process.
  const environment=parseEnv(fs.readFileSync(root+'/configuration.env','utf8'));
  const amuId=environment.GRABENPLANER_AMU_KEY_ID;
  const amu={sourceDirectory:root+'/private/amu',encryptionKeys:{[amuId]:environment.GRABENPLANER_AMU_KEY},activeKeyId:amuId};
  const fileProof=validateEncryptionKeyForStorage(amu);
  const database=openSqliteLegacyDatabase(root+'/dienstplan.db',{readOnly:true});
  const access=createSqlitePersistenceProvider({database,catalog:SQLITE_APPLICATION_CATALOG,initializeConnection:false});
  let protection,scratch;
  try {
    const references=protectedStorageReferencesFromDatabase(database);
    for(const key of references)if(!fs.statSync(path.join(amu.sourceDirectory,'blobs',key)).isFile())throw new Error('Protected reference missing');
    const id=environment.GRABENPLANER_INTEGRATION_KEY_ID,keys=environment.GRABENPLANER_INTEGRATION_KEYS?JSON.parse(environment.GRABENPLANER_INTEGRATION_KEYS):{};
    keys[id]=environment.GRABENPLANER_INTEGRATION_KEY;
    const vault=createIntegrationSecretVault({activeKeyId:id,keys});
    protection=await loadManagedDataImportProtection({access,vault,create:false});
    if(!protection)throw new Error('Managed archive key missing');
    let cashSamples=0;
    for(const row of database.prepare('SELECT id,scope_id,owner_id,slot FROM cash_snapshot_datasets').all()) {
      const store=createCashSnapshotStore({access,protection,actor:{scopeId:row.scope_id,ownerId:row.owner_id}});
      await access.transaction(async tx=>{
        const dataset=await store.reader.load(tx,row.id);
        for(const table of CASH_SNAPSHOT_TABLES){
          const {count}=await tx.queryOne(table.statements.count,{datasetSlot:row.slot});
          for(const ordinal of new Set(count?[1,Math.max(1,Math.floor(count/2)),count]:[])){
            const stored=await tx.queryOne(table.statements.row,{datasetSlot:row.slot,sourceRow:ordinal});if(!stored)throw new Error('Sample ordinal missing');
            store.reader.decode(dataset,table,stored);cashSamples++;
          }
        }
      },{isolation:'serializable',readOnly:true});
    }
    scratch=fs.mkdtempSync(base+'/historical-9/protection-probe-');
    fs.cpSync(amu.sourceDirectory,scratch,{recursive:true});
    const reader=createAmuStorage({rootDirectory:scratch,encryptionKeys:amu.encryptionKeys,activeKeyId:amuId});
    let protectedRecords=0;
    for(const [table,namespace,recordColumn,field,payload] of [
      ['personnel_sensitive_records','personnel-sensitive-record','employee_number','payload','protected_payload'],
      ['personnel_record_documents','personnel-record-attachment','id','payload','protected_payload'],
      ['amu_reports','personnel-record','id','payload','protected_payload'],
      ['vacation_history_events','vacation-history-event','id','snapshot','snapshot_json'],
    ]){
      for(const row of database.prepare('SELECT * FROM '+table).all()){
        if(!row[payload])continue;
        reader.unprotectRecord(row[payload],{namespace,recordId:String(row[recordColumn]),field,employeeNumber:String(row.employee_number)});protectedRecords++;
      }
    }
    const proof={checkedAt:new Date().toISOString(),verified:true,encryptedFiles:fileProof.fileCount,fileReferences:references.length,managedImportKey:true,cashSamples,protectedRecords,ciphertextEqualityRequiredFromTransfer:true,sourceModified:false,productActivation:false};
    fs.writeFileSync(base+'/historical-9/protection-verification.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(proof));
  }finally{
    protection?.destroy();await access.close();database.close();
    if(scratch&&path.dirname(scratch)===base+'/historical-9'&&fs.realpathSync(scratch)===scratch&&path.basename(scratch).startsWith('protection-probe-'))fs.rmSync(scratch,{recursive:true});
  }
}
main().catch(error=>{console.error(JSON.stringify({failed:true,code:error.code||null,type:error.name,frames:error.stack?.split('\n').slice(1,5)}));process.exitCode=1;});
