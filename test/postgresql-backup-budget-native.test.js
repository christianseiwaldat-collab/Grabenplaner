'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Client,Pool}=require('pg'),{spawn}=require('node:child_process');
const B=require('../lib/persistence/postgresql/operations/backup-budget');
const {createPairedSnapshot}=require('../lib/persistence/postgresql/operations/paired-backup');
const {verifyEnvironment}=require('../lib/persistence/postgresql/core/environment');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function endpoint(value,database){
 const url=new URL(value);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'25475');assert.equal(url.pathname,'/'+database);return value;
}
async function withPair(t,mode){
 // This optional proof can only touch the explicitly named, isolated fixture.
 // Neither credentials nor data values are printed or stored in test artifacts.
 const expected=process.env.GP_BACKUP_BUDGET_DATA_DIRECTORY;
 assert.ok(expected&&path.isAbsolute(expected));assert.equal(fs.realpathSync(expected),path.resolve(expected));
 assert.equal(path.basename(expected),'data');assert.equal(path.basename(path.dirname(expected)),'postgres-test');
 const admin=new Client({connectionString:endpoint(process.env.GP_MIGRATION_ADMIN_URL,'postgres')});
 const domains=[],pids=[];let childClosed=false,childPid,now=0,rollbacks=0;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-product-budget-native-'));fs.chmodSync(root,0o700);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 try{
  await admin.connect();
  const identity=(await admin.query("SELECT current_setting('port') AS port,current_setting('data_directory') AS data_directory,current_setting('server_version') AS version,current_setting('listen_addresses') AS listen")).rows[0];
  assert.equal(identity.port,'25475');assert.equal(path.resolve(identity.data_directory),path.resolve(expected));assert.match(identity.version,/^18\.6/);assert.equal(identity.listen,'127.0.0.1');
  for(const domain of ['core','sales']){
   const pool=new Pool({connectionString:endpoint(process.env['GP_'+domain.toUpperCase()+'_MIGRATOR_URL'],'gp_migration_'+domain),max:1});
   domains.push({domain,database:'gp_migration_'+domain,ownerRole:'gp_'+domain+'_owner',pool});
   const client=await pool.connect();
   try{
    await verifyEnvironment(client,{domain,purpose:'migrator'});
    await client.query("SET statement_timeout='100ms';SET idle_in_transaction_session_timeout='100ms'");
    const query=client.query.bind(client);
    client.query=(...args)=>{if(args[0]==='ROLLBACK'){if(mode==='tool-timeout')assert.equal(childClosed,true,'tool must close before rollback');rollbacks++;}return query(...args);};
   }finally{client.release();}
  }
  const budget=mode==='deadline'?B.createBackupBudget({now:()=>now,milliseconds:1000}):B.createBackupBudget();
  const work=createPairedSnapshot({backupDirectory:root,domains,budget,withQuiescedWrites:f=>f({active:true,pendingMutations:0}),
   async readCheckpoint({client}){
    assert.equal((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,'25min');
    assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout,'5s');
    if(mode!=='deadline')assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'5min');
    pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return {synthetic:true};
   },
   async runDump({domain,targetFile}){
    if(mode==='connection-loss'){await admin.query('SELECT pg_terminate_backend($1)',[pids[0]]);await wait(100);}
    else if(mode==='tool-timeout')await B.runBackupTool(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{
     environment:{},output:'ignore',error:'ignore',timeoutMs:100,terminationMs:100,
     spawnImpl(...args){const child=spawn(...args);childPid=child.pid;child.once('close',()=>{childClosed=true;});return child;},
    });
    else if(mode==='deadline'){if(domain==='sales')now=1001;}
    else await wait(350);
    if(mode==='rollback')throw Object.assign(new Error('SYNTHETIC_DUMP_FAILURE'),{code:'SYNTHETIC_DUMP_FAILURE'});
    fs.writeFileSync(targetFile,'synthetic dump',{mode:0o600});
   },
   async captureRecoveryFiles({directory}){for(const name of ['configuration.env','roles.sql'])fs.writeFileSync(path.join(directory,name),'synthetic',{mode:0o600});},
  });
  if(mode==='commit'){assert.ok(fs.existsSync((await work).commitMarker));assert.equal(rollbacks,0);}
  else{
   const code={'connection-loss':'PG_PAIR_CONNECTION_LOST','tool-timeout':'PG_OPERATIONS_TOOL_TIMEOUT',deadline:'PG_BACKUP_OPERATION_TIMEOUT',rollback:'SYNTHETIC_DUMP_FAILURE'}[mode];
   await assert.rejects(work,{code});assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.complete.json')),false);
   if(mode!=='connection-loss')assert.equal(rollbacks,2);
  }
  assert.equal(pids.length,2);
  if(mode==='tool-timeout'){assert.ok(childPid);assert.equal(childClosed,true);assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'});}
  if(mode!=='connection-loss')for(const d of domains){const client=await d.pool.connect();try{
   assert.equal((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,'100ms');
   assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'100ms');
  }finally{client.release();}}
 }finally{await admin.end();await Promise.allSettled(domains.map(d=>d.pool.end()));}
}
for(const mode of ['commit','rollback','connection-loss','tool-timeout','deadline'])test('guarded native backup budget: '+mode,{skip:process.env.GP_BACKUP_BUDGET_LIVE!=='1',timeout:30000},t=>withPair(t,mode));
