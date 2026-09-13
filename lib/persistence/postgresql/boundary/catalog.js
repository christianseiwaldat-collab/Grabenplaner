'use strict';
const {definePersistenceStatement}=require('../../contract');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileCoreEntry}=require('../core/catalog');
const {inventory}=require('../sales/layout');
const {MOVED}=require('./schema');
const core=[],sales=[],B={};
function add(domain,key,operation,parameters,columns,sql){
  const statement=definePersistenceStatement({id:'database-boundary.'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),operation,parameters,...(columns?{columns}:{})});B[key]=statement;
  const order=Object.keys(parameters);
  (domain==='core'?core:sales).push({statement,sql,parameterOrder:order,returning:operation==='execute'&&Boolean(columns)});
}
add('sales','sourceHeader','queryOne',{id:'text'},{data:'json'},'SELECT to_jsonb(r) AS data FROM trade.import_master_records r WHERE id=$1');
add('core','sourceReference','execute',{id:'text',revision:'safe_integer',sha:'text'},null,'INSERT INTO gp.trade_source_references VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET source_revision=excluded.source_revision,source_sha256=excluded.source_sha256 WHERE gp.trade_source_references.source_revision<=excluded.source_revision');
add('core','sourceVersion','execute',{id:'text',revision:'safe_integer',sha:'text'},null,'INSERT INTO gp.trade_source_reference_versions VALUES($1,$2,$3) ON CONFLICT DO NOTHING');
add('core','getSourceVersion','queryOne',{id:'text',revision:'safe_integer'},{sha:'text'},'SELECT source_sha256 AS sha FROM gp.trade_source_reference_versions WHERE id=$1 AND source_revision=$2');
add('core','masterDependents','queryOne',{id:'text'},{count:'safe_integer'},'SELECT (SELECT count(*) FROM gp.import_master_bindings WHERE record_id=$1)+(SELECT count(*) FROM gp.import_master_holds WHERE record_id=$1) AS count');
add('sales','articleRevision','queryOne',{id:'text',revision:'safe_integer'},{data:'json'},'SELECT to_jsonb(r) AS data FROM trade.sales_article_revisions r WHERE product_id=$1 AND revision=$2');
add('core','publishArticle','execute',{id:'text',revision:'safe_integer',sha:'text',articleNumber:'text'},null,'INSERT INTO gp.article_reference_snapshots VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING');
add('core','getArticleReference','queryOne',{id:'text',revision:'safe_integer'},{sha:'text'},'SELECT source_digest AS sha FROM gp.article_reference_snapshots WHERE product_id=$1 AND revision=$2');
add('sales','pendingAudits','queryAll',{limit:'safe_integer'},{data:'json'},'SELECT to_jsonb(o) AS data FROM integration.core_audit_outbox o WHERE NOT EXISTS(SELECT 1 FROM integration.core_audit_delivery d WHERE d.event_id=o.event_id) ORDER BY id LIMIT $1');
add('core','getAuditReceipt','queryOne',{id:'text'},{sha:'text',auditId:'safe_integer'},'SELECT source_sha256 AS sha,core_audit_id AS "auditId" FROM gp.sales_audit_inbox WHERE event_id=$1');
add('core','appendAudit','execute',{actor:'text',action:'text',entityType:'text',entityId:'text',detail:'text',timestamp:'text'},{id:'safe_integer'},'INSERT INTO gp.audit_log(actor,action,entity_type,entity_id,detail,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id');
add('core','ackAudit','execute',{id:'text',sha:'text',auditId:'safe_integer'},null,'INSERT INTO gp.sales_audit_inbox VALUES($1,$2,$3)');
add('sales','deliveredAudit','execute',{id:'text',auditId:'safe_integer',sha:'text'},null,'INSERT INTO integration.core_audit_delivery(event_id,core_audit_id,source_sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING');
const movedIds=new Set(inventory.statements.filter(s=>s.references.length&&s.references.every(t=>MOVED.includes(t))).map(s=>s.id));
movedIds.add('import-master.crm.dependents');
for(const source of SQLITE_APPLICATION_CATALOG.filter(e=>movedIds.has(e.statement.id))){
  const sql=source.sql.replace(/\bTRUE\b/g,'1').replace(/\bFALSE\b/g,'0');
  core.push(compileCoreEntry({...source,sql}).providerEntry);
}
function assertBoundaryCatalog(){
  const lock=require('../contracts/block-7-boundary-catalog.json');
  const entries=[...core.map(e=>['core',e]),...sales.map(e=>['sales',e])];
  if(lock.productActivation!==false||lock.prepared!==entries.length||lock.entries.length!==entries.length||entries.some(([domain,e])=>!lock.entries.some(p=>p.domain===domain&&p.id===e.statement.id&&p.sha256===require('node:crypto').createHash('sha256').update(JSON.stringify(e)).digest('hex'))))throw new Error('Boundary catalog qualification drift');
}
module.exports={B:Object.freeze(B),CORE_BOUNDARY_CATALOG:Object.freeze(core),SALES_BOUNDARY_CATALOG:Object.freeze(sales),movedIds,assertBoundaryCatalog};
