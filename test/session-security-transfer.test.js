'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const security=require('../lib/persistence/postgresql/transfer/session-security');
const history=require('../lib/persistence/postgresql/transfer/history');
const {createSqliteSource,seedCoreFixture}=require('../test-support/postgresql-migration/sqlite-source');
const iso='2026-10-18T12:00:00.123Z';
const preserved={ledger:{version:1},marker:{id:'session-security-v1',app_version:'0.92.90-beta',applied_at:'2026-10-18 11:00:00'}};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function seed(db,owner){
 seedCoreFixture(db,1);
 db.exec("INSERT INTO portal_roles(id,name,permissions) VALUES('employee','Employee','[]');INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password) VALUES('00001','legacy-personal-hash','employee',1,0)");
 db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('transfer-security-test-owner',owner);
 db.exec("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active) VALUES('legacy-org','legacy-org','Legacy','branch','legacy-organization-hash',1)");
 for(const [table,ownerColumn,ownerValue] of [['portal_sessions','employee_number','00001'],['portal_organization_sessions','account_id','legacy-org']]){
  const statement=db.prepare('INSERT INTO '+table+'(id,'+ownerColumn+',token_hash,expires_at,revoked_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)');
  statement.run(table+'-open',ownerValue,table+'-token','2099-01-01T00:00:00.000Z',null,iso,iso);
  statement.run(table+'-revoked',ownerValue,table+'-revoked-token','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',iso,iso);
 }
 const mobile=db.prepare("INSERT INTO mobile_sessions(id,employee_number,access_token_hash,access_expires_at,refresh_token_hash,refresh_expires_at,installation_id_hash,platform,revoked_at,revoked_reason,created_at,last_seen_at,updated_at) VALUES(?,'00001',?,'2099-01-01T00:00:00.000Z',?,'2099-01-01T00:00:00.000Z','synthetic-device','android',?,?,?,?,?)");
 mobile.run('mobile-open','access-open','refresh-open',null,'',iso,iso,iso);
 mobile.run('mobile-revoked','access-old','refresh-old','2026-01-01T00:00:00.000Z','logout',iso,iso,iso);
 const reset=db.prepare("INSERT INTO portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at,used_at,revoked_at,created_at) VALUES(?,'00001',?,'synthetic','2099-01-01T00:00:00.000Z',?,?,?)");
 reset.run('reset-open','reset-token',null,null,iso);reset.run('reset-used','reset-used-token',iso,null,iso);reset.run('reset-revoked','reset-revoked-token',null,iso,iso);
 db.exec("INSERT INTO schema_migrations(id,app_version,applied_at) VALUES('historical-marker','0.92.37-beta','2026-09-01 00:00:00')");
}
test('legacy transfer transforms only open credentials and reports exact counts',()=>{
 const db=createSqliteSource();try{
  seed(db,'synthetic');history.verifySqlite(db);
  const transform=security.transformation(db,preserved,iso);
  assert.deepEqual(Object.values(transform.revoked),[1,1,1,1]);
  for(const table of security.TABLES)for(const row of db.prepare('SELECT * FROM '+table).all()){
   const after=security.transformRow({name:table},row,transform),changed=row.revoked_at===null&&(table!=='portal_password_reset_tokens'||row.used_at===null);
   assert.deepEqual({...after},{...row,...(changed?{revoked_at:iso,...(table==='mobile_sessions'?{revoked_reason:'session_security_import'}:{})}:{})});
  }
  assert.equal(security.transformation(db,null,iso),null);
  for(const invalid of ['bad','2026-02-30T00:00:00.000Z','2026-10-18T12:00:00Z'])assert.throws(()=>security.transformation(db,preserved,invalid),/CONTRACT/);
  db.exec("INSERT INTO schema_migrations(id,app_version) VALUES('session-security-v1','0.92.90-beta')");
  assert.throws(()=>security.transformation(db,preserved,iso),/CONTRACT/);
 }finally{db.close();}
});
test('legacy column mapping accepts only reviewed types, defaults and collations',()=>{
 const policy={name:'password_policy_version',type:'int4',generated:'',notNull:true,defaultExpression:'0',collation:null};
 assert.deepEqual(security.extraColumns({database:'core',name:'portal_users'},[policy]),[{name:policy.name,kind:'integer',source:'legacy-zero'}]);
 for(const change of [{type:'int8'},{notNull:false},{defaultExpression:'1'},{generated:'s'}])assert.throws(()=>security.extraColumns({database:'core',name:'portal_users'},[{...policy,...change}]),/CONTRACT/);
 const origin={name:'authenticated_at',type:'text',generated:'',notNull:false,defaultExpression:null,collation:'C'};
 for(const change of [{type:'timestamptz'},{notNull:true},{defaultExpression:'now()'},{collation:'default'},{generated:'s'}])assert.throws(()=>security.extraColumns({database:'core',name:'portal_sessions'},[{...origin,...change}]),/CONTRACT/);
 assert.deepEqual(security.extraColumns({database:'sales',name:'portal_users'},[policy]),[]);
});
test('new SQLite source schemas and unowned import destinations remain rejected',async()=>{
 const db=createSqliteSource();try{db.exec('ALTER TABLE portal_sessions ADD COLUMN authenticated_at TEXT');assert.throws(()=>history.verifySqlite(db),/SOURCE_SCHEMA_DRIFT/);}finally{db.close();}
 for(const url of ['postgresql://x:y@127.0.0.1:55489/gp_migration_core','postgresql://x:y@example.invalid:55482/gp_migration_core'])await assert.rejects(history.connect('core',url),/TARGET_ENDPOINT/);
});
test('transfer policy classification grants no driver imports or unrelated helper exception',()=>{
 const {architectureBoundaryViolationsForText:inspect}=require('../scripts/audit-persistence-coupling');
 for(const file of ['lib/persistence/postgresql/transfer/session-security.js','lib/persistence/postgresql/transfer/session-security-other.js']){
  for(const driver of ['pg','node:'+'sqlite'])assert.ok(inspect(file,"const driver=require('"+driver+"');").some(e=>e.kind===(driver==='pg'?'postgresql-driver-import':'sqlite-driver-import-outside-boundary')),file);
 }
});

test('native legacy import into current paired target preserves hashes, revokes tokens and verifies replay',
 {skip:process.env.GP_TRANSFER_SECURITY_NATIVE!=='1',timeout:180000},async t=>{
 const {Client}=require('pg'),owner='synthetic-session-transfer-'+crypto.randomUUID();
 const urls={coreUrl:process.env.GP_CORE_MIGRATOR_URL,salesUrl:process.env.GP_SALES_MIGRATOR_URL};
 for(const [key,url] of Object.entries(urls)){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.ok(['55482','55483'].includes(u.port));assert.equal(u.pathname,'/gp_migration_'+(key==='coreUrl'?'core':'sales'));}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-session-transfer-'));fs.chmodSync(root,0o700);
 const sourceRoot=path.join(root,'source');fs.mkdirSync(sourceRoot,{mode:0o700});fs.writeFileSync(path.join(root,'ownership-marker'),history.marker,{mode:0o600});
 const db=createSqliteSource();seed(db,owner);history.verifySqlite(db);
 const originalTables=Object.fromEntries(['employees','portal_users','portal_organization_accounts',...security.TABLES,'schema_migrations'].map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY '+(name==='employees'?'personnel_number':name==='portal_users'?'employee_number':'id')).all()]));
 const dbFile=path.join(sourceRoot,'dienstplan.db');db.exec("VACUUM INTO '"+dbFile.replaceAll("'","''")+"'");db.close();fs.chmodSync(dbFile,0o600);
 fs.writeFileSync(path.join(sourceRoot,'configuration.env'),'SYNTHETIC_TRANSFER_ONLY=1\n',{mode:0o600});
 const record=file=>({file,bytes:fs.statSync(path.join(sourceRoot,file)).size,sha256:sha(fs.readFileSync(path.join(sourceRoot,file)))});
 fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify({version:1,kind:'isolated-online-sqlite-copy',database:record('dienstplan.db'),configuration:record('configuration.env'),files:[]}),{mode:0o600});
 const read=async(domain,work)=>{const c=new Client({connectionString:urls[domain+'Url']});await c.connect();try{return await work(c);}finally{await c.end();}};
 const snapshot=()=>read('core',async c=>({marker:await security.preservedMarker(c),rows:Object.fromEntries(await Promise.all(Object.keys(originalTables).map(async name=>[name,(await c.query('SELECT * FROM gp.'+name+' ORDER BY '+(name==='employees'?'personnel_number':name==='portal_users'?'employee_number':'id'))).rows])))}));
 const call=(name,options={})=>history.transferHistory({sourceRoot,...urls,outputPath:path.join(root,name+'.json'),...options});
 const before=await snapshot();assert.equal(before.rows.portal_users.length,0);assert.ok(before.marker);
 let initial;
 try{
  await t.test('failure after credential copies rolls back both target databases and preserves installed metadata',async()=>{
   await assert.rejects(call('failure',{onProgress:value=>{if(value.table==='portal_password_reset_tokens')throw Error('synthetic failure before commit');}}),/synthetic failure/);
   assert.deepEqual(await snapshot(),before);assert.equal(fs.existsSync(path.join(root,'failure.json')),false);
   await read('sales',async c=>assert.equal((await c.query('SELECT count(*) n FROM integration.core_location_references')).rows[0].n,'0'));
  });
  await t.test('full transfer preserves every record apart from declared security fields',async()=>{
   initial=await call('initial');assert.equal(initial.verified,true);assert.equal(initial.tables.length,history.ownership.length);
   assert.deepEqual(Object.values(initial.sessionSecurity.revoked),[1,1,1,1]);
   const after=await snapshot();assert.deepEqual(after.marker,before.marker);
   for(const [name,rows] of Object.entries(originalTables)){
    const actual=after.rows[name].filter(r=>name!=='schema_migrations'||r.id!=='session-security-v1');
    const expected=rows.map(r=>({...security.transformRow({name},r,initial.sessionSecurity),
     ...(['portal_users','portal_organization_accounts'].includes(name)?{password_policy_version:0}:{}),
     ...(['portal_sessions','portal_organization_sessions'].includes(name)?{authenticated_at:null,absolute_expires_at:null}:{})}));
    // PG's canonical integer transport uses strings for historical SQLite int8.
    const normalize=value=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='number'?String(v):v));
    assert.deepEqual(normalize(actual),normalize(expected),name);
   }
   for(const name of security.TABLES)await read('core',async c=>assert.equal((await c.query('SELECT count(*) n FROM gp.'+name+' WHERE revoked_at IS NULL'+(name==='portal_password_reset_tokens'?' AND used_at IS NULL':''))).rows[0].n,'0'));
  });
  await t.test('replay derives source proof again, retains migration rows and produces identical content hash',async()=>{
   const replay=await call('replay',{replayEvidence:initial});assert.equal(replay.contentSha256,initial.contentSha256);assert.deepEqual(replay.sessionSecurity,initial.sessionSecurity);assert.deepEqual(replay.targetMetadata,initial.targetMetadata);
   assert.deepEqual((await snapshot()).marker,before.marker);
  });
  await t.test('a failed replay restores all preexisting rows and no receipt is published',async()=>{
   const saved=await snapshot();await assert.rejects(call('replay-failure',{replayEvidence:initial,onProgress:value=>{if(value.table==='portal_password_reset_tokens')throw Error('synthetic replay abort');}}),/synthetic replay abort/);
   assert.deepEqual(await snapshot(),saved);assert.equal(fs.existsSync(path.join(root,'replay-failure.json')),false);
  });
  await t.test('forged evidence, changed target rows and altered migration metadata fail closed',async()=>{
   const forged=structuredClone(initial);forged.tables[0].columns=[];
   await assert.rejects(call('forged',{replayEvidence:forged}),/REPLAY_SOURCE_PROOF/);
   await read('core',async c=>{await c.query('SET ROLE gp_core_owner');await c.query("UPDATE gp.portal_users SET password_hash='changed' WHERE employee_number='00001'");});
   await assert.rejects(call('changed',{replayEvidence:initial}),/CONTENT_MISMATCH/);
   await read('core',async c=>{await c.query('SET ROLE gp_core_owner');await c.query("UPDATE gp.portal_users SET password_hash='legacy-personal-hash' WHERE employee_number='00001'; UPDATE gp.schema_migrations SET app_version='9.9.9' WHERE id='session-security-v1'");});
   await assert.rejects(call('bad-marker',{replayEvidence:initial}),/SESSION_SECURITY_CONTRACT/);
   await read('core',async c=>{await c.query('SET ROLE gp_core_owner');await c.query("UPDATE gp.schema_migrations SET app_version='0.92.90-beta' WHERE id='session-security-v1'");});
   assert.deepEqual((await snapshot()).marker,before.marker);
  });
  const finalSourceSha256=await history.fileHash(dbFile);assert.equal(finalSourceSha256,initial.sourceSha256);
  if(process.env.GP_TRANSFER_SECURITY_EVIDENCE)fs.writeFileSync(process.env.GP_TRANSFER_SECURITY_EVIDENCE,JSON.stringify({passed:true,initial,finalSourceSha256,metadataRetained:true,beforeCommitRollbackVerified:true,atomicCrossDatabaseCommit:false,syntheticOnly:true},null,2)+'\n',{mode:0o600});
 }finally{
  // Remove only this fixture's proven business rows; extension ledgers survive.
  const own=await read('core',c=>c.query("SELECT value FROM gp.settings WHERE key='transfer-security-test-owner'"));
  if(own.rows.length){assert.deepEqual(own.rows,[{value:owner}]);
   for(const domain of ['core','sales'])await read(domain,async c=>{
    await c.query('BEGIN; SET LOCAL ROLE gp_'+domain+'_owner');
    const technical=new Set(initial?.targetMetadata[domain].map(x=>x.schema+'.'+x.name)||[]);
    assert.ok(technical.has('gp.environment_contract'));
    const schemas=domain==='core'?['gp']:require('../lib/persistence/postgresql/sales/layout').SCHEMAS;
    const tables=(await c.query('SELECT schemaname s,tablename t FROM pg_tables WHERE schemaname=ANY($1::text[])',[schemas])).rows.filter(x=>!technical.has(x.s+'.'+x.t)&&!(domain==='core'&&x.s==='gp'&&x.t==='schema_migrations'));
    const q=x=>'"'+x.replaceAll('"','""')+'"';await c.query('TRUNCATE '+tables.map(x=>q(x.s)+'.'+q(x.t)).join(',')+' RESTART IDENTITY');
    if(domain==='core')await c.query("DELETE FROM gp.schema_migrations WHERE id<>'session-security-v1'");await c.query('COMMIT');
   });
  }
  assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^gp-session-transfer-/);
  assert.equal(fs.readFileSync(path.join(root,'ownership-marker'),'utf8'),history.marker);fs.rmSync(root,{recursive:true,force:false});
 }
});
