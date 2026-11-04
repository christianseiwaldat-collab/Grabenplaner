"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
const { createTimeTrackingRepository } = require("../lib/persistence/repositories/time-tracking");
const { S } = require("../lib/persistence/statements/xoffi-snapshots");
const { CATALOG } = require("../lib/persistence/sqlite/xoffi-snapshots-catalog");

test("exact snapshot lookup rejects other import, person, calendar and scope, and never chooses an older snapshot", async () => {
  const { database, provider } = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: CATALOG });
  database.exec(`CREATE TABLE xoffi_time_imports(id TEXT PRIMARY KEY, location_id TEXT, department_id INTEGER, week_start TEXT, status TEXT);
    CREATE TABLE xoffi_time_employee_rows(id INTEGER PRIMARY KEY, import_id TEXT, employee_number TEXT);
    CREATE TABLE xoffi_time_snapshots(employee_row_id INTEGER PRIMARY KEY, snapshot_json TEXT);
    INSERT INTO xoffi_time_imports VALUES('active','18',7,'2026-09-07','active'),('old','18',7,'2026-08-31','active'),('superseded','18',7,'2026-09-07','superseded'),('branch','18',NULL,'2026-09-07','active');
    INSERT INTO xoffi_time_employee_rows VALUES(1,'active','E1'),(2,'old','E1'),(3,'superseded','E1'),(4,'branch','E1');
    INSERT INTO xoffi_time_snapshots VALUES(1,'{"kind":"mhtml","proof":"exact"}'),(2,'{"proof":"old"}'),(3,'{"proof":"superseded"}'),(4,'{"proof":"branch"}');`);
  const repository=createTimeTrackingRepository(provider);
  const query={importId:'active',employeeNumber:'E1',locationId:'18',departmentId:7,weekStart:'2026-09-07'};
  try{
    assert.deepEqual(await repository.getScopedXoffiSnapshot(query),{importId:'active',employeeNumber:'E1',weekStart:'2026-09-07',snapshot:{kind:'mhtml',proof:'exact'}});
    for(const changed of [{importId:'absent'},{importId:'old'},{importId:'superseded'},{employeeNumber:'E2'},{locationId:'19'},{departmentId:8},{weekStart:'2026-08-31'}]){
      assert.equal(await repository.getScopedXoffiSnapshot({...query,...changed}),null);
    }
    assert.equal((await repository.getScopedXoffiSnapshot({...query,departmentId:0})).snapshot.proof,'exact');
    assert.equal((await repository.getScopedXoffiSnapshot({...query,importId:'branch',departmentId:8})).snapshot.proof,'branch');
    await assert.rejects(repository.getScopedXoffiSnapshot({...query,departmentId:'7'}));
  }finally{await provider.close();database.close();}
});

test("PostgreSQL extension compiles the identical scoped statement and binds only typed values without a database connection", async()=>{
  const catalog=require('../lib/persistence/postgresql/core/xoffi-snapshots').CATALOG;
  const entry=catalog.find(item=>item.statement===S.getScoped);
  assert.ok(entry);assert.equal(catalog.length,Object.keys(S).length);
  assert.match(entry.sql,/gp\.xoffi_time_snapshots/);assert.match(entry.sql,/location_id/);assert.match(entry.sql,/department_id/);
  assert.match(entry.sql,/week_start/);assert.match(entry.sql,/status\s*=\s*'active'/);
  const seen=[],columns=Object.keys(S.getScoped.columns);
  const pool={async connect(){return{async query(configuration){if(configuration?.rowMode==='array'){seen.push(configuration);return{rowCount:1,fields:columns.map(name=>({name})),rows:[['E1','exact','2026-09-07','{"proof":"scoped"}']]};}return{rowCount:null,rows:[]};},release(){}};},async end(){}};
  const provider=createPostgresqlPersistenceProvider({pool,catalog}),repository=createTimeTrackingRepository(provider);
  const parameters={importId:'exact',employeeNumber:'E1',locationId:'18',departmentId:7,weekStart:'2026-09-07'};
  try{
    assert.deepEqual(await repository.getScopedXoffiSnapshot(parameters),{employeeNumber:'E1',importId:'exact',weekStart:'2026-09-07',snapshot:{proof:'scoped'}});
    assert.equal(seen.length,1);assert.equal(seen[0].rowMode,'array');
    assert.deepEqual(seen[0].values,entry.parameterBindings.map(binding=>parameters[binding.parameter]));
    for(const changed of [{departmentId:true},{departmentId:'7'},{weekStart:null},{employeeNumber:7}])await assert.rejects(repository.getScopedXoffiSnapshot({...parameters,...changed}));
    assert.equal(seen.length,1);
  }finally{await provider.close();}
});
