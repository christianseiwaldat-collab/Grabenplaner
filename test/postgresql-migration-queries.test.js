'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createHash}=require('node:crypto');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {parameters}=require('../test-support/postgresql-migration/query-inputs');
const {createCoreCatalog}=require('../lib/persistence/postgresql/core/catalog');
const lock=require('../test-support/postgresql-migration-doc-fixtures/block-4-catalog.json');
const reviewedExtensions=[
  'vocational-school-catalog-v1.json','authentication-catalog-v1.json',
  'session-security-catalog-v1.json','onboarding-json-catalog-v1.json',
  'ascii-nocase-catalog-v1.json',
  'onboarding-receipt-projection-catalog-v1.json','payroll-handoff-department-catalog-v1.json',
].flatMap(name=>require('../lib/persistence/postgresql/contracts/'+name).entries);
const coreTables=new Set(require('../test-support/postgresql-migration-doc-fixtures/block-1-inventory.json').tables.filter(t=>t.database==='core').map(t=>t.name));
const sha=value=>createHash('sha256').update(value).digest('hex');

test('Core parity expectations retain every baseline/reviewed SQL pin and admit exactly the two derived receipt contracts',()=>{
  const catalog=createCoreCatalog();
  const derived=[
    ['onboarding-receipt-projection-catalog-v1.json','custom-process-management.onboarding-operation-by-id'],
    ['payroll-handoff-department-catalog-v1.json','governance-store.insert-payroll-handoff'],
  ];
  for(const [name,id] of derived){
    const extension=require('../lib/persistence/postgresql/contracts/'+name);
    assert.equal(extension.entries.length,1);assert.equal(extension.entries[0].statementId,id);
    assert.equal(extension.baseCatalog,'block-4-catalog.json');assert.equal(extension.baseSchemaPlanSha256,lock.schemaPlanSha256);
    assert.equal(extension.productActivation,false);
  }
  assert.equal(catalog.entries.length,1125);
  let otherStatements=0;
  for(const entry of catalog.entries){
    const id=entry.statement.id,base=lock.entries.find(item=>item.statementId===id);
    const reviewed=reviewedExtensions.findLast(item=>item.statementId===id&&!item.added);
    const provenance=catalog.provenance.find(item=>item.statementId===id);
    assert.ok(base,id);assert.equal(provenance.sqlSha256,reviewed?.sqlSha256||base.sqlSha256,id);
    assert.equal(sha(entry.sql),provenance.sqlSha256,id);
    if(derived.some(([,statementId])=>statementId===id)){
      assert.equal(reviewed.baseSourceContract,base.sourceContract,id);
      assert.equal(reviewed.baseSqlSha256,base.sqlSha256,id);
      assert.equal(provenance.sourceContract,base.sourceContract,id);
      assert.equal(sha(JSON.stringify(entry.parameterBindings)),reviewed.parameterBindingsSha256,id);
      assert.equal(sha(JSON.stringify(entry.parameterOrder)),reviewed.parameterOrderSha256,id);
    }else otherStatements++;
  }
  assert.equal(otherStatements,1123);
});
test('Live entire Core read catalog executes with bound synthetic inputs and compares SQLite results',{skip:!process.env.GP_PG_MIGRATION_LIVE},async()=>withCoreFixture(async f=>{
  const catalog=createCoreCatalog(),reads=catalog.entries.filter(e=>e.statement.operation!=='execute');
  const failures=[],passed=[];let cursor=0;
  async function run(){
    while(cursor<reads.length){
      const entry=reads[cursor++],id=entry.statement.id,contract=lock.entries.find(e=>e.statementId===id);
      const reviewed=reviewedExtensions.findLast(e=>e.statementId===id&&!e.added);
      assert.equal(reviewed?.sqlSha256||contract.sqlSha256,catalog.provenance.find(e=>e.statementId===id).sqlSha256);
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
