'use strict';
function createPostgresqlSystemDiagnosticsOperations(db){
 const number=async sql=>Number((await db.prepare(sql).get())?.count||0);
 return Object.freeze({
  databaseVersion:async()=>String((await db.prepare('SELECT version() AS version').get())?.version||''),
  latestMigration:async()=>await db.prepare('SELECT id,app_version,applied_at FROM schema_migrations ORDER BY applied_at DESC,id DESC LIMIT 1').get()||null,
  protectedIntegrationConnectionCount:()=>number("SELECT COUNT(*) AS count FROM integration_connections WHERE protected_credentials<>'' AND active=1"),
  lockedPortalAccountCount:()=>number('SELECT COUNT(*) AS count FROM portal_users WHERE locked_until>CURRENT_TIMESTAMP'),
  activePortalSessionCount:()=>number('SELECT COUNT(*) AS count FROM portal_sessions WHERE revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP'),
  latestAuditActionCreatedAt:async action=>(await db.prepare('SELECT created_at FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1').get(String(action)))?.created_at||null,
 });
}
function createPostgresqlAuditLogOperations(db){return Object.freeze({async record({actor='',action,entityType='',entityId='',detail=''}={}){
 const normalized=String(action||'').trim();if(!normalized||normalized.includes('\0'))throw new TypeError('Eine gültige Audit-Aktion wird benötigt.');
 return (await db.prepare('INSERT INTO audit_log(actor,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)').run(String(actor||''),normalized,String(entityType||''),String(entityId||''),String(detail||'').slice(0,2000))).changes;
}});}
module.exports={createPostgresqlSystemDiagnosticsOperations,createPostgresqlAuditLogOperations};
