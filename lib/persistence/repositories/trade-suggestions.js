'use strict';
const C=require('../../data-import-contract'),D=require('../../tradefoto-bestell/decimal'),H=require('../../tradefoto-history-profiles'),M=require('../../tradefoto-master-profiles');
const {historyPage}=require('./history-page'),{classification,stockCounts,cashContext,articleCash}=require('./trade-stock');
const {ARTICLE_SOURCE_STATE}=require('../statements/trade-insights'),{createTradeArticleReader}=require('./trade-article-history');
const POLICY=Object.freeze({stockMaxAgeDays:7,salesEndMaxGapDays:7,minimumPeriodDays:28,lowCoverageDays:14,donorCoverageDays:60,highCoverageDays:180,version:1});
const dayGap=(a,b)=>Math.round((Date.parse(a.slice(0,10)+'T00:00:00Z')-Date.parse(b.slice(0,10)+'T00:00:00Z'))/86400000);
const NOTE='Prüfhinweise aus gebuchtem Nettoabsatz und Bestandsständen. Keine automatische Bestellung oder Umlagerung. Reservierungen und bestätigte Mindestbestände sind nicht verlässlich je Filiale zugeordnet; deshalb wird keine frei verfügbare oder empfohlene Umlagerungsmenge berechnet. „Bestellt“ und „im Zulauf“ sind ungeprüfte Quellwerte. Kassenbeginn und -ende belegen keine lückenlose Tagesabdeckung und keinen zukünftigen Bedarf.';
const positive=v=>v!=null&&D.compare(v,'0')>0;
function assess(items,sales,{from,to,stockDate,today,confirmed,reference}){
 const age=dayGap(today,stockDate),gap=dayGap(stockDate,to),days=dayGap(to,from)+1;
 const reasons=[];
 if(age<0)reasons.push('Bestandsstand liegt in der Zukunft');else if(age>POLICY.stockMaxAgeDays)reasons.push('Bestandsstand älter als 7 Tage');
 if(gap<0||gap>POLICY.salesEndMaxGapDays)reasons.push('Verkaufsende passt nicht zum Bestandsstand (maximal 7 Tage Abstand)');
 if(days<POLICY.minimumPeriodDays)reasons.push('Beobachtung kürzer als 28 Tage');
 if(!confirmed)reasons.push('Lagerware noch nicht bestätigt');if(!reference)reasons.push('Artikelreferenz für den Zeitraum nicht eindeutig');
 if(!sales?.complete)reasons.push('Kein vollständig geprüfter Kassenstand');else{
  if(!sales.coverage)reasons.push('Zeitraum außerhalb der belegten Kassengrenzen');
  if(sales.stats.unverified||sales.stats.denied||sales.stats.unknownStock||sales.stats.ambiguousArticles)reasons.push('Kassenpositionen oder Artikel-/Filialzuordnung ungeklärt');
 }
 const mapped=items.map(r=>r.locationId).filter(Boolean);
 if(mapped.length!==items.length||new Set(mapped).size!==mapped.length||items.some(r=>r.stock===null||D.compare(r.stock,'0')<0))reasons.push('Bestandszuordnung oder Quellmenge ungeklärt');
 const evidence=items.map(r=>{const s=sales?.stats?.stock[r.locationId]||{net:'0',positive:'0'};return {...r,soldNet:sales?.complete&&sales.coverage?s.net:null,positiveSales:s.positive,coverageDays:positive(s.net)&&r.stock!=null?D.divide(D.multiply(r.stock,String(days)),s.net,2):null};});
 return {reasons,age,gap,days,evidence};
}
function recommend(item,all,assessment){
 if(assessment.reasons.length)return {type:'blocked',action:'Datengrundlage prüfen',reason:assessment.reasons.join(' · '),donors:[]};
 const low=item.stock!==null&&D.compare(item.stock,'0')===0||item.coverageDays!==null&&D.compare(item.coverageDays,String(POLICY.lowCoverageDays))<0;
 const donors=all.filter(r=>r.id!==item.id&&positive(r.stock)&&(r.positiveSales==='0'||r.coverageDays!==null&&D.compare(r.coverageDays,String(POLICY.donorCoverageDays))>0));
 if(low&&positive(item.soldNet)){
  if(positive(item.ordered)||positive(item.incoming))return {type:'incoming',action:'Zulauf abgleichen',reason:'Nettoabsatz bei knappem Bestand; die Quelle vermerkt bereits Bestellung oder Zulauf.',donors:[]};
  if(donors.length)return {type:'transfer',action:'Umlagerung prüfen',reason:'Absatz bei knappem Bestand; andere Filialen haben Bestand ohne erfassten Verkauf oder über 60 Tage rechnerische Reichweite.',donors};
  return {type:'restock',action:'Nachbeschaffung prüfen',reason:'Absatz bei knappem Bestand; keine geeignete Gegenfiliale im vorliegenden Bestandsstand.',donors:[]};
 }
 if(positive(item.stock)&&(item.positiveSales==='0'||item.coverageDays!==null&&D.compare(item.coverageDays,String(POLICY.highCoverageDays))>0))return {type:'clearance',action:'Bestandsabbau prüfen',reason:item.positiveSales==='0'?'Positiver Bestand ohne erfassten Verkauf im gewählten Zeitraum.':'Rechnerische Reichweite über 180 Tage im gewählten Zeitraum.',donors:[]};
 return null;
}
async function suggestionsPage(env,input={}){
 const {tx,scopeId,p,protection,session,epoch,source,reader,today}=env;if(!p.inventory)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','articleNumber','locationId','dateFrom','dateTo','suggestionType','cursor']);const q=Object.fromEntries(['query','articleNumber','locationId','dateFrom','dateTo','suggestionType'].map(k=>[k,input[k]||'']));
 for(const value of Object.values(q))if(value)C.text(value,150);
 if(!['','transfer','restock','clearance','incoming','blocked'].includes(q.suggestionType))C.fail('IMPORT_SHAPE_INVALID');
 if(!p.company)return {available:true,rows:[],next:null,scanned:0,note:'Filialübergreifende Hinweise benötigen die firmenweite Historienfreigabe. Es werden keine anderen Filialen angezeigt.'};
 const active=await source('ARTIKEL_FILIALEN','tradefoto-trade');if(!active)return {available:false,rows:[],next:null,scanned:0,note:'Kein übernommener Filialbestand verfügbar.'};
 const pending=await tx.queryOne(ARTICLE_SOURCE_STATE,{scopeId,currentHash:H.profileFor('trade','ARTIKEL_FILIALEN').fingerprint,archiveHash:M.profileFor('ARTIKEL_STAMM').fingerprint});if(pending.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const cash=await cashContext(env),stockDate=active.manifest.snapshotAt;
 q.dateTo||=[stockDate.slice(0,10),cash?.bounds?.dateTo||today(),today()].sort()[0];q.dateFrom||=new Date(Date.parse(q.dateTo+'T00:00:00Z')-89*86400000).toISOString().slice(0,10);
 require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q.dateFrom,dateTo:q.dateTo},{today:today(),projection:{read:true,company:true}});
 const signature=protection.digest([q,p,epoch,env.annotationEpoch,active.id,cash?.publication.row.id||null,today(),POLICY]),context=['trade-suggestions',scopeId,String(session.employeeNumber)];let cursor={after:'',pending:null};
 if(input.cursor){try{C.text(input.cursor,100000);cursor=protection.open(input.cursor,context);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}if(cursor.signature!==signature||cursor.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);}
 // Bound article references use the existing stock index. Missing or excessive
 // references keep the authenticated paged scan and remain review cases.
 const exact=q.articleNumber?await stockCounts(env,q.articleNumber,active):null;
 const prefetched=exact?null:await historyPage(tx,{scopeId,source:'trade',sourceInstance:'tradefoto-trade',sourceTable:'ARTIKEL_FILIALEN',snapshot:active.manifest.fileSha256,after:cursor.after,limit:101});
 const first=exact?[...exact.records].sort()[0]:null;
 const records=exact?(first&&first>cursor.after?[await tx.queryOne(require('../statements/import-history').IMPORT_HISTORY_STATEMENTS.get,{scopeId,id:first})]:[]):[...prefetched.records.values()],rows=[],stockCache=new Map(exact?[[q.articleNumber,exact]]:[]),articles=createTradeArticleReader({access:env.access,tx,protection,scopeId,ownerId:String(session.employeeNumber)});let last=cursor.after,visited=0,pendingCash=null,reads=0;
 for(const record of records.slice(0,100)){
  const previous=last;last=record.id;visited++;const item=await env.document(record,prefetched),f=item.fields;
  if(q.articleNumber&&String(f.EAN)!==q.articleNumber)continue;
  const article=await reader.byKey(tx,'ARTIKEL_STAMM',[String(f.EAN)],['EAN','Artikelbezeichnung','Sortiment','Sachkonto','OhneBestand']);
  if(!require('../../flexible-search').matches([f.EAN,article?.Artikelbezeichnung],q.query))continue;
  if(!stockCache.has(f.EAN))stockCache.set(f.EAN,await stockCounts(env,f.EAN,active));const counted=stockCache.get(f.EAN);
  if(counted&&record.id!==[...counted.records].sort()[0])continue;
  const items=counted?.items||[{id:record.id,sourceLocation:String(f.FilialID),stock:null,ordered:null,incoming:null}];
  for(const i of items)i.locationId=await env.location(i.sourceLocation);
  const visibleItems=[];for(const i of items)if(await env.visible(i.sourceLocation,q.locationId))visibleItems.push(i);
  if(!visibleItems.length)continue;
  const kind=article?await classification(env,article):{kind:'unknown',confirmed:false};if(kind.confirmed&&['service','account','excluded'].includes(kind.kind))continue;
  const refs=await Promise.all([articles.resolve(f.EAN,q.dateFrom),articles.resolve(f.EAN,q.dateTo)]),reference=refs.every(r=>r.status==='current')&&refs[0].candidates.find(r=>r.origin==='current')?.recordId===refs[1].candidates.find(r=>r.origin==='current')?.recordId;
  let sales=null;
  if(kind.confirmed&&kind.kind==='goods'&&reference&&cash){
   if(reads>=8){last=previous;visited--;break;}reads++;
   const saved=cursor.pending;if(saved&&saved.recordId!==record.id)C.fail('IMPORT_BESTELL_CURSOR',409);
   sales=await articleCash(env,cash,String(f.EAN),{from:q.dateFrom,to:q.dateTo,strict:true,after:saved?.after||0,stats:saved?.stats||null});
   if(!sales.complete&&sales.after){pendingCash={recordId:record.id,after:sales.after,stats:sales.stats};last=previous;visited--;break;}
   cursor.pending=null;
  }
  const assessment=assess(items,sales,{from:q.dateFrom,to:q.dateTo,stockDate,today:today(),confirmed:kind.confirmed&&kind.kind==='goods',reference});
  for(const item of assessment.evidence.filter(r=>visibleItems.some(v=>v.id===r.id))){
   const hint=recommend(item,assessment.evidence,assessment);if(!hint||q.suggestionType&&q.suggestionType!==hint.type)continue;
   rows.push({id:item.id,articleNumber:String(f.EAN),label:article?.Artikelbezeichnung||'Artikel fehlt',sourceLocation:item.sourceLocation,locationId:item.locationId,stock:item.stock,soldNet:hint.type==='blocked'?null:item.soldNet,coverageDays:hint.type==='blocked'?null:item.coverageDays,ordered:item.ordered,incoming:item.incoming,type:hint.type,action:hint.action,reason:hint.reason,
    donorLabel:hint.donors.map(d=>'Filiale '+d.sourceLocation+' · Bestand '+d.stock).join('; '),donors:hint.donors.map(d=>({sourceLocation:d.sourceLocation,locationId:d.locationId,stock:d.stock,soldNet:d.soldNet,coverageDays:d.coverageDays})),availableTransferQuantity:null,
    stockAgeDays:assessment.age,sourceDate:stockDate,dateFrom:q.dateFrom,dateTo:q.dateTo,cashBounds:cash?.bounds||null,cashSourceDate:cash?.publication.dataset.row.createdAt||null,classification:kind,articleReference:refs[1],limitations:NOTE,policy:POLICY});
  }
 }
 const more=!!pendingCash||records.length>0&&last!==records.at(-1).id;
 return {available:true,rows,scanned:exact&&visited?exact.records.size:visited,next:more?protection.seal({signature,after:last,pending:pendingCash,expires:Date.now()+900000},context):null,sourceDate:stockDate,sourceDates:[stockDate,cash?.publication.dataset.row.createdAt].filter(Boolean),dateFrom:q.dateFrom,dateTo:q.dateTo,policy:POLICY,note:`Verkaufszeitraum: ${q.dateFrom} bis ${q.dateTo}. `+NOTE};
}
module.exports={suggestionsPage,assess,recommend,POLICY,NOTE};
