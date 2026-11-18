'use strict';
const R=require('../../../lib/persistence/postgresql/operations/runtime');
const {connectionStateReasons}=require('../../../lib/persistence/postgresql/operations/paired-monitor');
const {prunePairedSnapshots,configuredPairedRetention}=require('../../../lib/persistence/postgresql/operations/paired-retention');
async function main(){
 const [action,file,...args]=process.argv.slice(2);
 // Installed older updaters already invoke this candidate-local read-only gate
 // before dependency builds, backup or service stop. No Java or DB is opened.
 if(action==='check-paths'){try{require('./import-verifier-assets').verifyRuntimeAssets(require('node:path').resolve(__dirname,'../../..'));}catch{throw Object.assign(new Error('PG_OPERATIONS_VERIFIER_ASSET_MODE'),{code:'PG_OPERATIONS_VERIFIER_ASSET_MODE'});}}
 const config=R.loadConfiguration(file);
 if(action==='deploy-backup-scope'&&!args.length)return R.readDeployBackupScope(config);
 if(action==='check-paths'&&args.length===2){if(config.sourceFiles!==args[0]||config.backupDirectory!==args[1])throw new Error('PG_OPERATIONS_PATH_BINDING');return {verified:true};}
 if(action==='identity'&&!args.length)return require('./deploy-policy').postgresqlPairIdentity(await R.inspectPair(config));
 if(action==='backup-standalone-core'&&!args.length)return R.createBackup(config,{
  scope:'deploy-owned',standaloneCore:true,
  onSnapshotReady:async()=>{
   require('node:child_process').execFileSync('/usr/bin/systemctl',['start','grabenplaner.service'],{stdio:['ignore','ignore','inherit'],env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});
   process.stderr.write('CORE_BACKUP_SNAPSHOT_FROZEN_APP_STARTED '+new Date().toISOString()+'\n');
  },
 });
 if(action==='backup-deploy-owned'&&!args.length){
  const result=await R.createBackup(config,{scope:'deploy-owned'});
  return {...result,retention:await prunePairedSnapshots(config.backupDirectory,{scope:'deploy-owned',keepCount:2})};
 }
 if(action==='verify-deploy-owned'&&args.length===2)return require('../../../lib/persistence/postgresql/operations/paired-bundle').verifyPairBundle(args[0],args[1],{scope:'deploy-owned'});
 if(['backup','backup-preserve'].includes(action)&&!args.length){
  const policy=configuredPairedRetention(config);
  const result=await R.createBackup(config);
  // The caller holds maintenance and workspace leases. Only rotate after the
  // new pair is sealed; a failed backup leaves the existing recovery points.
  if(action==='backup-preserve')return {...result,retention:{policy:'preserve-existing',removed:[]}};
  return policy?{...result,retention:await prunePairedSnapshots(config.backupDirectory,policy)}:result;
 }
 if(action==='monitor'&&!args.length)return R.monitor(config);
 if(action==='connection-health'&&!args.length){
  const states=await R.monitor(config);
  if(states.core?.cluster_id!==config.clusterId||states.sales?.cluster_id!==config.clusterId
   ||['core','sales'].some(domain=>states[domain]?.in_recovery!==false||connectionStateReasons(states[domain]?.connections).length))throw new Error('PG_OPERATIONS_CONNECTION_STATE');
  return {verified:true};
 }
 if(action==='recovery-files-preflight'&&!args.length)return R.recoveryFilesPreflight(config.sourceFiles);
 if(action==='backup-probe'&&args.length===2)return R.latestBackup(config,{short:args[0]==='short',maximumAgeHours:Number(args[1])});
 if(action==='verify'&&args.length===2)return require('../../../lib/persistence/postgresql/operations/paired-bundle').verifyPairBundle(args[0],args[1]);
 if(action==='prune'&&args.length===1)return prunePairedSnapshots(config.backupDirectory,configuredPairedRetention(config)||{keepDays:Number(args[0])});
 throw new Error('PG_OPERATIONS_ARGUMENTS');
}
main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({failed:true,code:error.code||null,error:/^PG_/.test(error.message)?error.message:'PostgreSQL operation failed'})+'\n');process.exitCode=1;});
