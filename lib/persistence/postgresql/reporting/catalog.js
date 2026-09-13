'use strict';
const {definePersistenceStatement}=require('../../contract');
const publishLocation=definePersistenceStatement({id:'reporting-boundary.publish-location',operation:'execute',parameters:{id:'text',sha:'text'}});
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../../statements/cash-snapshots');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileSalesEntry}=require('../sales/catalog');
const prefetch={};
const reads=[['heads','Umsatz_KASSE','source_row'],['children','Umsatz_Kasse_Details','parent_row']].map(([kind,name,column])=>{
  const table=TABLES.find(t=>t.name===name);
  const statement=definePersistenceStatement({id:'reporting-boundary.prefetch-'+kind,operation:'queryAll',parameters:{datasetSlot:'safe_integer',ordinals:'json',limit:'safe_integer'},columns:table.statements.row.columns});prefetch[kind]=statement;
  const base=compileSalesEntry(SQLITE_APPLICATION_CATALOG.find(e=>e.statement===table.statements.row),8).providerEntry.sql;
  return {statement,sql:base.slice(0,base.indexOf(' WHERE '))+' WHERE dataset_slot=$1 AND '+column+' IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY source_row LIMIT $3',parameterOrder:['datasetSlot','ordinals','limit'],returning:false};
});
const REPORTING_BOUNDARY_CATALOG=Object.freeze([{statement:publishLocation,sql:'INSERT INTO integration.core_location_references VALUES($1,$2) ON CONFLICT DO NOTHING',parameterOrder:['id','sha'],returning:false},...reads]);
function assertReportingCatalog(){
  const lock=require('../contracts/block-8-reporting-catalog.json');
  const crypto=require('node:crypto');
  if(lock.productActivation!==false||lock.prepared!==REPORTING_BOUNDARY_CATALOG.length||lock.entries.length!==REPORTING_BOUNDARY_CATALOG.length||REPORTING_BOUNDARY_CATALOG.some(e=>!lock.entries.some(p=>p.id===e.statement.id&&p.sha256===crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex'))))throw new Error('Reporting catalog qualification required');
}
module.exports={publishLocation,prefetch:Object.freeze(prefetch),REPORTING_BOUNDARY_CATALOG,assertReportingCatalog};
