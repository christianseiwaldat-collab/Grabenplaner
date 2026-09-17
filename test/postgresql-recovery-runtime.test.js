'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recoveryUnitProperties}=require('../server-tools/linux/recovery/lib/postgresql-recovery');
test('native restoration and full application smoke share a bounded 30-minute budget with unchanged isolation',()=>{
  const root='/var/lib/grabenplaner-offsite/postgresql-recovery/099b476b-e49d-4937-908c-8ce7eab2c95f';
  const properties=recoveryUnitProperties(root);
  for(const property of ['RuntimeMaxSec=1800','CPUQuota=100%','MemoryMax=1536M','KillMode=control-group','PrivateNetwork=yes','ProtectSystem=strict','ReadWritePaths='+root])assert.ok(properties.includes(property),property);
  assert.throws(()=>recoveryUnitProperties('/var/lib/grabenplaner'),/PG_RECOVERY_UNIT_ROOT/);
});
