'use strict';
const C=require('./data-import-contract');
const E=require('./tradefoto-supplement-profiles');
const PAGE=10000;
const summaryFields=['Positionszahl','PositiveDifferenzen','NegativeDifferenzen','OhneDifferenz','UnvollstaendigeMengen'];
const headKey=row=>JSON.stringify([row.InventurNummer??row.Inventurnummer,row.InventurFilialid]);
const incomplete=row=>[row.AlteMenge,row.NeueMenge,row.Differenz].some(v=>v===null||v===undefined||!Number.isFinite(v));
function keepDetail(row) {
  return incomplete(row)||row.Differenz!==0||Math.abs(row.NeueMenge-row.AlteMenge-row.Differenz)>1e-5;
}
async function readSupplement({reader,kind,fileSha256,bytes,send}) {
  const schema=E.physical[kind],defs=E.tables.filter(t=>t.sourceFile===kind).sort((a,b)=>a.name.localeCompare(b.name,'en')),names=reader.getTableNames(),sourceCounts=new Map();
  if(names.some(name=>!schema.tables.some(t=>t.name===name)&&!schema.excludedTables.includes(name)))C.fail('IMPORT_SOURCE_TABLE_UNCLASSIFIED');
  let sourceTotal=0;
  for(const spec of schema.tables) {
    if(!names.includes(spec.name))C.fail('IMPORT_SOURCE_TABLE_MISSING');
    const table=reader.getTable(spec.name);
    if(!C.equal(table.getColumnNames(),spec.columns.map(c=>c.name))||table.getColumns().some((c,i)=>c.type!==spec.columns[i]?.type))C.fail('IMPORT_SOURCE_SCHEMA_CHANGED');
    C.integer(table.rowCount);
    const count=table.getData({columns:[],rowOffset:0,rowLimit:C.LIMITS.rows+1}).length;
    if(count!==table.rowCount)C.fail('IMPORT_SOURCE_ROW_COUNT_MISMATCH');
    sourceTotal+=count;if(sourceTotal>C.LIMITS.rows)C.fail('IMPORT_SOURCE_ROWS_LIMIT',413);
    sourceCounts.set(spec.name,count);
  }
  async function each(name,columns,visit) {
    const table=reader.getTable(name),count=sourceCounts.get(name);
    for(let offset=0;offset<count;offset+=PAGE) {
      const size=Math.min(PAGE,count-offset),rows=table.getData({columns,rowOffset:offset,rowLimit:size});
      if(rows.length!==size)C.fail('IMPORT_SOURCE_READ_COUNT_CHANGED');
      for(let i=0;i<rows.length;i++)await visit(rows[i],offset+i+1);
    }
  }
  const selectedCounts=new Map(sourceCounts),heads=new Map();
  if(kind==='inventur') {
    await each('Inventur',['InventurNummer','InventurFilialid','InventurDatum','gebucht'],row=>{
      const key=headKey(row);
      if(heads.has(key)||row.InventurNummer===null||row.InventurFilialid===null)C.fail('IMPORT_INVENTORY_HEAD_INVALID');
      heads.set(key,{...row,...Object.fromEntries(summaryFields.map(f=>[f,0]))});
    });
    let selected=0;
    await each('Inventurdetails',['Inventurnummer','InventurFilialid','AlteMenge','NeueMenge','Differenz'],row=>{
      const head=heads.get(headKey(row));if(!head)C.fail('IMPORT_INVENTORY_HEAD_MISSING');
      head.Positionszahl++;
      if(incomplete(row))head.UnvollstaendigeMengen++;
      else if(row.Differenz>0)head.PositiveDifferenzen++;
      else if(row.Differenz<0)head.NegativeDifferenzen++;
      else head.OhneDifferenz++;
      if(keepDetail(row))selected++;
    });
    for(const [key,head] of heads)if(!head.Positionszahl)heads.delete(key);
    selectedCounts.set('Inventur',heads.size);selectedCounts.set('Inventurdetails',selected);
  }
  const plan=defs.map(def=>({name:def.name,profileHash:E.profileFor(def.name).fingerprint,declaredRows:selectedCounts.get(def.name)}));
  await send({type:'manifest',kind,fileSha256,bytes,tables:plan,excludedTableNames:names.filter(n=>!defs.some(d=>d.name===n)).sort(),
    selection:{version:1,mode:kind==='inventur'?'inventory-differences':'movement-fields',tables:defs.map(d=>({name:d.name,sourceRows:sourceCounts.get(d.name),selectedRows:selectedCounts.get(d.name)}))}});
  let total=0;
  const H=require('./tradefoto-history-profiles');
  for(const def of defs) {
    const count=selectedCounts.get(def.name),checkpoint=await send({type:'table',name:def.name,expectedRows:count,declaredRows:count}),resumeAfter=checkpoint?.resumeAfter??0;
    C.integer(resumeAfter,0,count);let ordinal=0,batch=[],startRow=resumeAfter+1;
    async function emit(raw) {
      ordinal++;if(ordinal<=resumeAfter)return;
      batch.push(H.prepareTradeFotoHistoryRow('trade',def.name,raw,{fileSha256,rowNumber:ordinal}));
      if(batch.length===C.LIMITS.batch){await send({type:'rows',name:def.name,startRow,rows:batch});startRow+=batch.length;batch=[];}
    }
    if(kind==='inventur'&&def.name==='Inventur') {
      for(const head of heads.values())await emit(head);
    }else await each(def.name,def.columns.map(c=>c.name),async row=>{
      if(kind!=='inventur'||keepDetail(row))await emit(row);
    });
    if(batch.length)await send({type:'rows',name:def.name,startRow,rows:batch});
    if(ordinal!==count)C.fail('IMPORT_SOURCE_READ_COUNT_CHANGED');
    await send({type:'table-complete',name:def.name});total+=count;
  }
  await send({type:'complete',tables:defs.length,rows:total});
}
module.exports={readSupplement,keepDetail};
