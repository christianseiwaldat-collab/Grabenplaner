'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const R=require('../../../lib/persistence/postgresql/operations/runtime');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(args=process.argv.slice(2)){
 const [expectedManifest,lease]=args,app='/opt/grabenplaner/app';
 if(process.platform!=='linux'||process.getuid()!==0||args.length!==2||! /^[a-f0-9]{64}$/.test(expectedManifest||'')
   ||lease!=='--maintenance-lock-held'||fs.realpathSync(path.resolve(__dirname,'../../..'))!==app)throw new Error('PG_IMPORT_DELETE_MIGRATION_INSTALLED_SCOPE');
 if(fs.realpathSync('/proc/self/fd/9')!=='/run/grabenplaner/maintenance.lock'
   ||require('node:child_process').spawnSync('/usr/bin/flock',['--nonblock','9'],{stdio:Array.from({length:10},(_,i)=>i===9?9:'ignore')}).status!==0)throw new Error('PG_IMPORT_DELETE_MIGRATION_LEASE');
 // Called by the release wrapper only after the transactional updater commits,
 // while its existing maintenance lease is still held. Never run from a stage.
 const manifestBytes=fs.readFileSync(app+'/grabenplaner-server-manifest.json');
 if(hash(manifestBytes)!==expectedManifest)throw new Error('PG_IMPORT_DELETE_MIGRATION_MANIFEST');
 const manifest=JSON.parse(manifestBytes);
 require('./deploy-policy').applicationContract(app);
 for(const relative of ['server-tools/linux/lib/import-delete-migrate.js','lib/persistence/postgresql/sales/import-delete.js']){
  const entry=manifest.files.find(f=>f.path===relative);
  if(!entry||hash(fs.readFileSync(app+'/'+relative))!==entry.sha256)throw new Error('PG_IMPORT_DELETE_MIGRATION_SOURCE');
 }
 const config=R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
 const backup=await R.latestBackup(config,{short:true,maximumAgeHours:1});
 const before=await R.inspectPair(config),domain=config.domains.find(d=>d.domain==='sales');
 const client=new (require('pg').Client)(R.url(config,domain));let result;
 try{await client.connect();await client.query("SET lock_timeout='5s';SET statement_timeout='15min'");
  result=await require('../../../lib/persistence/postgresql/sales/import-delete').migrate(client,{binding:config.binding});
 }finally{await client.end();}
 const after=await R.inspectPair(config);
 if(before.core.schemaSha256!==after.core.schemaSha256||before.sales.database!==after.sales.database)throw new Error('PG_IMPORT_DELETE_MIGRATION_DOMAIN_DRIFT');
 return {verified:true,appVersion:manifest.appVersion,sourceCommit:manifest.sourceCommit,...result,backup,salesBefore:before.sales.schemaSha256,salesAfter:after.sales.schemaSha256,coreUnchanged:true};
}
if(require.main===module)main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(e=>{process.stderr.write(JSON.stringify({failed:true,code:/^PG_/.test(e.message)?e.message:e.code||'PG_IMPORT_DELETE_MIGRATION_FAILED'})+'\n');process.exitCode=1;});
module.exports={main};
