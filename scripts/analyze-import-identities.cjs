'use strict';
// Read-only candidate-key analysis. Only aggregate counts leave this process.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../lib/data-import-contract');
const {readTradeFotoFullSource}=require('../lib/tradefoto-full-import-source');
const candidates={trade:{ARTIKEL_FILIALEN:[['EAN','FilialID'],['EAN','FilialID','Gültigab']]},bestell:{Rechnungsdetails_Z:[['aid'],['Rechnungsnr','aid'],['Rechnungsnr','Position'],['Rechnungsnr','Filialid','aid']],Teilzahlungen:[['Kund_Nr','Rechnungsnr','Zahlungsdatum'],['Kund_Nr','Rechnungsnr','Zahlungsdatum','Zahlbetrag']]}};
async function main(){
 const [kind,file]=process.argv.slice(2);if(!candidates[kind]||!file)throw new Error('Usage: analyze-import-identities.cjs trade|bestell <copied.accdb>');
 const buffer=fs.readFileSync(path.resolve(file)),secret=crypto.randomBytes(32),sha256=crypto.createHash('sha256').update(buffer).digest('hex'),tables={};
 const hash=value=>crypto.createHmac('sha256',secret).update(C.canonical(value)).digest('hex');
 try{
  await readTradeFotoFullSource({buffer,kind,send:async message=>{
   if(message.type==='table'&&candidates[kind][message.name])tables[message.name]={rows:0,bodies:new Map(),keys:candidates[kind][message.name].map(fields=>({fields,nullRows:0,counts:new Map()}))};
   if(message.type!=='rows'||!tables[message.name])return;
   const table=tables[message.name];
   for(const row of message.rows){table.rows++;
    const body=Object.fromEntries(Object.entries(row).filter(([key])=>!key.startsWith('_source_'))),digest=hash(body);
    table.bodies.set(digest,(table.bodies.get(digest)||0)+1);
    for(const key of table.keys){const values=key.fields.map(field=>row[field]);if(values.some(v=>v===null||v===''))key.nullRows++;
     const digest=hash(values);key.counts.set(digest,(key.counts.get(digest)||0)+1);
    }
   }
  }});
  console.log(JSON.stringify({measuredAt:new Date().toISOString(),kind,sha256,scope:'one-source-snapshot-not-proof-of-long-term-stability',tables:Object.entries(tables).map(([name,t])=>({name,rows:t.rows,
   identicalRowSurplus:t.rows-t.bodies.size,candidates:t.keys.map(k=>({fields:k.fields,nullRows:k.nullRows,distinctKeys:k.counts.size,duplicateSurplus:t.rows-k.counts.size,
    maximumMultiplicity:[...k.counts.values()].reduce((n,count)=>Math.max(n,count),0)}))}))},null,2));
 }finally{buffer.fill(0);secret.fill(0);}
}
main().catch(e=>{console.error(e.code||e.name,e.message);process.exitCode=1;});
