'use strict';
const R=require('../../../lib/persistence/postgresql/operations/runtime');
const {connectionStateReasons}=require('../../../lib/persistence/postgresql/operations/paired-monitor');
async function main(){
 const [action,file,...args]=process.argv.slice(2),config=R.loadConfiguration(file);
 if(action==='check-paths'&&args.length===2){if(config.sourceFiles!==args[0]||config.backupDirectory!==args[1])throw new Error('PG_OPERATIONS_PATH_BINDING');return {verified:true};}
 if(action==='identity'&&!args.length)return require('./deploy-policy').postgresqlPairIdentity(await R.inspectPair(config));
 if(action==='backup'&&!args.length)return R.createBackup(config);
 if(action==='monitor'&&!args.length)return R.monitor(config);
 if(action==='connection-health'&&!args.length){
  const states=await R.monitor(config);
  if(states.core?.cluster_id!==config.clusterId||states.sales?.cluster_id!==config.clusterId
   ||['core','sales'].some(domain=>states[domain]?.in_recovery!==false||connectionStateReasons(states[domain]?.connections).length))throw new Error('PG_OPERATIONS_CONNECTION_STATE');
  return {verified:true};
 }
 if(action==='backup-probe'&&args.length===2)return R.latestBackup(config,{short:args[0]==='short',maximumAgeHours:Number(args[1])});
 if(action==='verify'&&args.length===2)return require('../../../lib/persistence/postgresql/operations/paired-bundle').verifyPairBundle(args[0],args[1]);
 if(action==='prune'&&args.length===1)return require('../../../lib/persistence/postgresql/operations/paired-retention').prunePairedSnapshots(config.backupDirectory,{keepDays:Number(args[0])});
 throw new Error('PG_OPERATIONS_ARGUMENTS');
}
main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({failed:true,code:error.code||null,error:/^PG_/.test(error.message)?error.message:'PostgreSQL operation failed'})+'\n');process.exitCode=1;});
