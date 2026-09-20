'use strict';
// Opt-in Ubuntu benchmark: synthetic records only, no productive endpoint or
// account accepted. Run under a private-network 2 CPU / 3 GiB systemd service.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {restoreArguments,restoreSettings}=require('../lib/persistence/postgresql/operations/restore-performance');
const {sealPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
const {restorePair}=require('../lib/persistence/postgresql/operations/paired-restore');
const root=process.argv[2],BIN='/usr/lib/postgresql/18/bin';
assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);
assert.ok(path.isAbsolute(root)&&fs.realpathSync(root)===root&&path.basename(root).startsWith('gp708-benchmark-'));
assert.equal(fs.statSync(root).uid,process.getuid());assert.equal(fs.statSync(root).mode&0o077,0);
assert.deepEqual(fs.readdirSync(root),[]);
assert.ok(Object.values(require('node:os').networkInterfaces()).flat().every(x=>x.internal));
const data=root+'/data',socket=root+'/socket';fs.mkdirSync(socket,{mode:0o700});
const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:socket,PGPORT:'55484',PGUSER:'gp_migration_admin',PGDATABASE:'postgres'};
let running=false;
const results={synthetic:true,rowsPerTable:750000,tableCount:4,results:[]};
function native(name,args,extra={}){
 const p=spawnSync(BIN+'/'+name,args,{env,encoding:'utf8',maxBuffer:1024*1024,...extra});
 if(p.status!==0)throw new Error(name+': '+p.stderr);
 return p.stdout;
}
const sql=(database,text)=>native('psql',['-X','--set=ON_ERROR_STOP=1','-At','--dbname='+database,'-c',text]);
async function main(){
 try{
  native('initdb',['-D',data,'-U','gp_migration_admin','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C.UTF-8']);
  const common=`\nlisten_addresses=''\nport=55484\nunix_socket_directories='${socket}'\nautovacuum=off\n`;
  fs.appendFileSync(data+'/postgresql.conf',common+restoreSettings('baseline'));
  native('pg_ctl',['-D',data,'-l',root+'/postgresql.log','-w','start']);running=true;
  sql('postgres','CREATE DATABASE fixture');
  for(let n=0;n<4;n++)sql('fixture',`CREATE TABLE example_${n}(id bigint NOT NULL,category integer NOT NULL,payload text NOT NULL); INSERT INTO example_${n} SELECT g,g%17000,md5(g::text)||md5((g+1)::text) FROM generate_series(1,${results.rowsPerTable}) g; ALTER TABLE example_${n} ADD PRIMARY KEY(id); CREATE INDEX ON example_${n}(category,payload);`);
  const archive=root+'/fixture.dump';native('pg_dump',['--format=custom','--compress=gzip:1','--dbname=fixture','--file='+archive]);
  results.dumpBytes=fs.statSync(archive).size;
  const expected=sql('fixture',Array.from({length:4},(_,n)=>`SELECT count(*),sum(id),sum(category),sum(length(payload)) FROM example_${n}`).join(';'));
  sql('postgres','DROP DATABASE fixture');
  for(const profile of ['baseline','memory','parallel']){
   fs.writeFileSync(data+'/postgresql.auto.conf',restoreSettings(profile),{mode:0o600});
   native('pg_ctl',['-D',data,'-w','restart','-m','fast','-l',root+'/postgresql.log']);
   sql('postgres','CREATE DATABASE measured');
   const before=performance.now();native('pg_restore',restoreArguments('measured',archive,profile));
   const milliseconds=Math.round(performance.now()-before);
   const actual=sql('measured',Array.from({length:4},(_,n)=>`SELECT count(*),sum(id),sum(category),sum(length(payload)) FROM example_${n}`).join(';'));
   assert.equal(actual,expected);
   assert.equal(sql('measured',"SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready").trim(),'0');
   results.results.push({profile,milliseconds,verified:true});
   console.log(JSON.stringify({event:'profile-complete',...results.results.at(-1)}));
   sql('postgres','DROP DATABASE measured');
  }
  native('pg_ctl',['-D',data,'-m','fast','-w','stop']);running=false;
  // Exercise the real restorePair failure path after PostgreSQL has started.
  // A sealed but truncated custom archive must not invoke application smoke.
  const bundle=root+'/failure.pair',workRoot=root+'/failure-work';
  fs.mkdirSync(bundle,{mode:0o700});fs.mkdirSync(workRoot,{mode:0o700});
  const bytes=fs.readFileSync(archive);fs.writeFileSync(bundle+'/core.dump',bytes.subarray(0,Math.floor(bytes.length/2)),{mode:0o600});
  fs.writeFileSync(bundle+'/sales.dump',bytes,{mode:0o600});
  const accounts=Object.fromEntries(['gp_migration_admin','gp_operations_monitor',...['core','sales'].flatMap(d=>['app','reader','migrator'].map(p=>'gp_'+d+'_'+p))].map(n=>[n,crypto.randomBytes(24).toString('hex')]));
  const domains=['core','sales'].map(domain=>({domain,database:'probe_'+domain}));
  fs.writeFileSync(bundle+'/postgresql-operations.json',JSON.stringify({format:'grabenplaner-postgresql-operations-v1',domains,recoveryAccounts:accounts}),{mode:0o600});
  fs.writeFileSync(bundle+'/configuration.env','SYNTHETIC_ONLY=1\n',{mode:0o600});
  fs.writeFileSync(bundle+'/roles.sql',['CREATE ROLE gp_migration_admin;',...Object.keys(accounts).filter(n=>n!=='gp_migration_admin').map(n=>'CREATE ROLE '+n+' LOGIN;'),'CREATE ROLE gp_core_owner;','CREATE ROLE gp_sales_owner;'].join('\n')+'\n',{mode:0o600});
  const sealed=await sealPairBundle(bundle,{databases:domains.map(d=>({...d,file:d.domain+'.dump'})),checkpoint:{domains:{core:{restore:{synthetic:true}},sales:{restore:{synthetic:true}}}}});
  let smokeCalled=false;const phases=[];
  await assert.rejects(restorePair({bundle,commitMarker:sealed.commitMarker,workRoot,privateApplicationNetwork:true,performanceProfile:'parallel',onProgress:p=>phases.push(p),onRestored(){smokeCalled=true;}}),e=>e.message==='PG_PAIR_RESTORE_TOOL_FAILED'&&e.tool==='pg_restore');
  assert.ok(phases.includes('restore-core'));assert.ok(phases.includes('stop-cluster'));assert.equal(smokeCalled,false);
  assert.equal(fs.existsSync(workRoot+'/data/postmaster.pid'),false);
  results.failureClosed={rejected:true,smokeCalled,clusterStopped:true,phases};
  console.log(JSON.stringify({event:'complete',...results}));
 }finally{
  if(running)native('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  // The service supervisor preserves logs/results then removes this exact root.
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
