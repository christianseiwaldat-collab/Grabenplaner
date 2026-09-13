'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {ownership,marker,verifyInput,verifySqlite,connect}=require('../lib/persistence/postgresql/transfer/history');
const {createSqliteSource}=require('../test-support/postgresql-migration/sqlite-source');
test('historical transfer has exact ownership and refuses unrelated PostgreSQL endpoints before connecting',async()=>{
  assert.equal(ownership.length,248);assert.equal(new Set(ownership.map(t=>t.name)).size,248);
  assert.equal(ownership.filter(t=>t.database==='core').length,194);assert.equal(ownership.filter(t=>t.database==='sales').length,54);
  for(const endpoint of ['postgresql://example@127.0.0.1:5432/gp_migration_core','postgresql://example@other.example:55482/gp_migration_core'])await assert.rejects(connect('core',endpoint),/MIGRATION_TARGET_ENDPOINT/);
});
test('historical transfer rejects schema drift and broken source references',()=>{
  const db=createSqliteSource();
  try{
    verifySqlite(db);
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec("INSERT INTO departments(id,location_id,name) VALUES(1,'missing','Synthetic')");
    assert.throws(()=>verifySqlite(db),/MIGRATION_SOURCE_FOREIGN_KEY/);
    db.exec('CREATE TABLE unexpected_source(value TEXT)');
    assert.throws(()=>verifySqlite(db),/MIGRATION_SOURCE_SCHEMA_DRIFT/);
  }finally{db.close();}
});
test('input manifest binds private files and keys and rejects byte changes and path escape',async()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pg-transfer-test-')),root=path.join(parent,'source');
  fs.mkdirSync(root,{mode:0o700});fs.chmodSync(parent,0o700);fs.writeFileSync(path.join(parent,'ownership-marker'),marker,{mode:0o600});
  const file=name=>{fs.writeFileSync(path.join(root,name),'synthetic',{mode:0o600});return {file:name,bytes:9,sha256:crypto.createHash('sha256').update('synthetic').digest('hex')};};
  const manifest={version:1,kind:'isolated-online-sqlite-copy',database:file('dienstplan.db'),configuration:file('configuration.env'),files:[file('document.amu')]};
  const write=()=>fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  try{
    write();await verifyInput(root);
    fs.writeFileSync(path.join(root,'document.amu'),'synthetic-changed');await assert.rejects(verifyInput(root),/MIGRATION_INPUT_HASH/);
    manifest.files[0].file='../foreign';write();await assert.rejects(verifyInput(root),/MIGRATION_INPUT_PATH/);
  }finally{
    if(fs.realpathSync(parent)===path.resolve(parent)&&path.dirname(parent)===path.resolve(os.tmpdir())&&path.basename(parent).startsWith('gp-pg-transfer-test-'))fs.rmSync(parent,{recursive:true});
  }
});
