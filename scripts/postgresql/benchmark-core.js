'use strict';
const { performance } = require('node:perf_hooks');
const { createSqliteSource, seedCoreFixture } = require('../../test-support/postgresql-migration/sqlite-source');
const { SQLITE_APPLICATION_CATALOG } = require('../../lib/persistence/sqlite/application-catalog');
const { createSqlitePersistenceProvider } = require('../../lib/persistence/sqlite/provider');
async function main() {
  const db = createSqliteSource();
  try {
    seedCoreFixture(db);
    const access = createSqlitePersistenceProvider({database:db,catalog:SQLITE_APPLICATION_CATALOG});
    const cases = [
      ['organization-personnel.location.list',{includeInactive:false}],
      ['organization-personnel.department.list',{includeInactive:false}],
      ['organization-personnel.portal-user.list-for-admin',{}],
      ['organization-personnel.schedule-note.get',{locationId:'18',departmentKey:'',weekStart:'2026-09-07'}],
    ];
    const results=[];
    for (const [id, parameters] of cases) {
      const entry=SQLITE_APPLICATION_CATALOG.find(e=>e.statement.id===id),samples=[];
      for(let i=0;i<105;i++) {
        const start=performance.now();
        await access[entry.statement.operation](entry.statement,parameters);
        if(i>=5)samples.push(performance.now()-start);
      }
      samples.sort((a,b)=>a-b);
      results.push({id,p50Ms:+samples[49].toFixed(3),p95Ms:+samples[94].toFixed(3),samples:samples.length});
    }
    console.log(JSON.stringify({fixture:'synthetic; full current SQLite schema; 200 employees; in-memory',
      coverage:'repository reads only; no HTTP, network, live load or report concurrency claim',node:process.version,results},null,2));
  } finally {db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
