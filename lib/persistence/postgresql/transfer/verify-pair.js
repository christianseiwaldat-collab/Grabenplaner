'use strict';
const crypto=require('node:crypto');
const {ownership,marker,verifyTable}=require('./history');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function verifyReferences(core,sales,evidence){
  const refs=(await core.query('SELECT id,source_revision,source_sha256 FROM gp.trade_source_references ORDER BY id')).rows;
  if(refs.length!==evidence.references.sourceReferences)throw new Error('MIGRATION_REFERENCE_COUNT');
  const versions=(await core.query('SELECT id,source_revision,source_sha256 FROM gp.trade_source_reference_versions ORDER BY id')).rows;
  if(JSON.stringify(refs)!==JSON.stringify(versions))throw new Error('MIGRATION_REFERENCE_VERSION');
  for(let start=0;start<refs.length;start+=500){
    const batch=refs.slice(start,start+500),rows=(await sales.query('SELECT to_jsonb(r) AS data FROM trade.import_master_records r WHERE id=ANY($1::text[])',[batch.map(r=>r.id)])).rows;
    if(rows.length!==batch.length)throw new Error('MIGRATION_REFERENCE_SOURCE');
    const actual=new Map(rows.map(r=>[r.data.id,r.data]));
    for(const ref of batch){const row=actual.get(ref.id);if(String(row?.revision)!==ref.source_revision||hash(row)!==ref.source_sha256)throw new Error('MIGRATION_REFERENCE_SOURCE');}
  }
  const locations=(await core.query('SELECT id,name,active FROM gp.locations ORDER BY id')).rows;
  const locationRefs=(await sales.query('SELECT id,source_sha256 FROM integration.core_location_references ORDER BY id')).rows;
  if(locations.length!==evidence.references.locations||locations.length!==locationRefs.length)throw new Error('MIGRATION_LOCATION_REFERENCE');
  for(let i=0;i<locations.length;i++){
    const row={...locations[i],active:Number(locations[i].active)};
    if(row.id!==locationRefs[i].id||hash(row)!==locationRefs[i].source_sha256)throw new Error('MIGRATION_LOCATION_REFERENCE');
  }
  const articleRefs=(await core.query('SELECT * FROM gp.article_reference_snapshots ORDER BY product_id,revision')).rows;
  if(articleRefs.length!==evidence.references.articleReferences)throw new Error('MIGRATION_ARTICLE_REFERENCE');
  for(const ref of articleRefs){
    const row=(await sales.query('SELECT to_jsonb(r) AS data FROM trade.sales_article_revisions r WHERE product_id=$1 AND revision=$2',[ref.product_id,ref.revision])).rows[0]?.data;
    if(!row||row.article_number!==ref.article_number||hash(row)!==ref.source_digest)throw new Error('MIGRATION_ARTICLE_REFERENCE');
  }
  for(const [domain,client] of [['core',core],['sales',sales]])for(const sequence of evidence[domain+'Sequences']){
    const table=ownership.find(t=>t.database===domain&&t.name===sequence.table);
    if(!table||!/^\w+$/.test(sequence.column))throw new Error('MIGRATION_SEQUENCE_EVIDENCE');
    const name=(await client.query('SELECT pg_get_serial_sequence($1,$2) AS name',[table.schema+'.'+table.name,sequence.column])).rows[0].name;
    if(!/^[\w."_]+$/.test(name))throw new Error('MIGRATION_SEQUENCE_NAME');
    const row=(await client.query('SELECT last_value::text AS value,is_called AS called FROM '+name)).rows[0];
    if(row.value!==sequence.value||row.called!==sequence.called)throw new Error('MIGRATION_SEQUENCE_DRIFT');
  }
  return {sourceReferences:refs.length,locations:locations.length,articleReferences:articleRefs.length,sequences:evidence.coreSequences.length+evidence.salesSequences.length};
}
async function verifyPair(core,sales,evidence,{onProgress=()=>{}}={}){
  if(evidence.kind!==marker||!evidence.verified||evidence.tables?.length!==ownership.length)throw new Error('MIGRATION_PAIR_EVIDENCE');
  const owners=(await sales.query('SELECT id FROM gp.migration_fixture_owner')).rows;
  if(owners.length!==1||owners[0].id!==marker+':'+evidence.sourceSha256)throw new Error('MIGRATION_PAIR_OWNER');
  const started=performance.now();
  await core.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await sales.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    for(const table of ownership){await verifyTable(table.database==='core'?core:sales,table,evidence.tables.find(t=>t.name===table.name));onProgress({verifiedTable:table.name});}
    const references=await verifyReferences(core,sales,evidence);
    await sales.query('COMMIT');await core.query('COMMIT');
    return {verified:true,tables:ownership.length,rows:evidence.tables.reduce((n,t)=>n+t.rows,0),contentSha256:evidence.contentSha256,references,milliseconds:Math.round(performance.now()-started)};
  }catch(error){await Promise.allSettled([core.query('ROLLBACK'),sales.query('ROLLBACK')]);throw error;}
}
module.exports={verifyReferences,verifyPair};
