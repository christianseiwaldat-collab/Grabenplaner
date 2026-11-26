'use strict';
const { performance } = require('node:perf_hooks');
const { withCoreFixture } = require('../../test-support/postgresql-migration/core-fixture');
const { createCoreCatalog } = require('../../lib/persistence/postgresql/core/catalog');
const { assertSyntheticEndpoint } = require('../../test-support/postgresql-migration/ci-endpoint');
async function main() {
  for (const name of ['GP_CORE_MIGRATOR_URL','GP_CORE_APP_URL']) {
    assertSyntheticEndpoint(process.env[name], 'core', ['25475']);
  }
  const catalog = createCoreCatalog().entries;
  await withCoreFixture(async fixture => {
    const access = fixture.postgres;
    const cases = [
      ['organization-personnel.location.list',{includeInactive:false}],
      ['organization-personnel.department.list',{includeInactive:false}],
      ['organization-personnel.portal-user.list-for-admin',{}],
      ['organization-personnel.schedule-note.get',{locationId:'18',departmentKey:'',weekStart:'2026-09-07'}],
    ];
    const results=[];
    for (const [id, parameters] of cases) {
      const entry=catalog.find(e=>e.statement.id===id),samples=[];
      for(let i=0;i<105;i++) {
        const start=performance.now();
        await access[entry.statement.operation](entry.statement,parameters);
        if(i>=5)samples.push(performance.now()-start);
      }
      samples.sort((a,b)=>a-b);
      results.push({id,p50Ms:+samples[49].toFixed(3),p95Ms:+samples[94].toFixed(3),samples:samples.length});
    }
    console.log(JSON.stringify({fixture:'synthetic PostgreSQL Core database; three employee accounts',
      coverage:'repository reads in an isolated development database',node:process.version,results},null,2));
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
