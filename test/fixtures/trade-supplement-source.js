'use strict';
const E=require('../../lib/tradefoto-supplement-profiles');
function reader(kind,values={},options={}) {
 const schema=E.physical[kind];
 return()=>({getTableNames:()=>[...schema.tables.map(t=>t.name),...schema.excludedTables,...(options.extraTables||[])],getTable:name=>{
  const spec=schema.tables.find(t=>t.name===name);if(!spec)throw new Error('Excluded source table was opened');
  const rows=values[name]||[];
  return {rowCount:options.counts?.[name]??rows.length,getColumnNames:()=>spec.columns.map(c=>c.name),getColumns:()=>spec.columns,
   getData:({columns,rowOffset=0,rowLimit=Infinity})=>{options.columns?.(name,columns);return rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(c=>[c,row[c]??null])));}};
 }});
}
const buffer=(marker=0)=>{const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;b[4000]=marker;return b;};
const inventory=()=>({Inventur:[{InventurNummer:1,InventurFilialid:0,InventurDatum:new Date('2026-09-15T00:00:00Z'),gebucht:true},{InventurNummer:2,InventurFilialid:70,gebucht:true}],
 Inventurdetails:[
  {ID:1,Inventurnummer:1,InventurFilialid:0,EAN:'001',AlteMenge:5,NeueMenge:5,Differenz:0},
  {ID:2,Inventurnummer:1,InventurFilialid:0,EAN:'002',AlteMenge:5,NeueMenge:6,Differenz:1},
  {ID:3,Inventurnummer:1,InventurFilialid:0,EAN:'003',AlteMenge:5,NeueMenge:3,Differenz:-2},
  {ID:4,Inventurnummer:1,InventurFilialid:0,EAN:'004',AlteMenge:null,NeueMenge:3,Differenz:null},
  {ID:5,Inventurnummer:1,InventurFilialid:0,EAN:'005',AlteMenge:1,NeueMenge:2,Differenz:0},
 ]});
module.exports={reader,buffer,inventory};
