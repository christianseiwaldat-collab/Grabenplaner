'use strict';
const C = require('../data-import-contract');
const metadata = C.freeze(require('./metadata.json'));
const definitions = new Map(metadata.tables.map(t=>[t.name,t]));
const profiles = new Map();
const provenance = [
  {source:'_source_snapshot_sha256',target:'snapshot',type:'identifier',nullable:false},
  {source:'_source_row',target:'ordinal',type:'integer',nullable:false},
];
for(const table of metadata.tables.filter(t=>t.included)) {
  const fields=table.columns.map((c,i)=>{
    const type=table.keys?.includes(c.name)?'identifier': ['text','memo'].includes(c.type)?'source_text':
      ['byte','integer','long'].includes(c.type)?'integer':c.type==='currency'?'decimal':
      ['float','double'].includes(c.type)?'source_decimal':c.type==='datetime'?'civil_datetime':c.type;
    return {source:c.name,target:'f'+i,type,nullable:true,...(type==='decimal'?{scale:12}:{})};
  });
  const entity='trade-bestell.'+C.fingerprint(table.name).slice(0,20);
  profiles.set(table.name,C.defineDataImportProfile({id:entity,entity,version:1,sourceSystem:metadata.sourceSystem,
    sourceTable:table.name,schemaSha256:metadata.schemaSha256,keyFields:table.keys||provenance.map(f=>f.source),
    fields:[...fields,...(table.keys?[]:provenance)],dataClasses:[...new Set(table.columns.map(c=>c.dataClass))]}));
}
function tableFor(name) {const t=definitions.get(name);if(!t?.included)C.fail('IMPORT_BESTELL_TABLE_EXCLUDED');return t;}
function profileFor(name) {tableFor(name);return profiles.get(name);}
function plainDecimal(value) {
  const s=String(value),m=/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(s);
  if(!m)return s;
  const [,sign,whole,fraction='',exp]=m,pos=whole.length+Number(exp),digits=whole+fraction;
  if(Math.abs(pos)>400)C.fail('IMPORT_DECIMAL_INVALID');
  return sign+(pos<=0?'0.'+'0'.repeat(-pos)+digits:pos>=digits.length?digits+'0'.repeat(pos-digits.length):digits.slice(0,pos)+'.'+digits.slice(pos));
}
function prepareRow(name,raw,{fileSha256,rowNumber}={}) {
  const t=tableFor(name),p=profileFor(name);C.exact(raw,t.columns.map(c=>c.name));const row={};
  for(const f of p.fields.filter(f=>!f.source.startsWith('_source_'))) {
    if(!Object.hasOwn(raw,f.source))C.fail('IMPORT_FIELD_MISSING');let value=raw[f.source];
    if(value!==null) {
      if(f.type==='identifier'&&typeof value==='number') {if(!Number.isSafeInteger(value))C.fail('IMPORT_IDENTIFIER_PRECISION');value=String(value);}
      if(['decimal','source_decimal'].includes(f.type)) {
        if(typeof value==='number'&&!Number.isFinite(value))C.fail('IMPORT_DECIMAL_INVALID');
        value=plainDecimal(value);
      }
      if(f.type==='civil_datetime'&&value instanceof Date) {if(!Number.isFinite(value.getTime()))C.fail('IMPORT_CIVIL_DATETIME_INVALID');value=value.toISOString().slice(0,-1);}
    }
    row[f.source]=value;
  }
  if(!t.keys){row._source_snapshot_sha256=C.sha(fileSha256);row._source_row=C.integer(rowNumber,1);}
  return row;
}
function normalizeRow(name,raw,context) {return C.normalizeDataImportRow(profileFor(name),prepareRow(name,raw,context),true);}
function sourceRow(name,data) {const p=profileFor(name);C.exact(data,p.fields.map(f=>f.target));return Object.fromEntries(p.fields.map(f=>[f.source,data[f.target]]));}
const profileSetSha256=C.fingerprint([...profiles.values()].map(p=>[p.sourceTable,p.fingerprint]));
module.exports={metadata,profiles,profileSetSha256,tableFor,profileFor,plainDecimal,prepareRow,normalizeRow,sourceRow};
