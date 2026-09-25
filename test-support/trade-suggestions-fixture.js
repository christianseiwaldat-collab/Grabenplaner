'use strict';
const {insightCashFixture}=require('./trade-insights-cash');
async function seedSuggestions(f,{branches=['18','19'],snapshotAt='2026-09-14T09:00:00.000Z',extraSales=[],stockOverride=null,confirm=true}={}){
 const articles=[['000042','Demo Systemkamera'],['000043','Demo Reisestativ'],['000044','Demo Kameratasche'],['000045','Demo Kameraakku'],['000046','Demo Artikel ungeklärt']];
 await f.ingest('ARTIKEL_STAMM',articles.map(([EAN,Artikelbezeichnung])=>({EAN,Artikelbezeichnung,Anlagedatum:'2020-01-01T00:00:00.000',Sachkonto:false,OhneBestand:false})),{master:true,snapshotAt});
 const row=(EAN,FilialID,FBestand,extra={})=>({EAN,FilialID:Number(FilialID),FBestand,Bestellt:'0',im_Zulauf:'0',...extra});
 const stocks=stockOverride||[row('000042',branches[0],'0'),row('000042',branches[1],'8'),row('000043',branches[0],'0'),row('000044',branches[1],'9'),row('000045',branches[0],'0',{Bestellt:'4'}),row('000046',branches[0],'7')];
 const stockRun=await f.ingest('ARTIKEL_FILIALEN',stocks,{sourceInstance:'tradefoto-trade',snapshotAt});
 if(confirm)for(const [key] of articles.slice(0,4)){const def=await f.run('classification',{level:'article',key});await f.run('classification-save',{level:'article',key,expectedRevision:def.revision,kind:'goods'});}
 const day=snapshotAt.slice(0,10),start=new Date(Date.parse(day+'T00:00:00Z')-100*86400000).toISOString().slice(0,10);
 await insightCashFixture(f,{scopeId:f.scopeId||'grabenplaner-main',ownerId:f.state.session.employeeNumber,time:snapshotAt,mappings:branches.filter(id=>id===branches[0]||extraSales.some(r=>r.branch===id)).map(id=>({kind:'FILIALEN',sourceId:id,targetId:id,historical:false})),entries:[{date:start,branch:branches[0],articleNumber:'000042',quantity:'1'},{date:day,branch:branches[0],articleNumber:'000042',quantity:'4'},{date:day,branch:branches[0],articleNumber:'000043',quantity:'2'},{date:day,branch:branches[0],articleNumber:'000045',quantity:'2'},...extraSales]});
 return {stockRun,stocks};
}
module.exports={seedSuggestions};
