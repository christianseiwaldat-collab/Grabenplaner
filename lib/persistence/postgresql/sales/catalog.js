'use strict';
const crypto=require('node:crypto');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileCoreEntry,sourceContract}=require('../core/catalog');
const {inventory,stageTables,qualify}=require('./layout');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function salesSourceEntries(stage=5){
  const owned=new Set(stageTables(stage).map(t=>t.name));
  const scope=new Map(inventory.statements.filter(s=>s.boundary==='sales'&&s.references.every(r=>owned.has(r))).map(s=>[s.id,s]));
  if(stage>=7)for(const id of require('../boundary/catalog').movedIds)scope.delete(id);
  if(stage>=6){const audit=inventory.statements.find(s=>s.id==='sales-article-catalog.audit.insert');scope.set(audit.id,audit);}
  const entries=SQLITE_APPLICATION_CATALOG.filter(e=>scope.has(e.statement.id));
  if(entries.some(e=>scope.get(e.statement.id).sourceSha256!==hash(e.sql)))throw new Error('Sales source SQL drift');
  return entries;
}
function compileSalesEntry(entry,stage=5){
  let sqlSource=entry.sql;
  if(stage>=8&&entry.statement.id==='sales-analytics.profiles.list')sqlSource=sqlSource.replace(/\bTRUE\b/g,'1').replace(/\bFALSE\b/g,'0');
  if(stage>=7&&entry.statement.id==='import-master.dependencies')sqlSource='SELECT COUNT(*) AS count FROM import_master_relations WHERE identity_hash=$identityHash AND record_id<>$id';
  if(stage>=7&&entry.statement.id==='import-master.mapping.list')sqlSource=sqlSource.replace(/AND \(\$status='all'[\s\S]+?ORDER BY/,'AND $status IN (\'all\',\'linked\',\'unlinked\') ORDER BY');
  if(entry.statement.id==='import-history.search')sqlSource=sqlSource.replace(/\$unassigned=FALSE/g,'$unassigned=0').replace(/\$unassigned=TRUE/g,'$unassigned=1');
  if(entry.statement.id==='loan-module.search-articles')sqlSource=sqlSource.replace(/COLLATE NOCASE/gi,'');
  const compiled=compileCoreEntry({...entry,sql:sqlSource});
  let sql=qualify(compiled.providerEntry.sql);
  if(stage>=8&&['sales-article-catalog.articles.search','sales-article-catalog.articles.search.count'].includes(entry.statement.id)){
    // The generated column has exactly the old expression, including its ASCII
    // behavior. PostgreSQL maintains it for every writer; no caller/cache trust.
    sql=sql.replaceAll('gp . ascii_fold ( ( gp . lower ( article . search_text ) ) :: text )','article.search_text_folded');
  }
  if(entry.statement.id==='sales-article-catalog.audit.insert')sql=sql.replace(/\baudit_log\b/g,'integration.core_audit_outbox');
  return {providerEntry:{...compiled.providerEntry,sql},provenance:{statementId:entry.statement.id,sourceContract:sourceContract(entry),sqlSha256:hash(sql)}};
}
function createSalesCatalog(stage=5){
  const compiled=salesSourceEntries(stage).map(e=>compileSalesEntry(e,stage));
  const lock=require('../contracts/block-'+stage+'-catalog.json');
  const pinned=new Map(lock.entries.map(e=>[e.statementId,e]));
  if(lock.stage!==stage||lock.productActivation!==false||lock.scope!=='sales-development'||lock.entries.length!==compiled.length||pinned.size!==compiled.length||lock.schemaPlanSha256!==require('./schema').createSalesSchemaPlan(stage).digest||compiled.some(e=>{const p=pinned.get(e.provenance.statementId);return !p||p.sourceContract!==e.provenance.sourceContract||p.sqlSha256!==e.provenance.sqlSha256;}))throw new Error('Sales catalog requires complete qualification');
  return Object.freeze({entries:Object.freeze(compiled.map(e=>Object.freeze(e.providerEntry))),productActivation:false});
}
module.exports={salesSourceEntries,compileSalesEntry,createSalesCatalog};
