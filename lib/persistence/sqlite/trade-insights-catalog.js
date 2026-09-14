'use strict';
const {T,CASH,SOURCES,HISTORY_HOLDS}=require('../statements/trade-insights');
const snake=n=>n.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
const page=`SELECT r.id,r.revision FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
 WHERE r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source=$source AND r.source_table=$sourceTable AND r.id>$after
 AND (CAST($snapshot AS TEXT) IS NULL OR v.file_sha256=$snapshot) ORDER BY r.id LIMIT $limit`;
const line=require('../statements/cash-snapshots').CASH_SNAPSHOT_TABLES.find(t=>t.name==='Umsatz_Kasse_Details');
const TRADE_INSIGHTS_CATALOG=Object.freeze([{statement:SOURCES,returning:false,sql:`SELECT ${Object.keys(SOURCES.columns).map(n=>`${snake(n)} AS "${n}"`).join(',')} FROM data_import_runs WHERE scope_id=$scopeId AND profile_hash=$profileHash AND status IN ('applied','purged') ORDER BY created_at DESC,id DESC LIMIT $limit`},...Object.entries(T).map(([name,statement])=>({statement,returning:false,
 sql:`SELECT ${Object.keys(statement.columns).map(n=>`v.${snake(n)} AS "${n}"`).join(',')} FROM import_history_${name} v JOIN (${page}) p ON v.record_id=p.id AND v.revision=p.revision`})),
 {statement:CASH.article,returning:false,sql:`SELECT ${Object.keys(CASH.article.columns).map(n=>`${snake(n)} AS "${n}"`).join(',')} FROM ${line.sqlName} WHERE dataset_slot=$datasetSlot AND article_key IN (${Array.from({length:14},(_,i)=>'$key'+(i+1)).join(',')}) AND business_date BETWEEN $dateFrom AND $dateTo AND source_row>$after ORDER BY source_row LIMIT $limit`},
 {statement:CASH.customer,returning:false,sql:`SELECT ${Object.keys(CASH.customer.columns).map(n=>`${snake(n)} AS "${n}"`).join(',')} FROM ${require('../statements/cash-snapshots').CASH_SNAPSHOT_TABLES.find(t=>t.name==='Umsatz_KASSE').sqlName} WHERE dataset_slot=$datasetSlot AND customer_key IN (${Array.from({length:14},(_,i)=>'$key'+(i+1)).join(',')}) AND business_date BETWEEN $dateFrom AND $dateTo AND source_row>$after ORDER BY source_row LIMIT $limit`},
 {statement:CASH.bounds,returning:false,sql:`SELECT (SELECT business_date FROM ${line.sqlName} WHERE dataset_slot=$datasetSlot AND business_date IS NOT NULL ORDER BY business_date LIMIT 1) AS "dateFrom",(SELECT business_date FROM ${line.sqlName} WHERE dataset_slot=$datasetSlot AND business_date IS NOT NULL ORDER BY business_date DESC LIMIT 1) AS "dateTo"`},
 {statement:HISTORY_HOLDS.count,returning:false,sql:'SELECT COUNT(*) AS count FROM import_history_references WHERE master_record_id=$recordId'},
 {statement:HISTORY_HOLDS.reference,returning:false,sql:'SELECT COUNT(*) AS count FROM import_history_references WHERE master_record_id=$recordId AND record_id=$historyId AND revision=$revision'},
]);
module.exports={TRADE_INSIGHTS_CATALOG};
