'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.resolve(__dirname,'../lib/persistence/postgresql/boundary/application.js');

for(const failurePhase of ['core-database','sales-database'])test('boundary identifies '+failurePhase+' and preserves cleanup/original failure',async()=>{
  const phases=[],closed=[],reason=Object.assign(new Error('PRIVATE DATABASE ERROR'),{code:'53300'});
  const modules={
    'node:crypto':require('node:crypto'),
    pg:{Pool:class{on(){}async end(){closed.push('lock-pool');}}},
    '../core/environment':{PROFILE:'synthetic',configuration:()=>({})},
    '../core/application':{async openCoreDevelopmentApplication(){
      if(failurePhase==='core-database')throw reason;
      return {async close(){closed.push('core');}};
    }},
    '../sales/application':{async openSalesDevelopmentApplication(){throw reason;}},
  };
  const context={module:{exports:{}},require:id=>modules[id]||{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  await assert.rejects(context.module.exports.openTwoDatabaseDevelopmentApplication({
    coreUrl:'synthetic',salesUrl:'synthetic',authorize:()=>true,
    onInitializationPhase(phase){phases.push(phase);},
  }),error=>error===reason);
  assert.deepEqual(phases,failurePhase==='core-database'?['core-database']:['core-database','sales-database']);
  assert.deepEqual(closed,failurePhase==='core-database'?['lock-pool']:['core','lock-pool']);
});
