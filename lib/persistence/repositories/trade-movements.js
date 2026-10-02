'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),Search=require('../../flexible-search');
const {MOVEMENTS:SQL,MOVEMENT_STATE,MOVEMENT_ARTICLE}=require('../statements/trade-insights');
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
async function articleKeys(env,number){
 const M=require('../../tradefoto-master-profiles'),S=require('../statements/import-master-data').IMPORT_MASTER_STATEMENTS;
 const identity=await require('../../sales-article-sales-identity').resolveArticleSalesIdentity(env.tx,number),keys=identity.sourceKeys;
 const catalog=identity.productId?await env.tx.queryOne(require('../statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS.getArticleByProductId,{productId:identity.productId}):null;
 const records=await require('../../sales-article-reader-batch').prefetch(env.tx,S.find,keys.map(key=>({scopeId:env.scopeId,identityHash:M.masterIdentity(env.protection,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade'},'ARTIKEL_STAMM',[key])})));
 return {keys,masters:records.filter(Boolean).map(record=>record.id),identity,catalog};
}
async function articleMovementsPage(env,input){
 if(!env.p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['articleNumber','locationId','fromLocationId','toLocationId','dateFrom','dateTo','cursor']);
 const number=C.text(input.articleNumber,120),selection=await articleKeys(env,number);
 const result=await movementsPage(env,{...input,movementType:'transfer'},{article:true,...selection});
 return {...result,articleIdentity:selection.identity.basis,rows:result.rows.map(row=>({...row,sourceArticleNumber:row.articleNumber,
  ...(selection.catalog?{articleNumber:selection.catalog.articleNumber,label:selection.catalog.description,labelSource:'catalog_current',sourceLabel:row.label}
    :selection.identity.basis==='catalog_source_link'?{articleNumber:selection.identity.articleNumber}:{})}))};
}
async function movementsPage(env,input,options={}){
 const {access,tx,protection,scopeId,session,p,epoch,source,document,byKey,visible,location,today}=env;
 if(!p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','articleNumber','locationId','fromLocationId','toLocationId','supplier','dateFrom','dateTo','movementType','review','cursor']);
 const q=Object.fromEntries(['query','articleNumber','locationId','fromLocationId','toLocationId','supplier','dateFrom','dateTo','movementType','review'].map(k=>[k,input[k]||'']));
 for(const key of ['query','articleNumber','supplier'])if(q[key])C.text(q[key],150);
 for(const key of ['locationId','fromLocationId','toLocationId'])if(q[key]){
  C.id(q[key]);
  if(!p.company&&!p.locationIds.includes(q[key])||q[key].startsWith('trade-source:')&&!(p.company&&p.unassigned))C.fail('IMPORT_FORBIDDEN',403);
 }
 if(!['','receipt','transfer','unclear'].includes(q.movementType)||!['','issues','negative','missing_date'].includes(q.review))C.fail('IMPORT_SHAPE_INVALID');
 for(const key of ['dateFrom','dateTo'])if(q[key])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[key],dateTo:q[key]},{today:today(),projection:{read:true,company:true}});
 if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo||q.review==='missing_date'&&(q.dateFrom||q.dateTo))C.fail('IMPORT_HISTORY_DATE_RANGE');
 const state=await tx.queryOne(MOVEMENT_STATE,{scopeId,weHash:H.profileFor('trade','WE').fingerprint,orderHash:H.profileFor('trade','BESTELLUNGEN').fingerprint,basketHash:H.profileFor('trade','BESTELLKORB').fingerprint});
 if(state.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const active=await source('WE','tradefoto-weum');
 if(!active)return {available:false,rows:[],scanned:0,next:null,note:'Noch keine vollständig übernommene WEUM-Datenbank. Bitte unter Einstellungen → Datenbankimporte hochladen und übernehmen.'};
 const signature=protection.digest([q,epoch,env.sourceRevision||null,p,session.employeeNumber,active.id,!!options.article,options.keys||null,options.catalog?.currentRevision||null]),cursorContext=['trade-movements',scopeId,String(session.employeeNumber)];
 let after='',afterDate='9999-12-31',afterId='~';
 if(input.cursor){let cursor;try{C.text(input.cursor,2400);cursor=protection.open(input.cursor,cursorContext);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
  if(cursor.signature!==signature||cursor.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);
  if(options.article){afterId=C.id(cursor.afterId);afterDate=cursor.afterDate;require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:afterDate,dateTo:afterDate},{today:today(),projection:{read:true,company:true}});}else after=C.id(cursor.after);}
 const parameters=options.article?{scopeId,afterDate,afterId,limit:201,dateFrom:q.dateFrom||null,dateTo:q.dateTo||null,...Object.fromEntries(Array.from({length:14},(_,i)=>['master'+(i+1),options.masters[i]||'']))}:{scopeId,after,limit:201,dateFrom:q.dateFrom||null,dateTo:q.dateTo||null,missingDate:q.review==='missing_date'};
 const statements=options.article?MOVEMENT_ARTICLE:SQL;
 const records=await tx.queryAll(statements.records,parameters),versions=await tx.queryAll(statements.versions,parameters),segments=await tx.queryAll(statements.segments,parameters),references=await tx.queryAll(statements.references,parameters);
 const grouped=entries=>{const map=new Map();for(const r of entries){const key=r.recordId+':'+r.revision;if(!map.has(key))map.set(key,[]);map.get(key).push(r);}return map;};
 const prefetched={records:new Map(records.map(r=>[r.id,r])),versions:new Map(versions.map(r=>[r.recordId+':'+r.revision,r])),segments:grouped(segments),references:grouped(references)};
 const articles=createTradeArticleReader({access,tx,protection,scopeId,ownerId:String(session.employeeNumber)}),rows=[];
 async function endpoint(raw){
  if(!await visible(raw))return {label:'Nicht freigegeben',locationId:null,sourceId:null};
  const target=await location(raw);return {label:target?'Filiale '+target:raw!==null&&raw!==undefined&&raw!==''?'Nicht zugeordnet ('+raw+')':'Nicht hinterlegt',locationId:target,sourceId:raw==null?null:String(raw)};
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
 const candidates=[],diagnostics={periodCandidates:Math.min(200,records.length),articleMatches:0,typeMatches:0,locationMatches:0};
 for(const record of records.slice(0,200)){
  const value=await document(record,prefetched),f=value.fields,row=interpret(f);
  if(q.articleNumber&&!(options.article?options.keys.includes(f.EAN):q.articleNumber===f.EAN))continue;
  diagnostics.articleMatches++;
  if(q.movementType&&q.movementType!==row.kind||q.review==='negative'&&row.quantityState!=='negative')continue;
  diagnostics.typeMatches++;
  const first=await visible(f.FilialID,q.locationId),second=row.kind!=='receipt'&&await visible(f.Filialid2,q.locationId);
  if(!first&&!second)continue;
  if(q.fromLocationId&&(row.kind==='receipt'||!await visible(f.FilialID,q.fromLocationId))||q.toLocationId&&!await visible(row.kind==='receipt'?f.FilialID:f.Filialid2,q.toLocationId))continue;
  diagnostics.locationMatches++;
  if(!Search.matches([f.Suchname],q.supplier))continue;
  candidates.push({record,value,f,row});
 }
 await articles.prefetch(candidates.map(({f})=>f.EAN));
 const related=[];
 for(const {f} of candidates){
  if(positive(f.Bestellnr))related.push({table:'BESTELLUNGEN',key:[String(f.Bestellnr)]});
  if(positive(f.KorbId))related.push({table:'BESTELLKORB',key:[String(f.KorbId),String(f.EAN||'')]});
 }
 await env.prefetchByKeys(related);
 for(const {record,value,f,row} of candidates){
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
 const last=records[199],next=records.length>200?protection.seal({signature,...(options.article?{afterId:last.id,afterDate:prefetched.versions.get(last.id+':'+last.revision).businessDate||'0001-01-01'}:{after:last.id}),expires:Date.now()+900000},cursorContext):null;
 return {available:true,rows,sourceDates:[...new Set(rows.map(r=>r.sourceDate))],scanned:Math.min(200,records.length),next,sourceDate:active.manifest.snapshotAt,diagnostics,order:options.article?'date-desc':undefined,note:options.article?'Umlagerungsbuchungen zum exakten Artikel; die neuesten Buchungen zuerst. '+NOTE:NOTE};
}
module.exports={movementsPage,articleMovementsPage,interpret,NOTE};
