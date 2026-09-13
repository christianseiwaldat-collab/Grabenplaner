'use strict';
const C=require('../../lib/data-import-contract'),H=require('../../lib/tradefoto-history-profiles');
const R=require('../../lib/tradefoto-sales-rules');
const {createCashSnapshotStore}=require('../../lib/persistence/repositories/cash-snapshots');
const {createCashPublications}=require('../../lib/persistence/repositories/cash-publications');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../../lib/persistence/statements/cash-snapshots');
const {IMPORT_MASTER_STATEMENTS:M}=require('../../lib/persistence/statements/import-master-data');
const {CASH_SOURCE_POLICIES}=require('../../lib/cash-source-policies');
const TIME='2026-09-12T12:00:00.000Z';
const actor={scopeId:'synthetic-migration',ownerId:'00001'};
const raw=(table,values)=>({...Object.fromEntries(H.tableFor('cash',table).columns.map(c=>[c.name,null])),...values});
const flags=Object.fromEntries(R.STATUS_FIELDS.map(k=>[k,false]));
function receipt(number,amount,positions){
  const key={Bonnr:String(number).padStart(6,'0'),Filialid:'18',Kassenid:'0',Bondatum:'2026-08-01T00:00:00.000'};
  return {head:raw('Umsatz_KASSE',{...key,RechnungsBetrag:amount,VerkäuferID:'00002',KUND_NR:'000031'}),
    lines:positions.map((p,i)=>raw('Umsatz_Kasse_Details',{...key,...flags,RepID:'00000000-0000-0000-0000-'+String(number*1000+i+1).padStart(12,'0'),EAN:'000042',VKMenge:'1',VK_Preis:'120',MWST:'20',Sortiment:130,UMarke:'Sony',RohertragDM:'20',Verkäuferid:'00003',Artikelbezeichnung:'Synthetic article',...p}))};
}
function sourceRows(receipts){return {Umsatz_KASSE:receipts.map(r=>r.head),Umsatz_Kasse_Details:receipts.flatMap(r=>r.lines),Tagesbericht:[raw('Tagesbericht',{Bondatum:null})]};}
function cashFixture(access,protection,{check,actualTargets=false}={}){
  const store=createCashSnapshotStore({access,protection,actor,clock:()=>TIME,...(check?{check}: {})});
  const policies=[CASH_SOURCE_POLICIES[0]],publications=createCashPublications({access,protection,scopeId:actor.scopeId,policies,clock:()=>TIME});
  function manifest(data){return {kind:'cash',fileSha256:C.fingerprint(data),bytes:4096,tables:TABLES.map(t=>({name:t.name,profileHash:t.profile.fingerprint,declaredRows:data[t.name]?.length||0}))};}
  function prepare(table,row,index,fileSha256){return H.prepareTradeFotoHistoryRow('cash',table.name,row,{fileSha256,rowNumber:index});}
  async function build(data,id){
    const source=manifest(data);id ||= protection.digest(['synthetic-migration-source',source.fileSha256]);
    await store.begin(id,source);
    for(const table of TABLES){
      const rows=data[table.name]||[];await store.startTable(id,table.name,rows.length);
      for(let i=0;i<rows.length;i+=200)await store.append(id,table.name,i+1,rows.slice(i,i+200).map((r,j)=>prepare(table,r,i+j+1,source.fileSha256)));
      await store.finishTable(id,table.name);
    }
    let summary=await store.seal(id,{tables:TABLES.length,rows:Object.values(data).reduce((n,r)=>n+r.length,0)});
    while(summary.status==='reviewing')summary=await store.review(id);
    return {id,summary,manifest:source};
  }
  // Block 5 provides fixed synthetic target references. The actual two-database
  // target validation and changing permissions are exercised in Block 7.
  function fixedTargets(tx){if(actualTargets)return tx;return {
    execute:(...args)=>tx.execute(...args),
    queryOne:(s,p)=>s===M.location?Promise.resolve(p.id==='18'?{id:'18',active:true}:null):s===M.employee?Promise.resolve(['00002','00003'].includes(p.id)?{id:p.id,active:true}:null):tx.queryOne(s,p),
    queryAll:(s,p)=>s===M.locationTargets?Promise.resolve([{id:'18',label:'Synthetic branch'}]):tx.queryAll(s,p),
  };}
  const projection={tables:['FILIALEN','MITARBEITER','ARTIKEL_STAMM','KUNDEN'].map(table=>({table,write:true}))};
  const request=(id,expectedRevision=0)=>({sourceId:id,expectedRevision,label:'Synthetic cash',policyId:policies[0].id,resolveArticles:false,mappings:[
    {kind:'FILIALEN',sourceId:'18',targetId:'18',historical:false},
    ...['00002','00003'].map(n=>({kind:'MITARBEITER',sourceId:n,targetId:n,historical:false})),
  ]});
  const preview=input=>access.transaction(tx=>publications.plan(fixedTargets(tx),actor,input,projection,'synthetic-session'),{isolation:'serializable'});
  const activate=async input=>{const plan=await preview(input);return access.transaction(tx=>publications.activate(fixedTargets(tx),actor,input,projection,'synthetic-session',plan.planHash),{isolation:'serializable'});};
  return {store,publications,actor,build,manifest,prepare,request,preview,activate,fixedTargets,projection};
}
module.exports={cashFixture,receipt,sourceRows,raw,actor,TIME,TABLES};
