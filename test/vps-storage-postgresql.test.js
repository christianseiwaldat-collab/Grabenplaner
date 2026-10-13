'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const enabled=process.env.GP_STORAGE_POSTGRESQL_TEST==='1'&&process.platform==='linux';
test('native business preservation proof uses the reviewed Sales namespaces under a read-only transaction',
 {skip:!enabled,timeout:300000},async()=>{
  assert.equal(process.getuid(),0);
  const R=require('../lib/persistence/postgresql/operations/runtime'),{Client}=require('pg');
  const cfg=R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  const client=new Client({...R.url(cfg,cfg.domains[1],'administrator'),statement_timeout:120000});
  try{
   await client.connect();await client.query('SET ROLE gp_sales_owner');await client.query('BEGIN READ ONLY');
   assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
   const evidence=await require('../server-tools/linux/postgresql/storage-import-run').businessEvidence(client);
   assert.equal(Object.keys(evidence.counts).length,9);
   assert.ok(Object.keys(evidence.counts).some(table=>table==='trade."import_master_records"'));
   assert.ok(Object.keys(evidence.counts).some(table=>table==='integration."data_import_links"'));
   for(const value of Object.values(evidence.counts)){
    assert.match(value.count,/^\d+$/);
    if(value.count!=='0')assert.match(value.contentfingerprint,/^-?\d+$/);
   }
   assert.match(evidence.schemaSha256,/^[a-f0-9]{64}$/);
  }finally{await client.end();}
 });
test('native retirement preserves current rows, provenance links and shared payloads and resumes a committed partial batch',
 {skip:!enabled,timeout:180000},async()=>{
  assert.equal(process.getuid(),0,'Protected VPS configuration requires a root qualification process');
  const R=require('../lib/persistence/postgresql/operations/runtime'),C=require('../lib/vps-storage-contract'),I=require('../lib/persistence/postgresql/operations/import-retention');
  const cfg=R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json'),{Client}=require('pg');
  const token=crypto.randomUUID(),schema='gp_storage_qa_'+token.replaceAll('-','').slice(0,20);
  assert.match(schema,/^gp_storage_qa_[a-f0-9]{20}$/);
  const clients=Array.from({length:3},()=>new Client(R.url(cfg,cfg.domains[1],'administrator')));
  let protection,created=false,marked=false;
  try{
   for(const client of clients){await client.connect();await client.query('SET ROLE gp_sales_owner');}
   const [admin,rawCore,rawSales]=clients;
   await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION gp_sales_owner`);created=true;
   await admin.query(`REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`);
   await admin.query(`CREATE TABLE "${schema}".qualification_marker(id TEXT PRIMARY KEY)`);await admin.query(`INSERT INTO "${schema}".qualification_marker VALUES($1)`,[token]);marked=true;
   const tables=['data_import_runs','data_import_rows','data_import_changes','data_import_links','data_import_events','data_import_run_state_counts','data_import_payload_blocks','data_import_row_payload_refs','data_import_change_payload_refs'];
   for(const table of tables)await admin.query(`CREATE TABLE "${schema}".${table} (LIKE integration.${table} INCLUDING ALL)`);
   await admin.query(`CREATE TABLE "${schema}".data_import_sources(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,owner_id TEXT NOT NULL,revision BIGINT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL)`);
   for(const [table,clause] of [
    ['data_import_rows',`FOREIGN KEY(run_id) REFERENCES "${schema}".data_import_runs(id)`],
    ['data_import_changes',`FOREIGN KEY(run_id,row_number) REFERENCES "${schema}".data_import_rows(run_id,row_number)`],
    ['data_import_links',`FOREIGN KEY(last_run_id) REFERENCES "${schema}".data_import_runs(id)`],
    ['data_import_row_payload_refs',`FOREIGN KEY(run_id,row_number) REFERENCES "${schema}".data_import_rows(run_id,row_number)`],
    ['data_import_change_payload_refs',`FOREIGN KEY(run_id,row_number) REFERENCES "${schema}".data_import_changes(run_id,row_number)`],
    ...['data_import_row_payload_refs','data_import_change_payload_refs'].map(table=>[table,`FOREIGN KEY(block_id) REFERENCES "${schema}".data_import_payload_blocks(id)`])]) await admin.query(`ALTER TABLE "${schema}".${table} ADD ${clause}`);
   // Only these private synthetic tables are reachable through the adapters.
   const adapter=client=>({query:(sql,args)=>client.query(sql.replaceAll('gp.data_import_sources',`"${schema}".data_import_sources`).replaceAll('integration.',`"${schema}".`),args)});
   const core=adapter(rawCore),sales=adapter(rawSales),defs=require('../lib/tradefoto-full-import-source').definitions('trade');
   protection=require('../lib/data-import-protection').createDataImportProtection({encryptionKey:Buffer.alloc(32,7),indexKey:Buffer.alloc(32,8),keyId:'synthetic'});
   const source=async(seed,at,rows)=>{
    const actor={scopeId:'synthetic-storage',ownerId:'synthetic-owner'},fileSha256=C.digest(seed),id=protection.digest(['source',actor,'trade',fileSha256]),tables=[];
    for(const [index,def] of defs.entries()){
     const runId=C.digest(seed+':'+index),count=index===0?rows:0,manifest={sourceInstance:'tradefoto-trade',fileSha256,schemaSha256:def.profile.schemaSha256,expectedRows:count,declaredRows:count,snapshotAt:at,gates:[]};
     await sales.query('INSERT INTO integration.data_import_runs(id,scope_id,owner_id,attempt_id,profile_hash,profile,manifest,status,revision,received_count,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10,$11)',[runId,actor.scopeId,actor.ownerId,C.digest('attempt'+seed),def.profile.fingerprint,JSON.stringify(def.profile),JSON.stringify(manifest),'applied',count,at,'2026-12-01T12:00:00.000Z']);
     tables.push({name:def.name,profileHash:def.profile.fingerprint,declaredRows:count,run:{id:runId,status:'applied',receivedRows:count,counts:{applied:count},gates:[]}});
    }
    const row={id,scope_id:actor.scopeId,owner_id:actor.ownerId,revision:1,created_at:at,updated_at:at};
    const data={kind:'trade',fileSha256,fileName:'synthetic.accdb',complete:true,status:'applied',tables,catalog:{complete:true,batches:[{syntheticRollback:'remove this old copy'}]}};
    await core.query('INSERT INTO gp.data_import_sources VALUES($1,$2,$3,$4,$5,$6,$7)',[id,row.scope_id,row.owner_id,1,at,at,protection.seal(data,I.context(row))]);
    return {row,data,run:tables[0].run.id};
   };
   const old=await source('old','2026-09-01T12:00:00.000Z',2001),current=await source('current','2026-10-01T12:00:00.000Z',1);
   for(const [s,count] of [[old,2001],[current,1]]){
    await sales.query(`INSERT INTO integration.data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload)
     SELECT $1,n,$2,$2,'applied','','synthetic-cache-'||n FROM generate_series(1,$3::integer) n`,[s.run,C.digest('row'),count]);
    await sales.query(`INSERT INTO integration.data_import_changes(run_id,row_number,identity_hash,payload,reverted_at)
     SELECT $1,n,$2,'synthetic-undo-'||n,NULL FROM generate_series(1,$3::integer) n`,[s.run,C.digest('row'),count]);
    await sales.query('INSERT INTO integration.data_import_run_state_counts VALUES($1,$2,$3)',[s.run,'applied',count]);
   }
   const shared=C.digest('shared'),exclusive=C.digest('exclusive');
   for(const [index,id] of [shared,exclusive].entries())await sales.query(`INSERT INTO integration.data_import_payload_blocks(id,scope_id,owner_id,profile_hash,source_system,source_instance,source_table,entity,block_type,payload,key_id,nonce,created_at) VALUES($1,'synthetic-storage','synthetic-owner',$2,'synthetic','tradefoto-trade','synthetic','synthetic','object','synthetic-payload','synthetic',$3,'2026-09-01T12:00:00.000Z')`,[id,defs[0].profile.fingerprint,index?'abcdefghijklmnop':'ponmlkjihgfedcba']);
   for(const [run,row,block] of [[old.run,1,shared],[old.run,2001,exclusive],[current.run,1,shared]])await sales.query('INSERT INTO integration.data_import_row_payload_refs VALUES($1,$2,$3,$4)',[run,row,'record.source',block]);
   const link=C.digest('current-link');await sales.query("INSERT INTO integration.data_import_links VALUES($1,'synthetic-storage','synthetic','synthetic-target',1,$2,'current-link-payload')",[link,old.run]);
   const plan=await I.inspectImports(core,sales,protection);assert.equal(plan.pairs.length,1);assert.equal(plan.rows,2001);
   const beforeCurrent=(await sales.query('SELECT * FROM integration.data_import_rows WHERE run_id=$1',[current.run])).rows;
   await assert.rejects(I.retireImports({core,sales,protection,expectedPlan:'0'.repeat(64)}),/PLAN_CHANGED/);
   await assert.rejects(I.retireImports({core,sales,protection,expectedPlan:plan.planSha256,progress:async()=>{throw Error('synthetic-interruption');}}),/synthetic-interruption/);
   assert.equal(Number((await sales.query('SELECT count(*) FROM integration.data_import_rows WHERE run_id=$1',[old.run])).rows[0].count),1);
   assert.equal((await core.query('SELECT revision::integer AS revision FROM gp.data_import_sources WHERE id=$1',[old.row.id])).rows[0].revision,2);
   const resumed=await I.inspectImports(core,sales,protection);assert.equal(resumed.pairs.length,1);
   const result=await I.retireImports({core,sales,protection,expectedPlan:resumed.planSha256});assert.equal(result.retiredSources,1);
   assert.equal(Number((await sales.query('SELECT count(*) FROM integration.data_import_rows WHERE run_id=$1',[old.run])).rows[0].count),0);
   assert.equal(Number((await sales.query('SELECT count(*) FROM integration.data_import_changes WHERE run_id=$1',[old.run])).rows[0].count),0);
   assert.equal((await sales.query('SELECT status FROM integration.data_import_runs WHERE id=$1',[old.run])).rows[0].status,'purged');
   assert.equal((await sales.query('SELECT payload FROM integration.data_import_links WHERE id=$1',[link])).rows[0].payload,'current-link-payload');
   assert.deepEqual((await sales.query('SELECT * FROM integration.data_import_rows WHERE run_id=$1',[current.run])).rows,beforeCurrent);
   assert.deepEqual((await sales.query('SELECT id FROM integration.data_import_payload_blocks ORDER BY id')).rows.map(r=>r.id),[shared]);
   const retired=(await core.query('SELECT id,scope_id,owner_id,revision::integer AS revision,payload FROM gp.data_import_sources WHERE id=$1',[old.row.id])).rows[0];
   const data=I.authenticatedSource(retired,protection).data;assert.equal(data.retirement.complete,true);assert.equal(data.catalog,undefined);
  }finally{
   protection?.destroy();
   try{if(created){const owner=(await clients[0].query('SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname=$1',[schema])).rows[0]?.owner;
    assert.equal(owner,'gp_sales_owner');if(marked)assert.equal((await clients[0].query(`SELECT id FROM "${schema}".qualification_marker`)).rows[0].id,token);
    await clients[0].query(`DROP SCHEMA "${schema}" CASCADE`);
   }}finally{await Promise.allSettled(clients.map(c=>c.end()));}
  }
 });
