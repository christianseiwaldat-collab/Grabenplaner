'use strict';
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../lib/persistence/statements/cash-snapshots');
async function insightCashFixture(f,{scopeId='grabenplaner-main',ownerId='synthetic-owner',count=4,customer='0'}={}){
 const actor={scopeId,ownerId},time='2026-09-14T09:00:00.000Z';
 const flags=require('../lib/cash-source-policies').CASH_SOURCE_POLICIES[0].policy.statusRules[3].flags;
 const blank=(table,v)=>({...Object.fromEntries(H.tableFor('cash',table).columns.map(c=>[c.name,null])),...v});
 const data={Umsatz_KASSE:[],Umsatz_Kasse_Details:[]};
 for(let i=0;i<count;i++){
  const date=i===0?'2026-06-01':i===1?'2026-09-01':'2026-08-01',branch=i===2?'19':'018',quantity=i===3?'-1':'2',price=i===2?'150':'120';
  const head=blank('Umsatz_KASSE',{Bonnr:String(i+1),Filialid:branch,Kassenid:'0',Bondatum:date+'T09:00:00.000',RechnungsBetrag:String(Number(quantity)*Number(price)),RechnungsNr:'0',KUND_NR:customer});
  data.Umsatz_KASSE.push(head);data.Umsatz_Kasse_Details.push(blank('Umsatz_Kasse_Details',{Bonnr:head.Bonnr,Filialid:branch,Kassenid:'0',Bondatum:head.Bondatum,RepID:'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0'),EAN:'000042',Artikelbezeichnung:'Synthetic camera',VKMenge:quantity,VK_Preis:price,MWST:'20',Bestandsfilialid:branch,RohertragDM:'20',KalkRohertrag:String(Number(quantity)*20),...flags}));
 }
 const fileSha256=C.fingerprint(data),id=f.protection.digest(['source',actor,'cash',fileSha256]);
 const store=require('../lib/persistence/repositories/cash-snapshots').createCashSnapshotStore({access:f.app.provider,protection:f.protection,actor,clock:()=>time});
 await store.begin(id,{kind:'cash',fileSha256,bytes:4096,tables:TABLES.map(t=>({name:t.name,profileHash:t.profile.fingerprint,declaredRows:data[t.name]?.length||0}))});
 for(const t of TABLES){const rows=data[t.name]||[];await store.startTable(id,t.name,rows.length);for(let offset=0;offset<rows.length;offset+=C.LIMITS.batch)await store.append(id,t.name,offset+1,rows.slice(offset,offset+C.LIMITS.batch).map((r,i)=>H.prepareTradeFotoHistoryRow('cash',t.name,r,{fileSha256,rowNumber:offset+i+1})));await store.finishTable(id,t.name);}
 let result=await store.seal(id,{tables:TABLES.length,rows:count*2});while(result.status==='reviewing')result=await store.review(id);
 const policy={...require('../lib/cash-source-policies').CASH_SOURCE_POLICIES[0],fileSha256};
 const publisher=require('../lib/persistence/repositories/cash-publication-runtime').createCashPublicationRuntime({access:f.app.provider,vault:f.vault,policies:[policy],scopeId,enabled:true,clock:()=>time});
 const request={sourceId:id,expectedRevision:0,label:'Synthetic stock/price qualification',policyId:policy.id,resolveArticles:false,mappings:[{kind:'FILIALEN',sourceId:'018',targetId:'18',historical:false},{kind:'FILIALEN',sourceId:'19',targetId:'19',historical:false}]};
 const session={...f.state.session,employeeNumber:ownerId,permissions:[...f.state.session.permissions,'data:imports:read','data:imports:prepare','data:imports:apply','locations:write']};
 const preview=await publisher.operation(async()=>session,'preview',{request});await publisher.operation(async()=>session,'activate',{request,planHash:preview.planHash});
 return {fileSha256,id};
}
module.exports={insightCashFixture};
