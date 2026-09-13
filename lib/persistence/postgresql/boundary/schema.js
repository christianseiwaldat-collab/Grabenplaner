'use strict';
const crypto=require('node:crypto');
const {source}=require('../sales/layout');
const MOVED=Object.freeze(['import_master_bindings','import_master_events','import_master_holds']);
function createBoundaryCorePlan(){
  const ids=new Set(source.objects.filter(o=>MOVED.includes(o.table_name)).map(o=>o.name));
  const copied=require('../sales/schema').createSalesSchemaPlan(6).statements.filter(s=>ids.has(s.id.split(':')[0]));
  const statements=[{id:'boundary.source-reference',sql:`CREATE TABLE gp.trade_source_references(id text PRIMARY KEY,source_revision bigint NOT NULL CHECK(source_revision>0),source_sha256 text NOT NULL CHECK(length(source_sha256)=64));CREATE TABLE gp.trade_source_reference_versions(id text NOT NULL REFERENCES gp.trade_source_references(id),source_revision bigint NOT NULL CHECK(source_revision>0),source_sha256 text NOT NULL CHECK(length(source_sha256)=64),PRIMARY KEY(id,source_revision));REVOKE UPDATE,DELETE ON gp.trade_source_reference_versions FROM gp_core_app;`}];
  for(const item of copied)statements.push({id:'boundary.'+item.id,sql:item.sql.replace(/trade\."import_master_records"/g,'gp.trade_source_references').replace(/trade\./g,'gp.').replace(/SET search_path =[^;]+/g,'SET search_path = pg_catalog,gp')});
  statements.push({id:'boundary.article-reference-publisher',sql:'GRANT INSERT ON gp.article_reference_snapshots TO gp_core_app'});
  statements.push({id:'boundary.audit-inbox',sql:`CREATE TABLE gp.sales_audit_inbox(event_id text PRIMARY KEY,source_sha256 text NOT NULL CHECK(length(source_sha256)=64),core_audit_id bigint NOT NULL REFERENCES gp.audit_log(id));REVOKE UPDATE,DELETE ON gp.sales_audit_inbox FROM gp_core_app;`});
  statements.push({id:'boundary.ledger',sql:`CREATE TABLE gp.boundary_migration_history(version integer PRIMARY KEY CHECK(version=7),plan_sha256 text NOT NULL,base_target_sha256 text NOT NULL,target_sha256 text NOT NULL);REVOKE ALL ON gp.boundary_migration_history FROM gp_core_app,gp_core_reader;GRANT SELECT ON gp.boundary_migration_history TO gp_core_app,gp_core_reader;`});
  return {statements,digest:crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex'),productActivation:false};
}
module.exports={MOVED,createBoundaryCorePlan};
