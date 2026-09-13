'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {parameters}=require('../test-support/postgresql-migration/query-inputs');
const {createCoreCatalog}=require('../lib/persistence/postgresql/core/catalog');
const lock=require('../docs/postgresql-migration/block-4-catalog.json');
const coreTables=new Set(require('../docs/postgresql-migration/block-1-inventory.json').tables.filter(t=>t.database==='core').map(t=>t.name));
test('Live entire Core read catalog executes with bound synthetic inputs and compares SQLite results',{skip:!process.env.GP_PG_MIGRATION_LIVE},async()=>withCoreFixture(async f=>{
  const catalog=createCoreCatalog(),reads=catalog.entries.filter(e=>e.statement.operation!=='execute');
  const failures=[],passed=[];let cursor=0;
  async function run(){
    while(cursor<reads.length){
      const entry=reads[cursor++],id=entry.statement.id,contract=lock.entries.find(e=>e.statementId===id);
      assert.equal(contract.sqlSha256,catalog.provenance.find(e=>e.statementId===id).sqlSha256);
      const input=parameters(entry,contract.parameterTypes);
      const values=await Promise.allSettled([f.sqliteProvider[entry.statement.operation](entry.statement,input),f.postgres[entry.statement.operation](entry.statement,input)]);
      try {
        if(values[0].status==='rejected'||values[1].status==='rejected'){
          assert.fail('Synthetic read probe must execute on both providers: '+values.map(v=>v.status==='fulfilled'?'result':v.reason.code).join('/'));
        }else{
          if(id==='work-rule-governance.schema-tables'){
            values[0].value=values[0].value.filter(row=>coreTables.has(row.data.name));
            assert.equal(values[1].value.length,191,'Core catalog hides Sales and private migration control tables');
          }
          assert.deepEqual(values[1].value,values[0].value);
          passed.push({id,outcome:'matching-result',rows:Array.isArray(values[0].value)?values[0].value.length:values[0].value===null?0:1});
        }
      }catch(error){failures.push({id,message:error.message.slice(0,1400),outcomes:values.map(v=>v.status==='fulfilled'?'result':v.reason.code)});}
    }
  }
  await Promise.all([run(),run(),run()]);
  const report={scope:'core-development-read-probe',productActivation:false,total:reads.length,passed,failures};
  fs.writeFileSync('tmp/postgresql-read-parity.json',JSON.stringify(report,null,2)+'\n');
  assert.deepEqual(failures,[]);
}));
