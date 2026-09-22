'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Client}=require('pg');
const source=require('../contracts/source-schema-v09237.json');
const {inventory,SCHEMAS,SEARCH_PATH}=require('../sales/layout');
const {MOVED}=require('../boundary/schema');
const {verifyEnvironment}=require('../core/environment');
const {verifyCoreSchema}=require('../boundary/migrate');
const {schemaFingerprint}=require('../core/fingerprint');
const {createSalesSchemaPlan}=require('../sales/schema');
const {createRowDigest}=require('./values');
const q=name=>{if(!/^[a-zA-Z_][\w]*$/.test(name))throw new Error('MIGRATION_IDENTIFIER');return '"'+name+'"';};
const relation=t=>q(t.schema)+'.'+q(t.name);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const technical=new Set(['environment_contract','core_migration_history','boundary_migration_history','sales_migration_history']);
const ownership=Object.freeze(inventory.tables.map(t=>({...t,...(MOVED.includes(t.name)?{database:'core',schema:'gp'}:{})})));
const marker='grabenplaner-historical-transfer-9-v1';

async function fileHash(file) {
  const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');
}
async function verifyInput(root) {
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||fs.readFileSync(path.join(path.dirname(root),'ownership-marker'),'utf8').trim()!==marker)throw new Error('MIGRATION_INPUT_OWNERSHIP');
  if(process.platform!=='win32'&&((fs.statSync(root).mode|fs.statSync(path.dirname(root)).mode)&0o077))throw new Error('MIGRATION_INPUT_PERMISSIONS');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.kind!=='isolated-online-sqlite-copy'||manifest.database.file!=='dienstplan.db'||manifest.configuration.file!=='configuration.env')throw new Error('MIGRATION_INPUT_MANIFEST');
  for(const entry of [manifest.database,manifest.configuration,...manifest.files]) {
    const file=path.resolve(root,entry.file);
    if(!file.startsWith(root+path.sep)||fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile()||fs.lstatSync(file).nlink!==1||(process.platform!=='win32'&&(fs.statSync(file).mode&0o077)))throw new Error('MIGRATION_INPUT_PATH');
    if((entry.bytes!==undefined&&fs.statSync(file).size!==entry.bytes)||await fileHash(file)!==entry.sha256)throw new Error('MIGRATION_INPUT_HASH');
  }
  return manifest;
}

function verifySqlite(db) {
  const objects=db.prepare("SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if(objects.length!==source.objects.length||objects.some((o,i)=>JSON.stringify(o)!==JSON.stringify(source.objects[i])))throw new Error('MIGRATION_SOURCE_SCHEMA_DRIFT');
  if(db.prepare('PRAGMA foreign_key_check').get())throw new Error('MIGRATION_SOURCE_FOREIGN_KEY');
}

async function connect(domain,url,staging=null) {
  const parsed=new URL(url);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||!['55482','55483',...(staging?['55486']:[])].includes(parsed.port))throw new Error('MIGRATION_TARGET_ENDPOINT');
  const client=new Client({connectionString:url});await client.connect();
  try {
    if(staging){if(parsed.port!=='55486')throw new Error('MIGRATION_STAGING_ENDPOINT');await require('./staging').assertTransferTarget(client,staging,domain);}
    await verifyEnvironment(client,{domain,purpose:'migrator'});
    await client.query('SET search_path='+(domain==='core'?'pg_catalog,gp':SEARCH_PATH));
    if(domain==='core')await verifyCoreSchema(client);
    else {
      const rows=(await client.query('SELECT stage,source_sha256,plan_sha256,target_sha256 FROM gp.sales_migration_history ORDER BY stage')).rows;
      if(JSON.stringify(rows.map(r=>r.stage))!=='[5,6,7,8]'||rows.some(r=>r.source_sha256!==source.schemaSha256||r.plan_sha256!==createSalesSchemaPlan(r.stage).digest)||await require('../sales/import-delete').target(client,rows.at(-1).target_sha256)!==await schemaFingerprint(client,SCHEMAS))throw new Error('MIGRATION_SALES_SCHEMA_DRIFT');
    }
    return client;
  }catch(e){await client.end();throw e;}
}

async function targetTables(client,domain) {
  return (await client.query('SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',[domain==='core'?['gp']:SCHEMAS])).rows.filter(t=>!technical.has(t.name));
}
async function columnsFor(client,table) {
  const original=source.tables.find(t=>t.name===table.name);
  const names=original.columns.map(c=>c.name).concat(table.name==='portal_notifications'?['rowid']:[]);
  const columns=(await client.query(`SELECT a.attname AS name,t.typname AS type,a.attgenerated AS generated FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[relation(table)])).rows;
  if(columns.filter(c=>!c.generated).length!==names.length||names.some(n=>!columns.some(c=>c.name===n&&!c.generated)))throw new Error('MIGRATION_COLUMNS_DRIFT');
  return names.map(name=>{
    const type=columns.find(c=>c.name===name).type;
    const kind=({int8:'integer',int4:'integer',float8:'real',numeric:'decimal',bytea:'blob',text:'text'})[type];
    if(!kind)throw new Error('MIGRATION_TYPE_UNREVIEWED');
    return {name,kind};
  });
}
function orderFor(table,columns,postgres=false) {
  const primary=source.tables.find(t=>t.name===table.name).columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk);
  if(!primary.length)throw new Error('MIGRATION_PRIMARY_KEY_REQUIRED');
  return primary.map(c=>q(c.name)+(columns.find(x=>x.name===c.name).kind==='text'?' COLLATE '+(postgres?'"C"':'BINARY'):'')+' ASC NULLS FIRST').join(',');
}

async function copyTable(db,client,table,onProgress) {
  const columns=await columnsFor(client,table),digest=createRowDigest(columns),start=performance.now();
  const select=db.prepare('SELECT '+columns.map(c=>q(c.name)).join(',')+' FROM '+q(table.name)+' ORDER BY '+orderFor(table,columns));select.setReadBigInts(true);
  let batch=[],bytes=0,count=0;
  async function flush() {
    if(!batch.length)return;
    let parameter=0;const rows=batch.map(row=>'('+row.map(()=>'$'+(++parameter)).join(',')+')');
    await client.query('INSERT INTO '+relation(table)+' ('+columns.map(c=>q(c.name)).join(',')+') VALUES '+rows.join(','),batch.flat());
    count+=batch.length;batch=[];bytes=0;
  }
  for(const row of select.iterate()) {
    const values=digest.add(columns.map(c=>row[c.name]));
    batch.push(values);bytes+=values.reduce((n,v)=>n+(v===null?0:Buffer.isBuffer(v)?v.length:Buffer.byteLength(String(v))),0);
    if(batch.length>=Math.min(500,Math.floor(50000/columns.length))||bytes>=2*1024*1024)await flush();
  }
  await flush();const result={name:table.name,database:table.database,schema:table.schema,columns,...digest.finish(),milliseconds:Math.round(performance.now()-start)};
  onProgress?.({table:table.name,rows:count,milliseconds:result.milliseconds});return result;
}

async function verifyTable(client,table,expected) {
  const digest=createRowDigest(expected.columns);
  await client.query('DECLARE migration_content NO SCROLL CURSOR FOR SELECT '+expected.columns.map(c=>q(c.name)).join(',')+' FROM '+relation(table)+' ORDER BY '+orderFor(table,expected.columns,true));
  try {
    for(;;){const {rows}=await client.query({text:'FETCH FORWARD 500 FROM migration_content',rowMode:'array'});if(!rows.length)break;for(const row of rows)digest.add(row);}
  }finally{await client.query('CLOSE migration_content');}
  const actual=digest.finish();if(actual.rows!==expected.rows||actual.sha256!==expected.sha256)throw Object.assign(new Error('MIGRATION_CONTENT_MISMATCH'),{table:table.name});
  return actual;
}

async function references(db,core,sales) {
  const ids=db.prepare('SELECT id FROM locations ORDER BY id').all();
  const needed=[...new Set(db.prepare('SELECT record_id FROM import_master_bindings UNION SELECT record_id FROM import_master_holds UNION SELECT record_id FROM import_master_events').all().map(r=>r.record_id))];
  if(db.prepare('SELECT 1 FROM import_master_bindings b JOIN import_master_records r ON r.id=b.record_id WHERE b.source_revision<>r.revision LIMIT 1').get())throw new Error('MIGRATION_HISTORICAL_REFERENCE_VERSION_REQUIRES_REVIEW');
  let sourceReferences=0;
  for(let start=0;start<needed.length;start+=500) {
    const part=needed.slice(start,start+500),rows=(await sales.query('SELECT to_jsonb(r) AS data FROM trade.import_master_records r WHERE id=ANY($1::text[])',[part])).rows;
    if(rows.length!==part.length)throw new Error('MIGRATION_SOURCE_REFERENCE_MISSING');
    const values=rows.flatMap(({data:row})=>[row.id,row.revision,hash(row)]);
    const clauses=rows.map((_,i)=>`($${i*3+1},$${i*3+2},$${i*3+3})`).join(',');
    await core.query('INSERT INTO gp.trade_source_references VALUES '+clauses,values);
    await core.query('INSERT INTO gp.trade_source_reference_versions VALUES '+clauses,values);sourceReferences+=rows.length;
  }
  const articles=db.prepare('SELECT DISTINCT product_id,product_revision_snapshot AS revision FROM loan_items WHERE product_id IS NOT NULL').all();
  for(const item of articles) {
    const row=(await sales.query('SELECT to_jsonb(r) AS data FROM trade.sales_article_revisions r WHERE product_id=$1 AND revision=$2',[item.product_id,item.revision])).rows[0]?.data;
    if(!row)throw new Error('MIGRATION_ARTICLE_REFERENCE_MISSING');
    await core.query('INSERT INTO gp.article_reference_snapshots VALUES($1,$2,$3,$4)',[item.product_id,item.revision,hash(row),row.article_number]);
  }
  return {locations:ids.length,sourceReferences,articleReferences:articles.length};
}

async function foreignKeys(client,domain) {
  return (await client.query(`SELECT n.nspname AS schema,c.relname AS name,f.conname AS constraint,f.condeferrable AS deferrable,f.condeferred AS deferred FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE f.contype='f' AND n.nspname=ANY($1::text[]) ORDER BY n.nspname,c.relname,f.conname`,[domain==='core'?['gp']:SCHEMAS])).rows;
}

async function sequences(db,client,tables) {
  const sequenceQuery=db.prepare('SELECT name,seq FROM sqlite_sequence');sequenceQuery.setReadBigInts(true);
  const legacy=new Map(sequenceQuery.all().map(r=>[r.name,BigInt(r.seq)]));
  const result=[];
  for(const table of tables) {
    const columns=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attidentity<>\'\'',[relation(table)])).rows;
    for(const {attname} of columns) {
      const name=(await client.query('SELECT pg_get_serial_sequence($1,$2) AS name',[relation(table),attname])).rows[0].name;
      const max=BigInt((await client.query('SELECT COALESCE(MAX('+q(attname)+'),0)::text AS value FROM '+relation(table))).rows[0].value);
      const historical=legacy.get(table.name)||0n,value=max>historical?max:historical;
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)',[name,(value>0n?value:1n).toString(),value>0n]);
      result.push({table:table.name,column:attname,value:(value>0n?value:1n).toString(),called:value>0n});
    }
  }
  return result;
}

async function transferHistory({sourceRoot,coreUrl,salesUrl,outputPath,replayEvidence=null,onProgress=()=>{},staging=null}) {
  const manifest=await verifyInput(sourceRoot);
  if(staging)require('./staging').assertOutputPath(outputPath);
  if((!staging&&path.dirname(outputPath)!==path.dirname(sourceRoot))||fs.existsSync(outputPath))throw new Error('MIGRATION_OUTPUT_OWNERSHIP');
  let core,sales;const clients={};
  const result={version:1,kind:marker,startedAt:new Date().toISOString(),sourceSha256:manifest.database.sha256,sourceSchemaSha256:source.schemaSha256,productActivation:false,tables:[],verified:false};
  if(replayEvidence&&(!replayEvidence.verified||replayEvidence.kind!==marker||replayEvidence.sourceSha256!==manifest.database.sha256||replayEvidence.sourceSchemaSha256!==source.schemaSha256||replayEvidence.tables?.length!==ownership.length))throw new Error('MIGRATION_REPLAY_EVIDENCE');
  const db=new DatabaseSync(path.join(sourceRoot,manifest.database.file),{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON;BEGIN');verifySqlite(db);
    core=clients.core=await connect('core',coreUrl,staging);sales=clients.sales=await connect('sales',salesUrl,staging);
    const structure={},allTables={},keys={};
    for(const [domain,client] of Object.entries(clients)) {
      await client.query('SELECT pg_advisory_lock($1)',[domain==='core'?9261203:9261205]);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL ROLE gp_'+domain+'_owner');
      await client.query("SET LOCAL statement_timeout='15min';SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='15min'");
      allTables[domain]=await targetTables(client,domain);
      const occupied=(await client.query(allTables[domain].map(t=>`SELECT '${t.name}' AS name WHERE EXISTS(SELECT 1 FROM ${relation(t)})`).join(' UNION ALL '))).rows;
      if(occupied.length&&!replayEvidence)throw new Error('MIGRATION_TARGET_NOT_EMPTY');
      if(replayEvidence){
        const sessions=(await client.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].count;
        if(sessions)throw new Error('MIGRATION_REPLAY_ACTIVE_CLIENTS');
        for(const table of ownership.filter(t=>t.database===domain))await verifyTable(client,table,replayEvidence.tables.find(t=>t.name===table.name));
        const referenceCounts=domain==='core'?{
          article_reference_snapshots:replayEvidence.references.articleReferences,
          trade_source_references:replayEvidence.references.sourceReferences,
          trade_source_reference_versions:replayEvidence.references.sourceReferences,
        }:{core_location_references:replayEvidence.references.locations,migration_fixture_owner:1};
        for(const table of allTables[domain].filter(t=>!ownership.some(o=>o.database===domain&&o.name===t.name))){
          const count=Number((await client.query('SELECT count(*) AS count FROM '+relation(table))).rows[0].count);
          if(count!==(referenceCounts[table.name]||0))throw new Error('MIGRATION_REPLAY_REFERENCE_DRIFT');
        }
        if(domain==='sales'){
          const owner=(await client.query('SELECT id FROM gp.migration_fixture_owner')).rows;
          if(owner.length!==1||owner[0].id!==marker+':'+result.sourceSha256)throw new Error('MIGRATION_REPLAY_OWNER');
        }
        onProgress({replayVerified:domain});
        await client.query('TRUNCATE TABLE '+allTables[domain].map(relation).join(',')+' RESTART IDENTITY');
      }
      structure[domain]=await schemaFingerprint(client,domain==='core'?['gp']:SCHEMAS);keys[domain]=await foreignKeys(client,domain);
      for(const key of keys[domain])await client.query('ALTER TABLE '+relation(key)+' ALTER CONSTRAINT '+q(key.constraint)+' DEFERRABLE INITIALLY DEFERRED');
      for(const table of allTables[domain])await client.query('ALTER TABLE '+relation(table)+' DISABLE TRIGGER USER');
    }
    // Local branch references precede Sales foreign keys. Source and article
    // references are populated from the already imported Sales transaction.
    for(const {id} of db.prepare('SELECT id FROM locations ORDER BY id').all())await sales.query('INSERT INTO integration.core_location_references VALUES($1,$2)',[id,hash(db.prepare('SELECT id,name,active FROM locations WHERE id=?').get(id))]);
    for(const table of ownership.filter(t=>t.database==='sales'))result.tables.push(await copyTable(db,sales,table,onProgress));
    result.references=await references(db,core,sales);
    for(const table of ownership.filter(t=>t.database==='core'))result.tables.push(await copyTable(db,core,table,onProgress));
    for(const [domain,client] of Object.entries(clients)) {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for(const key of keys[domain])await client.query('ALTER TABLE '+relation(key)+' ALTER CONSTRAINT '+q(key.constraint)+(key.deferrable?' DEFERRABLE INITIALLY '+(key.deferred?'DEFERRED':'IMMEDIATE'):' NOT DEFERRABLE'));
      for(const table of allTables[domain])await client.query('ALTER TABLE '+relation(table)+' ENABLE TRIGGER USER');
      result[domain+'Sequences']=await sequences(db,client,ownership.filter(t=>t.database===domain));
      if(await schemaFingerprint(client,domain==='core'?['gp']:SCHEMAS)!==structure[domain])throw new Error('MIGRATION_FINAL_SCHEMA_DRIFT');
      for(const table of ownership.filter(t=>t.database===domain)){await verifyTable(client,table,result.tables.find(t=>t.name===table.name));onProgress({verifiedTable:table.name});}
    }
    await sales.query('INSERT INTO gp.migration_fixture_owner(id) VALUES($1)',[marker+':'+result.sourceSha256]);
    // These are isolated unpublished databases. No successful pair marker is
    // written unless both commits and the subsequent full verification succeed.
    await sales.query('COMMIT');await core.query('COMMIT');
    for(const [domain,client] of Object.entries(clients)) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      for(const table of ownership.filter(t=>t.database===domain))await verifyTable(client,table,result.tables.find(t=>t.name===table.name));
      await client.query('COMMIT');
    }
    result.verified=true;result.completedAt=new Date().toISOString();result.contentSha256=hash(result.tables.map(({name,database,rows,sha256})=>({name,database,rows,sha256})));result.files={verified:manifest.files.length,configurationBound:true};
    fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
  }catch(error){for(const c of Object.values(clients))try{await c.query('ROLLBACK');}catch{};throw error;}
  finally{try{db.close();}catch{};await Promise.allSettled(Object.values(clients).map(c=>c.end()));}
}
module.exports={ownership,marker,verifyInput,verifySqlite,columnsFor,orderFor,verifyTable,transferHistory,connect,fileHash};
