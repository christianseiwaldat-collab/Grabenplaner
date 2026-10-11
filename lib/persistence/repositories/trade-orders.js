'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),Search=require('../../flexible-search');
const {visibleSourceFields}=require('../../tradefoto-bestell/access'),metadata=require('../../tradefoto-bestell/metadata.json');
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {ARTICLE_SOURCE_STATE}=require('../statements/trade-insights'),{historyPage}=require('./history-page');
const {interpret,NOTE:MOVEMENT_NOTE}=require('./trade-movements');
const PAGE=100,PARTS={positions:['BESTELLDETAILS','tradefoto-bestell'],distribution:['BestellVerteilung','tradefoto-bestell'],receipts:['WE','tradefoto-weum']};
const NOTE='Gespeicherte, vollständig übernommene Importhistorie im freigegebenen Filialumfang; kein Live-Stand und kein Nachweis aktuell offener Bestellungen. Abschnitte können unterschiedliche Importstände haben. Vollständig bedeutet: alle zugänglichen gespeicherten Einträge des Abschnitts geprüft.';
const number=v=>v==null?null:String(v);
function searchSelection(value=''){
 if(value!=='')C.text(value,256);
 // Try the original key first. The declared BE alias never changes its digits.
 const alias=/^BE(?:[ -]?)(\d+)$/i.exec(value);
 return {original:value,alias:alias?.[1]||null};
}
function coverage(available,complete=false,scanned=0,matched=0){return {scope:'authorized_stored_imported_history',available,complete,scanned,matched,state:!available?'source_missing':complete?'complete':'partial'};}
function unavailable(){return {available:false,rows:[],next:null,scanned:0,coverage:coverage(false),sources:{},note:NOTE};}
async function sources(env){
 for(const pair of [['BESTELLUNGEN','BESTELLDETAILS'],['BestellVerteilung','WE']]){
  const state=await env.tx.queryOne(ARTICLE_SOURCE_STATE,{scopeId:env.scopeId,currentHash:H.profileFor('trade',pair[0]).fingerprint,archiveHash:H.profileFor('trade',pair[1]).fingerprint});
  if(state.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 }
 const result={header:await env.source('BESTELLUNGEN')};
 for(const [part,[table,instance]]of Object.entries(PARTS))result[part]=await env.source(table,instance);
 return result;
}
function sourceInfo(all){return Object.fromEntries(Object.entries(all).map(([part,run])=>[part,run?{available:true,date:run.manifest.snapshotAt,importedAt:run.updatedAt||run.createdAt}:{available:false}]));}
function cursorFor(env,binding,input){
 const context=['trade-orders-cursor',env.scopeId,String(env.session.employeeNumber)],signature=env.protection.digest([binding,env.sourceRevision,env.p,env.session.id||null,env.session.employeeNumber,env.session.permissions||[]]);
 let state={after:'',scanned:0,matched:0,issues:{unresolvedPositions:0,articleConflicts:0}};
 if(input){let decoded;try{C.text(input,2400);decoded=env.protection.open(input,context);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
  if(decoded.signature!==signature||decoded.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);
  state={after:C.id(decoded.after),scanned:C.integer(decoded.scanned,0,10000000),matched:C.integer(decoded.matched,0,10000000),issues:{unresolvedPositions:C.integer(decoded.issues?.unresolvedPositions??0,0,10000000),articleConflicts:C.integer(decoded.issues?.articleConflicts??0,0,10000000)}};
 }
 return {state,next:s=>env.protection.seal({...s,signature,expires:Date.now()+900000},context)};
}
function allowedFields(table,fields,p){return visibleSourceFields(table,fields,p,metadata);}
async function header(env,value,filter=''){
 const f=value.fields;if(!await env.visible(f.LFilialID,filter))return null;
 const fields=allowedFields('BESTELLUNGEN',f,env.p);
 // This is the supplier search name, not permission to expose order contacts.
 fields.Suchname=f.Suchname??null;
 return {id:value.id,revision:value.revision,orderNumber:number(f.BestellNr),supplier:f.Suchname||'',date:f.Bestelldatum||null,deliveryBy:f.Lieferungbis||null,
  locationId:await env.location(f.LFilialID),sourceLocation:number(f.LFilialID),sourceDate:value.provenance.snapshotAt,importedAt:value.provenance.importedAt,fields};
}
async function scan(env,table,instance,after){return historyPage(env.tx,{scopeId:env.scopeId,sourceInstance:instance,source:'trade',sourceTable:table,after,limit:PAGE+1,snapshot:null});}
async function ordersPage(env,input={}){
 if(!env.p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','mode','locationId','cursor']);
 const selection=searchSelection(input.query??''),q={query:selection.original,mode:input.mode??(selection.original?'exact':'contains'),locationId:input.locationId??''};
 if(Object.hasOwn(input,'cursor'))C.text(input.cursor,2400);
 if(!['exact','contains'].includes(q.mode)||q.mode==='exact'&&!q.query)C.fail('IMPORT_SHAPE_INVALID');
 if(q.locationId!==''){C.id(q.locationId);if(!env.p.company&&!env.p.locationIds.includes(q.locationId)||q.locationId.startsWith('trade-source:')&&!(env.p.company&&env.p.unassigned))C.fail('IMPORT_FORBIDDEN',403);}
 if(q.mode==='exact'&&input.cursor)C.fail('IMPORT_SHAPE_INVALID');
 const all=await sources(env),cursor=q.mode==='contains'?cursorFor(env,['orders',q,Object.values(all).map(r=>r?.id||null)],input.cursor):null;
 if(!all.header)return {...unavailable(),sources:sourceInfo(all)};
 if(q.mode==='exact'){
  let value=await env.byKey('BESTELLUNGEN',[selection.original]),matchMode='original';
  if(!value&&selection.alias){value=await env.byKey('BESTELLUNGEN',[selection.alias]);matchMode='be_alias';}
  const row=value&&await header(env,value,q.locationId),rows=row?[{...row,matchMode}]:[];
  return {available:true,rows,next:null,scanned:rows.length,coverage:coverage(true,true,rows.length,rows.length),sources:sourceInfo(all),note:NOTE};
 }
 const prefetched=await scan(env,'BESTELLUNGEN','tradefoto-bestell',cursor.state.after),records=[...prefetched.records.values()],rows=[];let inspected=0;
 for(const record of records.slice(0,PAGE)){const value=await env.document(record,prefetched),row=await header(env,value,q.locationId);
  if(row){inspected++;if(Search.matches([row.orderNumber,row.supplier,row.fields.BFirma,row.sourceLocation],q.query))rows.push({...row,matchMode:'contains'});}
 }
 const state={after:records.slice(0,PAGE).at(-1)?.id||cursor.state.after,scanned:cursor.state.scanned+inspected,matched:cursor.state.matched+rows.length},next=records.length>PAGE?cursor.next(state):null;
 return {available:true,rows,next,scanned:inspected,coverage:coverage(true,!next,state.scanned,state.matched),sources:sourceInfo(all),note:NOTE};
}
async function orderDetail(env,input={}){
 if(!env.p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['orderId','orderRevision','sourceRevision','part','cursor']);
 const id=C.id(input.orderId),revision=C.integer(input.orderRevision,1),part=input.part??'header';
 if(Object.hasOwn(input,'cursor'))C.text(input.cursor,2400);
 C.text(input.sourceRevision,120);if(input.sourceRevision!==env.sourceRevision)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
 if(typeof part!=='string'||part!=='header'&&!Object.hasOwn(PARTS,part)||part==='header'&&input.cursor)C.fail('IMPORT_SHAPE_INVALID');
 const all=await sources(env);if(!all.header)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const record=await env.tx.queryOne(S.get,{scopeId:env.scopeId,id});
 if(!record||record.sourceInstance!=='tradefoto-bestell'||record.sourceTable!=='BESTELLUNGEN')C.fail('IMPORT_HISTORY_NOT_FOUND',404);
 const value=await env.document(record),head=await header(env,value);
 if(!head)C.fail('IMPORT_HISTORY_NOT_FOUND',404);if(record.revision!==revision)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
 const base={available:true,order:head,part,sources:sourceInfo(all),permissions:{customers:env.p.customers,costs:env.p.costs,finance:env.p.finance},note:part==='receipts'?NOTE+' '+MOVEMENT_NOTE:NOTE};
 if(part==='header')return {...base,rows:[],next:null,scanned:0,coverage:coverage(true,true)};
 const cursor=cursorFor(env,['order-detail',id,revision,part,Object.values(all).map(r=>r?.id||null)],input.cursor);
 if(!all[part])return {...base,available:false,rows:[],next:null,scanned:0,coverage:coverage(false)};
 const [table,instance]=PARTS[part],prefetched=await scan(env,table,instance,cursor.state.after),records=[...prefetched.records.values()],candidates=[];
 for(const item of records.slice(0,PAGE)){const document=await env.document(item,prefetched),f=document.fields;if(number(f[part==='receipts'?'Bestellnr':'BestellNr'])===head.orderNumber)candidates.push(document);}
 if(part==='distribution')await env.prefetchByKeys(candidates.map(v=>({table:'BESTELLDETAILS',key:[String(v.fields.BestellId)]})));
 const rows=[],issues={...cursor.state.issues};let inspected=0;
 for(const item of candidates){const f=item.fields,common={id:item.id,revision:item.revision,sourceDate:item.provenance.snapshotAt,importedAt:item.provenance.importedAt};
  if(part==='positions'){inspected++;rows.push({...common,positionId:number(f.BestellId),articleReference:f.EAN??null,label:f.BArtikelbezeichnung||'',fields:allowedFields(table,f,env.p),...require('../../tradefoto-bestell/purchasing').supplyState(f.BMenge??null,f.gMenge??null)});}
  if(part==='distribution'){
   if(!await env.visible(f.FilialID))continue;
   inspected++;
   const parent=await env.byKey('BESTELLDETAILS',[String(f.BestellId)]),valid=parent&&number(parent.fields.BestellNr)===head.orderNumber;
   if(!valid){issues.unresolvedPositions++;continue;}if(parent.fields.EAN!==f.EAN){issues.articleConflicts++;continue;}
   rows.push({...common,positionId:number(f.BestellId),articleReference:f.EAN??null,locationId:await env.location(f.FilialID),sourceLocation:number(f.FilialID),fields:allowedFields(table,f,env.p)});
  }
  if(part==='receipts'){
   const movement=interpret(f),first=await env.visible(f.FilialID),second=movement.kind!=='receipt'&&await env.visible(f.Filialid2);
   if(!first&&!second)continue;
   inspected++;
   const endpoint=async(raw,allowed)=>allowed?{sourceId:number(raw),locationId:await env.location(raw)}:{sourceId:null,locationId:null};
   const names=['We_ID','We','Umlagerung','EAN','Suchname','Menge','WEDatum','AkWeDatum','Bestellnr','Lieferscheinnr','Rechnungsnr','KorbId',...(env.p.costs?['NNPreis','Rechnungspreis']:[])];
   const fields=Object.fromEntries(names.filter(key=>Object.hasOwn(f,key)).map(key=>[key,f[key]]));
   rows.push({...common,...movement,movementNumber:number(f.We_ID),articleReference:f.EAN??null,fields,endpoints:{from:movement.kind==='receipt'?null:await endpoint(f.FilialID,first),to:await endpoint(movement.kind==='receipt'?f.FilialID:f.Filialid2,movement.kind==='receipt'?first:second)},physicalReceiptConfirmed:false,documentReferencesVerified:false});
  }
 }
 const state={after:records.slice(0,PAGE).at(-1)?.id||cursor.state.after,scanned:cursor.state.scanned+inspected,matched:cursor.state.matched+rows.length,issues},next=records.length>PAGE?cursor.next(state):null;
 return {...base,rows,issues,next,scanned:inspected,coverage:coverage(true,!next,state.scanned,state.matched)};
}
module.exports={ordersPage,orderDetail,unavailable,searchSelection,NOTE};
