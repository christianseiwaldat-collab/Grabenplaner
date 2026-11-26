"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
const { createTimeTrackingRepository } = require("../lib/persistence/repositories/time-tracking");
const { S } = require("../lib/persistence/statements/xoffi-snapshots");
const { CATALOG } = require("../lib/persistence/sqlite/xoffi-snapshots-catalog");


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
