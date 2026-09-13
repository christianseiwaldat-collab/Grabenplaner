'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{Client}=require('pg');
async function qualifyExport({root,config}){
 const module=require('../../lib/persistence/postgresql/operations/application-export');
 const {captureCheckpoint}=require('../../lib/persistence/postgresql/operations/paired-checkpoint');
 const urls=Object.fromEntries(['core','sales'].map(domain=>{const u=new URL('postgresql://127.0.0.1:55487/gp_migration_'+domain);u.username='gp_'+domain+'_app';u.password=config.recoveryAccounts[u.username];return [domain+'Url',u.href];}));
 const pg={host:'127.0.0.1',port:55487,user:'gp_migration_admin',password:config.recoveryAccounts.gp_migration_admin,database:'postgres'};
 const admin=new Client(pg),created=[],expected={};let exported;
 const native=async(name,args,environment={})=>{
  const binary=name==='tar'?'/usr/bin/tar':'/usr/lib/postgresql/18/bin/'+name;
  const stderr=fs.openSync(root+'/export-tool.error','w',0o600);
  try{await new Promise((resolve,reject)=>{const child=spawn(binary,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...environment},stdio:['ignore','ignore',stderr]});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('APPLICATION_EXPORT_RESTORE_'+code)));});}finally{fs.closeSync(stderr);}
 };
 try{
  await admin.connect();
  for(const domain of ['core','sales']){
   const client=new Client({...pg,database:'gp_migration_'+domain});await client.connect();
   try{await client.query('BEGIN READ ONLY');expected[domain]=await captureCheckpoint(client,domain);await client.query('COMMIT');}finally{await client.end();}
  }
  exported=await module.createApplicationDatabaseExport({...urls,directory:root+'/runtime/transient/database-exports'});
  await assert.rejects(module.createApplicationDatabaseExport(urls),/BACKUP_WORKSPACE_BUSY/);
  assert.equal(exported.extension,'tar');assert.ok(exported.size>1000000);
  const extraction=path.join(exported.temporaryRoot,'restore');fs.mkdirSync(extraction,{mode:0o700});
  await native('tar',['--extract','--file='+exported.path,'--directory='+extraction,'--']);
  assert.deepEqual(fs.readdirSync(extraction).sort(),['core.dump','manifest.json','sales.dump']);
  const manifest=JSON.parse(fs.readFileSync(extraction+'/manifest.json','utf8'));
  assert.equal(manifest.serverRecoveryBackup,false);assert.equal(manifest.encryptionKeysIncluded,false);
  const results=[];
  for(const domain of ['core','sales']){
   const component=manifest.files.find(f=>f.domain===domain);assert.deepEqual(await module.hashFile(extraction+'/'+domain+'.dump'),{bytes:component.bytes,sha256:component.sha256});
   const name='gp_exportcheck_'+domain;
   assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0,'Never replace an existing verification database');
   await admin.query('CREATE DATABASE '+name+" TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'");created.push(name);
   await native('pg_restore',['--exit-on-error','--single-transaction','--dbname='+name,extraction+'/'+domain+'.dump'],{PGHOST:pg.host,PGPORT:String(pg.port),PGUSER:pg.user,PGPASSWORD:pg.password});
   const client=new Client({...pg,database:name});await client.connect();
   try{
    await client.query('BEGIN READ ONLY');const actual=await captureCheckpoint(client,domain);await client.query('COMMIT');
    const excluded=module.OBSOLETE_SALES_TABLES;
    const tables=expected[domain].tables.filter(t=>![...excluded,...module.OPERATIONS_ONLY_TABLES[domain]].includes(t.schema+'.'+t.table));
    for(const table of expected[domain].tables.filter(t=>excluded.includes(t.schema+'.'+t.table)))assert.equal(table.rows,'0');
    assert.deepEqual(actual.tables,tables);
    assert.deepEqual(actual.sequences,expected[domain].sequences.filter(s=>!excluded.some(t=>s.schema+'.'+s.name===t+'_id_seq')));
    results.push({domain,tables:tables.length,rows:tables.reduce((n,t)=>n+BigInt(t.rows),0n).toString(),sequences:actual.sequences.length});
   }finally{await client.end();}
  }
  return {passed:true,databases:results,bytes:exported.size,sha256:exported.sha256,restoredBothDatabases:true,concurrentExportRejected:true,keysExcluded:true,protectedFilesExcluded:true};
 }catch(error){
  fs.writeFileSync(root+'/export-diagnostic-private.json',JSON.stringify({code:error.code,tool:error.nativeTool,detail:error.nativeError}),{mode:0o600});throw error;
 }finally{
  for(const name of created){assert.match(name,/^gp_exportcheck_(core|sales)$/);await admin.query('DROP DATABASE '+name);}
  await admin.end();exported?.cleanup();
 }
}
module.exports={qualifyExport};
