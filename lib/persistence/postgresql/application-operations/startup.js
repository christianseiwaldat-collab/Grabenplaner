'use strict';
const source=require('../contracts/source-schema-v09237.json');
const schema=Object.freeze({
 tableExists:name=>source.tables.some(t=>t.name===name),
 columnExists:(table,column)=>source.tables.find(t=>t.name===table)?.columns.some(c=>c.name===column)||false,
 triggerExists:name=>source.objects.some(o=>o.type==='trigger'&&o.name===name),
 ensureColumn(table,column){if(!this.columnExists(table,column))throw new Error('PG_APPLICATION_MIGRATION_REQUIRED');return false;},
});
function createPostgresqlStartupOperations(db,hooks){
 const {parseProtectedJson,personnelRecordDocumentProtectionContext,personnelSensitiveProtectionContext,parseVacationHistorySnapshot,amuReportProtectionContext,amuDocumentProtectionContext,workRuleSha256}=hooks;
 async function verifyRows(sql,field,context){const rows=await db.prepare(sql).all();for(const row of rows){if(!String(row[field]||'').startsWith('enc:v2:'))throw new Error('PG_APPLICATION_PROTECTED_RECORD_INVALID');parseProtectedJson(row[field],context(row));}return rows.length;}
 async function verifyProtectedPersonnelRecordDocuments(){return verifyRows('SELECT id,employee_number,protected_payload FROM personnel_record_documents ORDER BY employee_number,created_at,id','protected_payload',personnelRecordDocumentProtectionContext);}
 async function verifyProtectedSensitivePersonnelRecords(){return verifyRows('SELECT employee_number,protected_payload FROM personnel_sensitive_records ORDER BY employee_number','protected_payload',personnelSensitiveProtectionContext);}
 async function migrateProtectedPersonnelRecords(){
  await verifyRows('SELECT * FROM amu_reports ORDER BY id','protected_payload',amuReportProtectionContext);
  await verifyRows("SELECT d.*,r.employee_number FROM amu_documents d JOIN amu_reports r ON r.id=d.report_id WHERE d.status<>'purged' ORDER BY d.created_at,d.id",'protected_payload',amuDocumentProtectionContext);
  return {reports:0,documents:0};
 }
 async function migrateProtectedVacationHistoryRecords(){const rows=await db.prepare('SELECT id,group_id,employee_number,action,snapshot_json,receipt_sha256,created_by,created_at FROM vacation_history_events ORDER BY created_at,id').all();for(const row of rows){if(!String(row.snapshot_json).startsWith('enc:v2:'))throw new Error('PG_APPLICATION_VACATION_MIGRATION_REQUIRED');parseVacationHistorySnapshot(row);}return {migrated:0};}
 async function ensureWorkRuleEvaluationReceiptIntegrity({deep=false}={}){
  // Startup preserves the old migration precondition. Full historical receipt
  // hashing belongs to rehearsal/nightly recovery and is always paginated.
  if(await db.prepare("SELECT id FROM work_rule_evaluation_runs WHERE TRIM(COALESCE(receipt_sha256,''))='' LIMIT 1").get())throw new Error('PG_APPLICATION_WORK_RULE_MIGRATION_REQUIRED');
  if(!deep)return 0;
  let after='',verified=0;
  for(;;){const rows=await db.prepare('SELECT * FROM work_rule_evaluation_runs WHERE id>? ORDER BY id LIMIT 10').all(after);if(!rows.length)break;
  for(const row of rows){const result=JSON.parse(row.result_json),profileVersionIds=JSON.parse(row.profile_version_ids_json);
   if(!result||typeof result!=='object'||Array.isArray(result)||!Array.isArray(profileVersionIds)||workRuleSha256(result)!==row.result_sha256)throw new Error('PG_APPLICATION_WORK_RULE_RESULT_INVALID');
   const receipt=workRuleSha256({schemaVersion:1,id:row.id,targetType:row.target_type,scopeType:row.scope_type,scopeKey:row.scope_key,periodFrom:row.period_from,periodTo:row.period_to,profileVersionIds,inputSha256:row.input_sha256,resultSha256:row.result_sha256,outcome:row.outcome,result,createdBy:row.created_by,createdAt:row.created_at});
   if(receipt!==row.receipt_sha256)throw new Error('PG_APPLICATION_WORK_RULE_RECEIPT_INVALID');
   after=row.id;verified++;
  }}return verified;
 }
 async function ensureDefaultLocation(){if(!(await db.prepare('SELECT id FROM locations LIMIT 1').get()))throw new Error('PG_APPLICATION_LOCATION_REQUIRED');}
 async function seedDefaults({defaultSettings,builtinPortalRoles}){
  return db.transaction(async()=>{
   for(const [key,value]of Object.entries(defaultSettings))await db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key,value);
   for(const role of builtinPortalRoles)await db.prepare(`INSERT INTO portal_roles(id,name,description,builtin,permissions,sort_order,updated_at) VALUES(?,?,?,1,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,builtin=1,
    permissions=CASE WHEN portal_roles.id='developer' OR portal_roles.permissions_customized=0 THEN excluded.permissions ELSE portal_roles.permissions END,
    permissions_revision=portal_roles.permissions_revision+CASE WHEN (portal_roles.id='developer' OR portal_roles.permissions_customized=0) AND portal_roles.permissions<>excluded.permissions THEN 1 ELSE 0 END,
    sort_order=excluded.sort_order,updated_at=CURRENT_TIMESTAMP`).run(role.id,role.name,role.description,JSON.stringify(role.permissions),role.sortOrder);
   await db.prepare("UPDATE portal_users SET role_locked=1 WHERE role='developer' AND role_locked<>1").run();
  });
 }
 return Object.freeze({verifyProtectedPersonnelRecordDocuments,verifyProtectedSensitivePersonnelRecords,migrateProtectedPersonnelRecords,migrateProtectedVacationHistoryRecords,ensureWorkRuleEvaluationReceiptIntegrity,ensureDefaultLocation,seedDefaults});
}
module.exports={schema,createPostgresqlStartupOperations};
