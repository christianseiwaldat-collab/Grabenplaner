'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),Search=require('../../flexible-search');
const {MOVEMENTS:SQL,MOVEMENT_STATE}=require('../statements/trade-insights');
const {createTradeArticleReader}=require('./trade-article-history');
const types={receipt:'Wareneingang',transfer:'Umlagerung',unclear:'Bewegungsart ungeklärt'};
const NOTE='WEUM-Buchungen mit unveränderter Quellmenge. Negative Mengen können Korrekturen oder Rücknahmen sein; der Grund ist nicht belegt. Umlagerungen sind keine Empfangsbestätigung. Liefer- und Rechnungsnummern sind ungeprüfte Quellverweise.';
function interpret(fields){
 const kind=fields.We===true&&fields.Umlagerung===false?'receipt':fields.Umlagerung===true&&fields.We===false?'transfer':'unclear';
 const quantity=fields.Menge??null,quantityState=quantity===null?'missing':!/[1-9]/.test(String(quantity))?'zero':String(quantity).startsWith('-')?'negative':'positive';
 const issues=[];
 if(kind==='unclear')issues.push('Bewegungsart prüfen');
 if(quantityState==='negative')issues.push('Negative Menge · Grund ungeklärt');
 if(quantityState==='zero')issues.push('Nullmenge');
 if(quantityState==='missing')issues.push('Menge fehlt');
 if(!fields.WEDatum)issues.push('Buchungsdatum fehlt');
 return {kind,typeLabel:types[kind],quantity,quantityState,issues};
}
async function movementsPage(env,input){
 const {access,tx,protection,scopeId,session,p,epoch,source,document,byKey,visible,location,today}=env;
 if(!p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','articleNumber','locationId','supplier','dateFrom','dateTo','movementType','review','cursor']);
 const q=Object.fromEntries(['query','articleNumber','locationId','supplier','dateFrom','dateTo','movementType','review'].map(k=>[k,input[k]||'']));
 for(const key of ['query','articleNumber','supplier'])if(q[key])C.text(q[key],150);
 if(q.locationId)C.id(q.locationId);
 if(q.locationId&&!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);
 if(!['','receipt','transfer','unclear'].includes(q.movementType)||!['','issues','negative','missing_date'].includes(q.review))C.fail('IMPORT_SHAPE_INVALID');
 for(const key of ['dateFrom','dateTo'])if(q[key])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[key],dateTo:q[key]},{today:today(),projection:{read:true,company:true}});
 if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo||q.review==='missing_date'&&(q.dateFrom||q.dateTo))C.fail('IMPORT_HISTORY_DATE_RANGE');
 const state=await tx.queryOne(MOVEMENT_STATE,{scopeId,weHash:H.profileFor('trade','WE').fingerprint,orderHash:H.profileFor('trade','BESTELLUNGEN').fingerprint,basketHash:H.profileFor('trade','BESTELLKORB').fingerprint});
 if(state.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const active=await source('WE','tradefoto-weum');
 if(!active)return {available:false,rows:[],scanned:0,next:null,note:'Noch keine vollständig übernommene WEUM-Datenbank. Bitte unter Einstellungen → Datenbankimporte hochladen und übernehmen.'};
 const signature=protection.digest([q,epoch,p,session.employeeNumber,active.id]),cursorContext=['trade-movements',scopeId,String(session.employeeNumber)];
 let after='';
 if(input.cursor){let cursor;try{C.text(input.cursor,2400);cursor=protection.open(input.cursor,cursorContext);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
  if(cursor.signature!==signature||cursor.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);after=C.id(cursor.after);}
 const parameters={scopeId,after,limit:201,dateFrom:q.dateFrom||null,dateTo:q.dateTo||null,missingDate:q.review==='missing_date'};
 const records=await tx.queryAll(SQL.records,parameters),versions=await tx.queryAll(SQL.versions,parameters),segments=await tx.queryAll(SQL.segments,parameters),references=await tx.queryAll(SQL.references,parameters);
 const grouped=entries=>{const map=new Map();for(const r of entries){const key=r.recordId+':'+r.revision;if(!map.has(key))map.set(key,[]);map.get(key).push(r);}return map;};
 const prefetched={records:new Map(records.map(r=>[r.id,r])),versions:new Map(versions.map(r=>[r.recordId+':'+r.revision,r])),segments:grouped(segments),references:grouped(references)};
 const articles=createTradeArticleReader({access,tx,protection,scopeId,ownerId:String(session.employeeNumber)}),rows=[];
 async function endpoint(raw){
  if(!await visible(raw))return {label:'Nicht freigegeben',locationId:null,sourceId:null};
  const target=await location(raw);return {label:target?'Filiale '+target:raw?'Nicht zugeordnet ('+raw+')':'Nicht hinterlegt',locationId:target,sourceId:raw==null?null:String(raw)};
 }
 const positive=v=>v!=null&&Number(v)>0;
 async function orderReference(f){
  if(!positive(f.Bestellnr))return null;
  const head=await byKey('BESTELLUNGEN',[String(f.Bestellnr)]),h=head?.fields;
  if(!h||!await visible(h.LFilialID))return {number:String(f.Bestellnr),status:'unresolved',label:'Bestellkopf nicht zuordenbar'};
  const matched=!!f.Suchname&&f.Suchname===h.Suchname;
  return {number:String(f.Bestellnr),status:matched?'matched':'conflict',label:matched?'Bestellkopf gefunden · Position nicht abgeglichen':'Lieferant weicht vom Bestellkopf ab',sourceDate:head.provenance.snapshotAt};
 }
 async function basketReference(f){
  if(!positive(f.KorbId))return null;
  const basket=await byKey('BESTELLKORB',[String(f.KorbId),String(f.EAN||'')]),b=basket?.fields;
  // A related document is revealed only when both endpoints are in the reader's scope.
  if(!b||!await visible(b.Filiale)||!await visible(b.UmlagerungvonFil))return {number:String(f.KorbId),status:'unresolved',label:'Korbbezug nicht zuordenbar'};
  const matched=f.EAN===b.KEAN&&String(f.FilialID)===String(b.UmlagerungvonFil)&&String(f.Filialid2)===String(b.Filiale);
  return {number:String(f.KorbId),status:matched?'matched':'conflict',label:matched?'Artikel und Richtung stimmen überein':'Artikel oder Richtung weicht ab',sourceDate:basket.provenance.snapshotAt};
 }
 for(const record of records.slice(0,200)){
  const value=await document(record,prefetched),f=value.fields,row=interpret(f);
  if(q.movementType&&q.movementType!==row.kind||q.articleNumber&&q.articleNumber!==f.EAN||q.review==='negative'&&row.quantityState!=='negative')continue;
  const first=await visible(f.FilialID,q.locationId),second=row.kind!=='receipt'&&await visible(f.Filialid2,q.locationId);
  if(!first&&!second)continue;
  if(!Search.matches([f.Suchname],q.supplier))continue;
  const a=await articles.resolve(f.EAN,f.WEDatum);
  if(!Search.matches([f.EAN,...a.candidates.map(c=>c.label),f.We_ID,f.Bestellnr,f.KorbId,f.Lieferscheinnr,f.Rechnungsnr],q.query))continue;
  if(!['current','archived'].includes(a.status))row.issues.push('Artikelreferenz prüfen');
  const from=row.kind==='receipt'?{label:'Lieferant',sourceId:null,locationId:null}:await endpoint(f.FilialID),to=await endpoint(row.kind==='receipt'?f.FilialID:f.Filialid2);
  if(from.label.startsWith('Nicht zugeordnet')||to.label.startsWith('Nicht zugeordnet')||to.label==='Nicht hinterlegt')row.issues.push('Filialzuordnung prüfen');
  const order=await orderReference(f),basket=await basketReference(f);
  if(order&&order.status!=='matched')row.issues.push('Bestellbezug prüfen');
  if(basket&&basket.status!=='matched')row.issues.push('Korbbezug prüfen');
  if(q.review==='issues'&&!row.issues.length)continue;
  const refs=[order?'Best. '+order.number:null,basket?'Korb '+basket.number:null,f.Lieferscheinnr?'LS '+f.Lieferscheinnr:null,f.Rechnungsnr?'RE '+f.Rechnungsnr:null].filter(Boolean);
  rows.push({...row,id:value.id,movementNumber:f.We_ID,date:f.WEDatum||null,secondaryDate:f.AkWeDatum||null,articleNumber:f.EAN||'',label:a.label||'Artikelreferenz ungeklärt',articleReference:a,supplier:f.Suchname||'',from:from.label,to:to.label,endpoints:{from,to},
   documentRefs:refs.join(' · '),issueLabel:row.issues.join(' · ')||'Keine Auffälligkeit',references:{order,basket,delivery:f.Lieferscheinnr||null,invoice:f.Rechnungsnr||null},
   sourceFlags:{receipt:f.We,transfer:f.Umlagerung},sourceDate:value.provenance.snapshotAt,importedAt:value.provenance.importedAt,revision:record.revision,physicalReceiptConfirmed:false});
 }
 return {available:true,rows,sourceDates:[...new Set(rows.map(r=>r.sourceDate))],scanned:Math.min(200,records.length),next:records.length>200?protection.seal({signature,after:records[199].id,expires:Date.now()+900000},cursorContext):null,sourceDate:active.manifest.snapshotAt,note:NOTE};
}
module.exports={movementsPage,interpret,NOTE};
