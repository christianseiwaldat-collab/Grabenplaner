'use strict';
const C=require('../../data-import-contract'),D=require('../../tradefoto-bestell/decimal');
const H=require('../statements/import-history').IMPORT_HISTORY_STATEMENTS;
const M=require('../statements/import-master-data').IMPORT_MASTER_STATEMENTS;
const Q=require('./import-reader-cache');
const {matches}=require('../../flexible-search');
const PAGE=100;
const text=v=>v==null?'':String(v);
async function stockLocations(env){
 const branches=await env.reader.list(env.tx,'FILIALEN',['FilialID','FName'],100),result=[];
 for(const branch of branches){
  if(!await env.visible(branch.FilialID))continue;
  result.push({id:'trade-source:'+text(branch.FilialID),label:`${branch.FName||'Filiale'} · Trade ${branch.FilialID}`,sourceId:text(branch.FilialID),locationId:await env.location(branch.FilialID)});
 }
 return result;
}
async function branchPage(env,active,locationId,after,branches){
 const {tx,scopeId,protection}=env,ids=[];
 for(const branch of branches){
  const record=await tx.queryOne(M.find,{scopeId,identityHash:require('../../tradefoto-master-profiles').masterIdentity(protection,{scopeId,sourceInstance:'tradefoto-trade'},'FILIALEN',[branch.sourceId])});
  if(record){ids.push(record.id);branch.masterId=record.id;}
 }
 if(ids.length>32)C.fail('IMPORT_REPORT_METADATA_LIMIT',413);
 const candidates=await tx.queryAll(require('../statements/branch-article-stock').branchStock,{scopeId,snapshot:active.manifest.fileSha256,
  locationHash:protection.digest(['history-reference',scopeId,'location',locationId]),after,limit:PAGE+1,
  ...Object.fromEntries(Array.from({length:32},(_,i)=>['master'+i,ids[i]||'']))});
 const batch=require('./import-batch-support').supportsImportBatches(env.access);
 const read=(statement,parameters)=>batch?Q.prefetch(tx,statement,parameters):Promise.all(parameters.map(p=>tx[statement.operation](statement,p)));
 const records=await read(H.get,candidates.map(r=>({scopeId,id:r.id})));
 const parameters=candidates.map(r=>({recordId:r.id,revision:r.revision}));
 const versions=await read(H.version,parameters),segments=await read(H.segments,parameters),references=await read(H.references,parameters);
 return {records:new Map(records.map(r=>[r.id,r])),versions:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,versions[i]])),
  segments:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,segments[i]])),references:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,references[i]]))};
}
function empty(id='',label='Gesamt'){
 return {id,label,positions:0,quantity:'0',confirmedQuantity:'0',unclassifiedQuantity:'0',confirmedPositions:0,excluded:0,ambiguous:0,missingArticle:0,missingQuantity:0,negative:0,unclassified:0,
  valued:0,missingCost:0,zeroCost:0,provisionalNet:'0',confirmedNet:'0'};
}
function add(target,row){
 for(const key of ['quantity','confirmedQuantity','unclassifiedQuantity','provisionalNet','confirmedNet'])target[key]=D.add(target[key],row[key]);
 for(const key of ['positions','confirmedPositions','excluded','ambiguous','missingArticle','missingQuantity','negative','unclassified','valued','missingCost','zeroCost'])target[key]+=row[key];
}
async function stockSummary(env,input){
 const {p,tx,protection,scopeId,session}=env;
 if(!p.inventory)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','locationId','group','wgr','cursor']);
 const q=Object.fromEntries(['query','locationId','group','wgr'].map(k=>[k,input[k]||'']));
 for(const value of Object.values(q))if(value)C.text(value,120);
 if(!q.locationId)C.fail('IMPORT_BESTELL_LOCATION_REQUIRED',422);
 const sourceSelection=q.locationId.startsWith('trade-source:');
 if(!sourceSelection&&!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);
 const branches=(await stockLocations(env)).filter(b=>sourceSelection?b.id===q.locationId:b.locationId===q.locationId);
 if(sourceSelection&&!branches.length)C.fail('IMPORT_FORBIDDEN',403);
 const active=await env.source('ARTIKEL_FILIALEN','tradefoto-trade');
 if(!active)return {available:false,rows:[],next:null,complete:false,cumulative:true};
 const signature=protection.digest([p,env.epoch,env.annotationEpoch,'stock-summary',q,branches,active.id]);
 const context=['trade-stock-summary-v1',scopeId,String(session.employeeNumber)];
 let token=null;
 if(input.cursor){
  C.text(input.cursor,1000000);
  try{token=protection.open(input.cursor,context);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
  if(token.signature!==signature||token.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);
 }
 const totals=token?.totals||empty(),groups=token?.groups||{},after=token?.after||'';
 const page=await branchPage(env,active,sourceSelection?'':q.locationId,after,branches);
 const records=[...page.records.values()],stockCache=new Map(),masterCache=new Map();
 const dictionaries=new Map();
 for(const table of ['ARTIKEL_Sortimente','ARTIKEL_Warengruppen']){
  const names=table==='ARTIKEL_Sortimente'?['Sortiment','Warengruppe','Bezeichnung']:['Warengruppe','Bezeichnung'];
  dictionaries.set(table,new Map((await env.reader.dictionary(tx,table,names)).map(row=>[text(row[names[0]]),row])));
 }
 const reader={byKey:async(executor,table,key,names)=>{
  const k=C.canonical([table,key,names]);
  if(!masterCache.has(k))masterCache.set(k,dictionaries.has(table)?dictionaries.get(table).get(text(key[0]))||null:await env.reader.byKey(executor,table,key,names));
  return masterCache.get(k);
 }};
 const {classification}=require('./trade-stock');
 if(require('./import-batch-support').supportsImportBatches(env.access)){
  const keys=[];
  for(const record of records.slice(0,PAGE))keys.push(text((await env.document(record,page)).fields.EAN));
  const masters=(await Q.prefetch(tx,M.find,[...new Set(keys)].map(key=>({scopeId,identityHash:require('../../tradefoto-master-profiles').masterIdentity(protection,{scopeId,sourceInstance:'tradefoto-trade'},'ARTIKEL_STAMM',[key])})))).filter(Boolean);
  await Q.prefetch(tx,M.segments,masters.map(m=>({recordId:m.id})));
 }
 for(const record of records.slice(0,PAGE)){
  const value=await env.document(record,page),s=value.fields;
  if(sourceSelection?(!branches.some(b=>b.sourceId===text(s.FilialID))||!await env.visible(s.FilialID)):!await env.visible(s.FilialID,q.locationId))continue;
  const a=await reader.byKey(tx,'ARTIKEL_STAMM',[text(s.EAN)],['EAN','Artikelbezeichnung','Sortiment','Sachkonto','OhneBestand',...(p.costs?['DurchschnittEK']:[])]);
  if(q.query&&!matches([s.EAN,a?.Artikelbezeichnung],q.query))continue;
  const kind=a?await classification({...env,reader},a):null;
  if(q.group&&kind?.productGroup!==q.group||q.wgr&&kind?.merchandiseGroup!==q.wgr)continue;
  const groupId=kind?.productGroup||'',definition=groupId?await reader.byKey(tx,'ARTIKEL_Sortimente',[groupId],['Bezeichnung']):null;
  const groupKey=C.canonical([groupId]),row=empty();row.positions=1;
  if(!a)row.missingArticle=1;
  else if(['account','excluded','service'].includes(kind.kind))row.excluded=1;
  else{
   const pair=C.canonical([a.EAN,s.FilialID]);
   if(!stockCache.has(pair)){
    const articleMaster=await Q.read(tx,M.find,{scopeId,identityHash:require('../../tradefoto-master-profiles').masterIdentity(protection,{scopeId,sourceInstance:'tradefoto-trade'},'ARTIKEL_STAMM',[text(a.EAN)])});
    const locationMaster=branches.find(b=>b.sourceId===text(s.FilialID))?.masterId;
    const entries=articleMaster&&locationMaster?await tx.queryAll(require('../statements/branch-article-stock').articleBranchStock,{scopeId,snapshot:active.manifest.fileSha256,articleMaster:articleMaster.id,locationMaster}):[];
    stockCache.set(pair,entries.length===1?entries[0].id:null);
   }
   const unique=stockCache.get(pair)===record.id;
   if(!unique)row.ambiguous=1;
   else if(s.FBestand==null)row.missingQuantity=1;
   else{
    row.quantity=s.FBestand;
    if(D.compare(s.FBestand,'0')<0)row.negative=1;
    else if(D.compare(s.FBestand,'0')>0){
     if(kind.confirmed&&kind.kind==='goods'){row.confirmedQuantity=s.FBestand;row.confirmedPositions=1;}
     if(!kind.confirmed){row.unclassified=1;row.unclassifiedQuantity=s.FBestand;}
     if(p.costs){
      if(a.DurchschnittEK==null||D.compare(a.DurchschnittEK,'0')<0)row.missingCost=1;
      else if(D.compare(a.DurchschnittEK,'0')===0)row.zeroCost=1;
      else{
       row.valued=1;row.provisionalNet=D.multiply(s.FBestand,a.DurchschnittEK);
       if(kind.confirmed&&kind.kind==='goods')row.confirmedNet=row.provisionalNet;
      }
     }
    }
   }
  }
  if(!Object.hasOwn(groups,groupKey))groups[groupKey]=empty(groupId,definition?.Bezeichnung|| (groupId?`Sortiment ${groupId}`:'Nicht zugeordnet'));
  add(groups[groupKey],row);add(totals,row);
 }
 if(Object.keys(groups).length>2000)C.fail('IMPORT_REPORT_METADATA_LIMIT',413);
 const scanned=(token?.scanned||0)+Math.min(records.length,PAGE),more=records.length>PAGE;
 const next=more?protection.seal({signature,after:records[PAGE-1].id,totals,groups,scanned,expires:Date.now()+3600000},context):null;
 const project=row=>p.costs?row:Object.fromEntries(Object.entries(row).filter(([key])=>!['provisionalNet','confirmedNet','valued','missingCost','zeroCost'].includes(key)));
 return {available:true,cumulative:true,complete:!more,rows:Object.values(groups).sort((a,b)=>a.label.localeCompare(b.label,'de')).map(project),totals:project(totals),scanned,next,
  sourceDate:active.manifest.snapshotAt,valuationBasis:p.costs?'quantity-times-current-average-purchase-net':null,
  note:'Bestand zum letzten importierten Quellstand, keine Live-Bestandsführung. Warenwert = positiver Bestand × Ø Einkaufspreis netto aus dem übernommenen Artikelstamm. Sachkonten, Artikel ohne Bestandsführung, bestätigte Dienstleistungen, mehrdeutige Zuordnungen und negative Bestände sind nicht bewertet. Fehlende/Null-EK sowie ungeklärte Artikelarten bleiben ausgewiesen. Mengen können unterschiedliche Einheiten enthalten. Der Wert ist eine operative Näherung, keine Inventurbewertung.'};
}
module.exports={stockSummary,stockLocations,empty,add};
