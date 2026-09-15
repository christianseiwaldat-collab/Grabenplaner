'use strict';
const {CASH_PUBLICATION_BATCHES:B}=require('../../statements/cash-publication-batches');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../../statements/cash-snapshots');
const {IMPORT_MASTER_STATEMENTS:M}=require('../../statements/import-master-data');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileSalesEntry}=require('./catalog');
const compiled=statement=>compileSalesEntry(SQLITE_APPLICATION_CATALOG.find(e=>e.statement===statement),8).providerEntry.sql;
const entry=(statement,sql,parameterOrder)=>Object.freeze({statement,sql,parameterOrder:Object.freeze(parameterOrder),returning:false});
// Keep the historical migrations and source catalogs unchanged. These bounded
// batches use the same tables, joins, scalar types and snapshot as single reads.
const articleSelect=compiled(M.articleBySource).split(' WHERE ')[0];
const CASH_PUBLICATION_BATCH_CATALOG=Object.freeze([
  entry(B.articles,articleSelect.replace(/^SELECT /,'SELECT l.source_article_key::text AS "sourceArticleKey", ')+
    ' WHERE l.source_system=$1::text AND l.source_article_key IN (SELECT jsonb_array_elements_text($2::jsonb))',['sourceSystem','keys']),
  ...TABLES.map((table,i)=>entry(B.rows[i],compiled(table.statements.page).split(' WHERE ')[0]+
    ' WHERE dataset_slot=$1::bigint AND source_row IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))',['datasetSlot','rows'])),
  entry(B.bindings,`INSERT INTO kassa.cash_publication_bindings (publication_id,kind,source_key,target_id,historical,payload)
    SELECT v."publicationId",v.kind,decode(v."sourceKey",'hex'),v."targetId",CASE WHEN v.historical THEN 1 ELSE 0 END,v.payload
    FROM jsonb_to_recordset($1::jsonb) AS v("publicationId" text,kind text,"sourceKey" text,"targetId" text,historical boolean,payload text)`,['rows']),
]);
module.exports={CASH_PUBLICATION_BATCH_CATALOG};
