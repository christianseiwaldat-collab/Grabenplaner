'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const migration=require('../lib/persistence/postgresql/sales/import-history-publication-reference-proof');

test('the reference proof keeps the original publication and coverage checks and requires enforced version references',()=>{
 const sql=migration.statements[0];
 for(const check of ["h.status<>'published'",'c.count<>h.expected_rows','c.first<>','c.last<>h.expected_rows','c.qualified<>h.expected_rows',
  'fk.convalidated','fk.conenforced','NOT fk.condeferrable',"session_replication_role",'attnotnull','tgconstraint=fk.oid',"tgenabled NOT IN ('O','A')"])
  assert.ok(sql.includes(check),check);
 assert.ok(sql.includes('COUNT(r.id) AS qualified'));assert.ok(!sql.includes('LEFT JOIN integration.import_history_versions'));
 assert.ok(!sql.includes('statement_timeout'));assert.ok(!sql.includes('GRANT'));
});

test('native reference proof preserves publications, rejects corruption and rolls migrations back exactly',
 {skip:!process.env.GP_REFERENCE_PROOF_TEST_URL,timeout:120000},async t=>{
 const url=new URL(process.env.GP_REFERENCE_PROOF_TEST_URL);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'56530');assert.equal(url.pathname,'/gp_publication_proof_test');
 const {Client}=require('pg'),c=new Client({connectionString:url.href,statement_timeout:10000});await c.connect();
 const fingerprint=()=>require('../lib/persistence/postgresql/core/fingerprint').schemaFingerprint(c,require('../lib/persistence/postgresql/sales/layout').SCHEMAS);
 const run='b'.repeat(64),oldRun='c'.repeat(64),profile='a'.repeat(64);
 let sequence=0;
 async function isolated(work){const name='case_'+(++sequence);await c.query('SAVEPOINT '+name);try{return await work();}finally{await c.query('ROLLBACK TO SAVEPOINT '+name);await c.query('RELEASE SAVEPOINT '+name);}}
 async function rejectsSql(sql,args,pattern){await isolated(async()=>{await assert.rejects(c.query(sql,args),e=>pattern.test(e.message)||pattern.test(e.code));});}
 const certify=()=>c.query('SELECT gp.certify_history_snapshot($1)',[run]);
 const proofs=async()=> (await c.query('SELECT * FROM integration.import_history_snapshot_attestations ORDER BY run_id')).rows;
 try{
  assert.equal((await c.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()" )).rows[0].marker,'owned-gp-publication-fix-20261118');
  assert.equal((await c.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('gp','integration','trade','kassa','reporting')")).rows[0].n,0);
  await c.query('BEGIN');
  await c.query('CREATE ROLE gp_sales_owner NOLOGIN;CREATE ROLE gp_sales_app NOLOGIN;CREATE ROLE gp_sales_reader NOLOGIN');
  for(const schema of require('../lib/persistence/postgresql/sales/layout').SCHEMAS)await c.query('CREATE SCHEMA '+schema+' AUTHORIZATION gp_sales_owner');
  await c.query('SET LOCAL ROLE gp_sales_owner');await c.query('SET LOCAL search_path=pg_catalog,gp');
  await c.query(`CREATE TABLE integration.import_history_records(id text COLLATE "C" PRIMARY KEY,scope_id text COLLATE "C" NOT NULL,
   source_instance text COLLATE "C" NOT NULL,profile_hash text COLLATE "C" NOT NULL,source text COLLATE "C" NOT NULL,source_table text COLLATE "C" NOT NULL);
   CREATE TABLE integration.import_history_versions(record_id text COLLATE "C" NOT NULL REFERENCES integration.import_history_records(id),revision bigint NOT NULL,PRIMARY KEY(record_id,revision))`);
  for(const sql of require('../lib/persistence/postgresql/sales/import-history-snapshots').statements)await c.query(sql);
  for(const sql of require('../lib/persistence/postgresql/sales/import-history-attestations').statements)await c.query(sql);
  for(const sql of require('../lib/persistence/postgresql/sales/import-history-publication-performance').statements)await c.query(sql);
  await c.query("GRANT USAGE ON SCHEMA gp,integration TO gp_sales_app,gp_sales_reader");
  await c.query("INSERT INTO integration.import_history_records SELECT 'record-'||n,'scope','tradefoto-trade',$1,'trade','ARTIKEL_FILIALEN' FROM generate_series(1,513) n",[profile]);
  await c.query("INSERT INTO integration.import_history_versions SELECT id,1 FROM integration.import_history_records");
  for(const[id,count]of[[run,512],[oldRun,1]])await c.query(`INSERT INTO integration.import_history_snapshots VALUES($1,'scope','tradefoto-trade',$2,$3,'2026-11-18T00:00:00.000Z','00001',$4,'building','building payload')`,[id,profile,'d'.repeat(64),count]);
  await c.query("INSERT INTO integration.import_history_snapshot_members SELECT $1,n,'record-'||n,1,'member proof' FROM generate_series(1,512) n",[run]);
  await c.query("INSERT INTO integration.import_history_snapshot_members VALUES($1,1,'record-1',1,'member proof')",[oldRun]);
  await c.query("UPDATE integration.import_history_snapshots SET status='published',payload='old published payload' WHERE run_id=$1",[oldRun]);
  const base=await fingerprint(),before=await proofs();
  await t.test('migration is atomic and preserves an existing attestation',async()=>{
   await isolated(async()=>{const injected=new Error('injected migration interruption');await assert.rejects(migration.migrateWithinTransaction({query:(sql,...args)=>sql.startsWith('CREATE TABLE gp.import_history_reference_proof_migration_history')?Promise.reject(injected):c.query(sql,...args)},base),e=>e===injected);});
   assert.equal(await fingerprint(),base);assert.deepEqual(await proofs(),before);
  });
  const installed=await migration.migrateWithinTransaction(c,base);assert.equal(installed.applied,true);assert.deepEqual(await proofs(),before);
  await t.test('idempotence and exact rollback retain header proofs',async()=>{
   assert.equal((await migration.migrateWithinTransaction(c,base)).applied,false);
   await isolated(async()=>{assert.equal((await migration.rollbackWithinTransaction(c,base)).applied,true);assert.equal(await fingerprint(),base);assert.deepEqual(await proofs(),before);assert.equal((await migration.migrateWithinTransaction(c,base)).target,installed.target);});
   assert.equal(await fingerprint(),installed.target);
  });
  await t.test('publishing certifies every member and the original version FK rejects missing/deleted versions',async()=>{
   await c.query("UPDATE integration.import_history_snapshots SET status='published',payload='published payload' WHERE run_id=$1",[run]);
   assert.equal((await proofs()).find(p=>p.run_id===run).header_payload,'published payload');
   await rejectsSql("INSERT INTO integration.import_history_snapshot_members VALUES($1,513,'record-513',99,'invalid')",[run],/23503/);
   // PostgreSQL reports the explicit ON DELETE RESTRICT action as 23001.
   await rejectsSql("DELETE FROM integration.import_history_versions WHERE record_id='record-1' AND revision=1",[],/23001/);
  });
  for(const field of ['scope_id','source_instance','profile_hash','source','source_table'])await t.test('changed '+field+' withdraws proof and cannot be recertified',async()=>isolated(async()=>{
   await c.query('UPDATE integration.import_history_records SET '+field+"='other' WHERE id='record-1'");assert.ok(!(await proofs()).some(p=>p.run_id===run));
   await assert.rejects(certify(),/IMPORT_HISTORY_SNAPSHOT_INCOMPLETE/);
  }));
  for(const sql of ["DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=10", "UPDATE integration.import_history_snapshot_members SET row_number=9999 WHERE run_id=$1 AND row_number=10", "INSERT INTO integration.import_history_snapshot_members VALUES($1,513,'record-513',1,'extra')"])
   await t.test('missing, non-contiguous or excess coverage remains rejected',async()=>isolated(async()=>{await c.query(sql,[run]);await assert.rejects(certify(),/IMPORT_HISTORY_SNAPSHOT_INCOMPLETE/);}));
  const fk='import_history_snapshot_members_record_id_revision_fkey';
  for(const suffix of ['', ' NOT VALID', ' DEFERRABLE INITIALLY IMMEDIATE'])await t.test('missing, unvalidated or deferred FK fails closed: '+suffix,async()=>isolated(async()=>{
   await c.query('ALTER TABLE integration.import_history_snapshot_members DROP CONSTRAINT '+fk);
   if(suffix)await c.query('ALTER TABLE integration.import_history_snapshot_members ADD CONSTRAINT '+fk+' FOREIGN KEY(record_id,revision) REFERENCES integration.import_history_versions(record_id,revision) ON DELETE RESTRICT'+suffix);
   await assert.rejects(certify(),/IMPORT_HISTORY_REFERENCE_CONTRACT/);
  }));
  await t.test('disabled enforcement triggers cannot certify a snapshot',async()=>isolated(async()=>{
   await c.query('RESET ROLE');await c.query('ALTER TABLE integration.import_history_snapshot_members DISABLE TRIGGER ALL');await c.query('SET LOCAL ROLE gp_sales_owner');await assert.rejects(certify(),/IMPORT_HISTORY_REFERENCE_CONTRACT/);
  }));
  await t.test('replication mode and nullable version keys cannot certify a snapshot',async()=>{
   await isolated(async()=>{await c.query('RESET ROLE');await c.query("SET LOCAL session_replication_role='replica'");await c.query('SET LOCAL ROLE gp_sales_owner');await assert.rejects(certify(),/IMPORT_HISTORY_REFERENCE_CONTRACT/);});
   await isolated(async()=>{await c.query('ALTER TABLE integration.import_history_snapshot_members ALTER COLUMN revision DROP NOT NULL');await assert.rejects(certify(),/IMPORT_HISTORY_REFERENCE_CONTRACT/);});
  });
  await t.test('app and reader cannot forge the protected certification',async()=>{
   for(const role of ['gp_sales_app','gp_sales_reader'])await isolated(async()=>{await c.query('SET LOCAL ROLE '+role);await assert.rejects(certify(),e=>e.code==='42501');});
  });
  await t.test('wrong migration receipts and schema drift remain rejected',async()=>{
   await isolated(async()=>{await c.query("UPDATE gp.import_history_reference_proof_migration_history SET plan_sha256=repeat('0',64)");await assert.rejects(migration.target(c,base),/contract mismatch/);});
   await isolated(async()=>{await c.query('ALTER TABLE integration.import_history_snapshot_members DROP CONSTRAINT '+fk);await assert.rejects(migration.migrateWithinTransaction(c,base),/schema drift/);await assert.rejects(migration.rollbackWithinTransaction(c,base),/schema drift/);});
  });
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
