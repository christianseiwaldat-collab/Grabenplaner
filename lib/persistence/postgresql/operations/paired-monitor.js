'use strict';
// Measure the idle state itself; a long transaction can still be making progress.
const IDLE_TRANSACTION_WARNING_SECONDS=5;
const QUERY=`SELECT current_database() AS database,current_user AS role,
 (current_user=session_user) AS dedicated_identity,
 (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,
 pg_has_role(current_user,'pg_monitor','MEMBER') AS monitor_role,
 current_setting('transaction_read_only') AS read_only,
 current_setting('server_version_num')::integer AS server_version,
 current_setting('archive_mode') AS archive_mode,
 pg_is_in_recovery() AS in_recovery,pg_database_size(current_database())::text AS bytes,
 (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,
 (SELECT json_build_object(
  'total',count(*),'active',count(*) FILTER(WHERE state='active'),
  'idleInTransaction',count(*) FILTER(WHERE state LIKE 'idle in transaction%'),
  'idleInTransactionOverLimit',count(*) FILTER(WHERE state='idle in transaction' AND (state_change IS NULL OR clock_timestamp()-state_change>=interval '${IDLE_TRANSACTION_WARNING_SECONDS} seconds')),
  'abortedInTransaction',count(*) FILTER(WHERE state='idle in transaction (aborted)'),
  'blocked',count(*) FILTER(WHERE wait_event_type='Lock'))
  FROM pg_stat_activity WHERE datname=current_database()) AS connections,
 (SELECT json_build_object('archived',archived_count::text,'failed',failed_count::text,'lastArchivedAt',last_archived_time,'lastFailureAt',last_failed_time) FROM pg_stat_archiver) AS wal`;
async function readPairedDatabaseStatus({pool,database,role}){
 const client=await pool.connect();
 try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'");
  const row=(await client.query(QUERY)).rows[0];
  if(!row||row.database!==database||row.role!==role||!row.dedicated_identity||row.privileged||!row.monitor_role||row.read_only!=='on')throw new Error('PG_PAIR_MONITOR_IDENTITY');
  await client.query('COMMIT');return row;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
function connectionStateReasons(connections){
 const keys=['total','active','idleInTransaction','idleInTransactionOverLimit','abortedInTransaction','blocked'];
 if(!connections||keys.some(key=>!Number.isSafeInteger(connections[key])||connections[key]<0)
  ||keys.slice(1).some(key=>connections[key]>connections.total)
  ||connections.active+connections.idleInTransaction>connections.total
  ||connections.idleInTransactionOverLimit+connections.abortedInTransaction>connections.idleInTransaction)return ['CONNECTION_COUNTS_INVALID'];
 const reasons=[];
 if(connections.blocked>0)reasons.push('LOCK_WAIT');
 if(connections.idleInTransactionOverLimit>0)reasons.push('IDLE_TRANSACTION');
 if(connections.abortedInTransaction>0)reasons.push('ABORTED_TRANSACTION');
 return reasons;
}
function evaluatePairedStatus({core,sales,backup,restore,offsite,walOffsite,freeBytes,recoveryPolicy='paired-daily',now=Date.now()}={}){
 const reasons=[];
 if(!['paired-daily','wal-15m'].includes(recoveryPolicy))throw new Error('PG_PAIR_RECOVERY_POLICY');
 const fresh=(record,maxAge)=>record?.verified===true&&Number.isFinite(Date.parse(record.checkedAt))&&now>=Date.parse(record.checkedAt)&&now-Date.parse(record.checkedAt)<=maxAge;
 if(!core||!sales)reasons.push('DATABASE_UNAVAILABLE');
 else{
  if(core.cluster_id!==sales.cluster_id||core.database===sales.database)reasons.push('DATABASE_PAIR_MISMATCH');
  if(core.in_recovery||sales.in_recovery)reasons.push('DATABASE_RECOVERING');
  for(const [domain,state] of [['CORE',core],['SALES',sales]]){
   for(const reason of connectionStateReasons(state.connections))reasons.push(domain+'_'+reason);
  }
  if(recoveryPolicy==='wal-15m'){
   if(core.archive_mode!=='on')reasons.push('WAL_ARCHIVE_DISABLED');
   if(Date.parse(core.wal?.lastFailureAt)>Date.parse(core.wal?.lastArchivedAt))reasons.push('WAL_ARCHIVE_FAILED');
  }
 }
 if(!Number.isSafeInteger(freeBytes)||freeBytes<10*1024**3)reasons.push('DISK_RESERVE_LOW');
 if(!fresh(backup,24*3600000))reasons.push('PAIRED_BACKUP_MISSING_OR_STALE');
 if(!fresh(restore,36*3600000))reasons.push('PAIRED_RESTORE_MISSING_OR_STALE');
 if(!fresh(offsite,24*3600000))reasons.push('OFFSITE_PAIR_MISSING_OR_STALE');
 if(!/^[a-f0-9]{64}$/.test(offsite?.sourceManifestSha256||'')||offsite.sourceManifestSha256!==offsite.manifestSha256)reasons.push('OFFSITE_PAIR_BINDING_MISMATCH');
 if(recoveryPolicy==='wal-15m'&&!fresh(walOffsite,15*60000))reasons.push('OFFSITE_WAL_MISSING_OR_STALE');
 return {providerId:'postgresql-pair',recoveryPolicy,checkedAt:new Date(now).toISOString(),healthy:reasons.length===0,reasons,databases:{core:core||null,sales:sales||null},freeBytes};
}
module.exports={readPairedDatabaseStatus,evaluatePairedStatus,connectionStateReasons,IDLE_TRANSACTION_WARNING_SECONDS};
