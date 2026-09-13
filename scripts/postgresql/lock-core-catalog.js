'use strict';
const fs=require('node:fs');
const {sourceEntries,compileCoreEntry}=require('../../lib/persistence/postgresql/core/catalog');
const {createSchemaPlan}=require('../../lib/persistence/postgresql/core/schema');
const validation=JSON.parse(fs.readFileSync('tmp/postgresql-catalog-validation.json','utf8').replace(/^\uFEFF/,''));
const entries=sourceEntries().map(entry=>{
  const current=compileCoreEntry(entry),validated=validation.passed.find(p=>p.statementId===entry.statement.id);
  if(!validated||validated.sourceContract!==current.provenance.sourceContract||validated.sqlSha256!==current.provenance.sqlSha256||validated.parameterTypes.length!==current.providerEntry.parameterBindings.length)throw new Error('Current live catalog validation required');
  return validated;
});
if(validation.failures.length||validation.total!==1125||entries.length!==1125)throw new Error('Complete Core validation required');
fs.writeFileSync('docs/postgresql-migration/block-4-catalog.json',JSON.stringify({version:1,scope:'core-development',productActivation:false,schemaPlanSha256:createSchemaPlan().digest,entries},null,2)+'\n');
console.log(JSON.stringify({recorded:entries.length,productActivation:false}));
