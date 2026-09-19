'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recoveryUnitProperties}=require('../server-tools/linux/recovery/lib/postgresql-recovery');
test('native restoration and full application smoke use observed progress without an elapsed runtime cap or relaxed isolation',()=>{
  const root='/var/lib/grabenplaner-offsite/postgresql-recovery/099b476b-e49d-4937-908c-8ce7eab2c95f';
  const properties=recoveryUnitProperties(root);
  for(const property of ['RuntimeMaxSec=infinity','CPUAccounting=yes','IOAccounting=yes','TimeoutStopSec=30s','SendSIGKILL=yes','CPUQuota=100%','MemoryMax=1536M','KillMode=control-group','PrivateNetwork=yes','ProtectSystem=strict','ReadWritePaths='+root])assert.ok(properties.includes(property),property);
  assert.throws(()=>recoveryUnitProperties('/var/lib/grabenplaner'),/PG_RECOVERY_UNIT_ROOT/);
});
test('restored application copy applies the bound Xoffi upgrade through the isolated connector',async t=>{
  const migration=require('../lib/persistence/postgresql/core/xoffi-snapshots');
  const {prepareRestoredSchema}=require('../server-tools/linux/recovery/lib/postgresql-recovery-worker');
  const events=[],binding={environmentId:'synthetic'};
  const client={async connect(){events.push('connected');},async query(sql){assert.match(sql,/lock_timeout/);events.push('bounded');},async end(){events.push('closed');}};
  t.mock.method(migration,'migrate',async(c,options)=>{assert.equal(c,client);assert.equal(options.binding,binding);events.push('migrated');return {applied:true,digest:'synthetic'};});
  const config={binding,domains:[{domain:'sales',database:'test_sales'},{domain:'core',database:'test_core'}]};
  const connect=(database,role)=>{assert.equal(database,'test_core');assert.equal(role,'gp_core_migrator');return client;};
  assert.deepEqual(await prepareRestoredSchema({config,connect}),{xoffi:{applied:true,digest:'synthetic'}});
  assert.deepEqual(events,['connected','bounded','migrated','closed']);
  migration.migrate.mock.mockImplementation(async()=>{throw new Error('rejected schema');});
  await assert.rejects(prepareRestoredSchema({config,connect}),/rejected schema/);
  assert.equal(events.at(-1),'closed');
  await assert.rejects(prepareRestoredSchema({config:{domains:[]},connect}),/PG_RECOVERY_CORE_MISSING/);
});
