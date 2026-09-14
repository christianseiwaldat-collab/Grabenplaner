'use strict';
const C=require('../../data-import-contract'),D=require('../../tradefoto-bestell/decimal'),H=require('../../tradefoto-history-profiles');
const {annotations}=require('./trade-annotations'),{historyPage}=require('./history-page');
const {createCashPublications}=require('./cash-publications'),{createCashHistoryBackend}=require('./cash-history-backend');
const {CASH}=require('../statements/trade-insights');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../statements/cash-snapshots');
const KINDS=['goods','service','account','excluded','unknown','inherit'];
const daysBefore=(to,days)=>new Date(Date.parse(to+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
const str=v=>v===null||v===undefined?'':String(v);
async function groupDefinition(env,level,key){
 if(!['wgr','assortment','article'].includes(level))C.fail('IMPORT_BESTELL_CLASSIFICATION_INVALID');C.text(key,120);
 const table={wgr:'ARTIKEL_Warengruppen',assortment:'ARTIKEL_Sortimente',article:'ARTIKEL_STAMM'}[level];
 const fields={wgr:['Warengruppe','Bezeichnung'],assortment:['Sortiment','Warengruppe','Bezeichnung'],article:['EAN','Artikelbezeichnung','Sortiment','Sachkonto','OhneBestand']}[level];
 const data=await env.reader.byKey(env.tx,table,[key],fields);if(!data)C.fail('IMPORT_HISTORY_NOT_FOUND',404);
 return {key,level,label:data.Bezeichnung||data.Artikelbezeichnung||key,sourceHash:C.fingerprint(data)};
}
async function classification(env,article){
 const store=annotations(env),group=article.Sortiment==null?null:await env.reader.byKey(env.tx,'ARTIKEL_Sortimente',[str(article.Sortiment)],['Sortiment','Warengruppe','Bezeichnung']);
 const base={productGroup:str(article.Sortiment),merchandiseGroup:str(group?.Warengruppe)};
 if(article.Sachkonto===true||article.Sachkonto===1)return {...base,kind:'account',confirmed:true,reason:'Sachkonto'};
 if(article.OhneBestand===true||article.OhneBestand===1)return {...base,kind:'excluded',confirmed:true,reason:'Ohne Bestand'};
 for(const [level,key] of [['article',str(article.EAN)],['assortment',base.productGroup],['wgr',base.merchandiseGroup]]){
  if(!key)continue;const saved=await store.read(env.tx,'classification',[level,key]);if(!saved.value||saved.value.kind==='inherit')continue;
  const def=await groupDefinition(env,level,key);if(saved.value.sourceHash!==def.sourceHash)return {...base,kind:'unknown',confirmed:false,reason:'Quellzuordnung geändert'};
  return {...base,kind:saved.value.kind,confirmed:saved.value.kind!=='unknown',reason:{article:'Artikel-Ausnahme',assortment:'Sortimentsvorgabe',wgr:'WGR-Vorgabe'}[level]};
 }
 return {...base,kind:'unknown',confirmed:false,reason:'Klassifikation noch nicht bestätigt'};
}
async function cashContext(env){
 const publications=createCashPublications(env),publication=await publications.active(env.tx);if(!publication)return null;
 const bounds=await env.tx.queryOne(CASH.bounds,{datasetSlot:publication.dataset.row.slot});return {publications,publication,bounds,backend:(env.cashBackendFactory||createCashHistoryBackend)({...env,publications,publication})};
}
function cashKeys(publications,table,value){
 const source=str(value),numeric=/^\d+$/.test(source),base=numeric?source.replace(/^0+(?=\d)/,''):source;
 return Object.fromEntries(Array.from({length:14},(_,i)=>['key'+(i+1),publications.referenceKey(table,i===0?source:numeric?base.padStart(i,'0'):source)]));
}
async function articleCash(env,cash,articleNumber,{from,to,after=0,stats=null,limit=201}={}){
 if(!cash)return {complete:false,stats:null,reason:'Kein freigegebener Kassenstand'};
 const {publication:pub,publications,backend}=cash,table=TABLES.find(t=>t.name==='Umsatz_Kasse_Details');
 const keys=cashKeys(publications,'ARTIKEL_STAMM',articleNumber);
 const sourceRows=await env.tx.queryAll(CASH.article,{datasetSlot:pub.dataset.row.slot,...keys,dateFrom:from,dateTo:to,after,limit});
 const state=stats||{prices:{},stock:{},unverified:0,denied:0,unknownStock:0,processed:0};
 const allowed=ref=>ref?.targetId&&['linked','historical_mapping'].includes(ref.status)?env.p.company||env.p.locationIds.includes(ref.targetId):env.p.company&&env.p.unassigned;
 const read=backend.service(env.tx,v=>v.action==='history.scope'?allowed(v.locations.find(l=>l.role==='location.filialid')):
  v.action==='history.reference'?v.targetKind!=='crm_customer'&&v.targetKind!=='employee':v.dataClasses.every(k=>['internal_business','customer_restricted'].includes(k)||k==='catalog_costs'&&env.p.costs));
 const heads=new Map();
 if(read.prefetch){const headTable=TABLES.find(t=>t.name==='Umsatz_KASSE'),ids=[...new Set(sourceRows.slice(0,limit-1).map(r=>'c'+TABLES.indexOf(headTable)+'-'+pub.row.id+'-'+String(r.parentRow).padStart(10,'0')))];for(let i=0;i<ids.length;i+=20)await read.prefetch(ids.slice(i,i+20));}
 for(const row of sourceRows.slice(0,limit-1)){
  const raw=pub.reader.decode(pub.dataset,table,row).normalized.source;state.processed++;
  const ref=await publications.reference(env.tx,pub.row.id,'FILIALEN',raw.Filialid);
  if(!allowed(ref)||require('../../sales-report-locations').isOnlineSource(raw.Filialid)&&!env.p.online){state.denied++;continue;}
  const id='c'+TABLES.indexOf(table)+'-'+pub.row.id+'-'+String(row.sourceRow).padStart(10,'0');
  const detail=await read.detail(id),f=detail.fields,parent=detail.provenance.parentId;
  if(!heads.has(parent))heads.set(parent,await read.receipt(parent));const checked=heads.get(parent);
  if(!checked.canAggregate){state.unverified++;continue;}const metric=checked.positions.find(p=>p.key===f.RepID);
  if(!metric||!['sale','return'].includes(metric.status))continue;
  const stockKey=str(f.Bestandsfilialid).replace(/^0+(?=\d)/,'');if(!stockKey)state.unknownStock++;else{
   const s=state.stock[stockKey]||={net:'0',positive:'0',lastSale:null};s.net=D.add(s.net,f.VKMenge);
   if(D.compare(f.VKMenge,'0')>0){s.positive=D.add(s.positive,f.VKMenge);s.lastSale=!s.lastSale||detail.provenance.businessDate>s.lastSale?detail.provenance.businessDate:s.lastSale;}
  }
  if(metric.status!=='sale'||D.compare(f.VKMenge,'0')<=0)continue;
  const key=C.canonical([str(raw.Filialid),str(f.MWST)]),g=state.prices[key]||={branch:str(raw.Filialid),locationId:ref.targetId||null,vat:str(f.MWST),quantity:'0',extended:'0',min:null,max:null,positions:0};
  g.quantity=D.add(g.quantity,f.VKMenge);g.extended=D.add(g.extended,D.multiply(f.VK_Preis,f.VKMenge));g.positions++;
  if(g.min===null||D.compare(f.VK_Preis,g.min)<0)g.min=f.VK_Preis;if(g.max===null||D.compare(f.VK_Preis,g.max)>0)g.max=f.VK_Preis;
 }
 const more=sourceRows.length>=limit;
 return {complete:!more,after:more?sourceRows[limit-2].sourceRow:0,stats:state,coverage:!!cash.bounds.dateFrom&&from>=cash.bounds.dateFrom&&to<=cash.bounds.dateTo};
}
function inventoryMetrics(stock,kind,sales,{from,to,branch,company}){
 const unavailable=!kind.confirmed||kind.kind!=='goods'?'Keine bestätigte Lagerware':stock===null||D.compare(stock,'0')<=0?'Kein positiver Bestand':!sales?.complete?'Verkaufsprüfung noch unvollständig':!sales.coverage?'Zeitraum außerhalb des belegten Kassenstands':!company||sales.stats.denied?'Nicht alle Verkaufsfilialen freigegeben':sales.stats.unverified?'Ungeklärte Kassenpositionen':sales.stats.unknownStock?'Bestandsfiliale in Kassenpositionen fehlt':null;
 if(unavailable)return {eligible:false,reason:unavailable,noRecordedSale:null,coverageDays:null};
 const s=sales.stats.stock[str(branch).replace(/^0+(?=\d)/,'')]||{net:'0',positive:'0',lastSale:null},days=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
 return {eligible:true,reason:'Geprüfter Kassenstand',noRecordedSale:D.compare(s.positive,'0')===0,coverageDays:D.compare(s.net,'0')>0?D.divide(D.multiply(stock,String(days)),s.net,2):null,soldNet:s.net,lastSale:s.lastSale};
}
async function stockCounts(env,article,active){
 const M=require('../../tradefoto-master-profiles'),S=require('../statements/import-master-data').IMPORT_MASTER_STATEMENTS;
 const master=await env.tx.queryOne(S.find,{scopeId:env.scopeId,identityHash:M.masterIdentity(env.protection,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade'},'ARTIKEL_STAMM',[str(article)])});
 if(!master)return null;
 const ids=await env.tx.queryAll(require('../statements/branch-article-stock').articleStock,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade',snapshot:active.manifest.fileSha256,articleHash:env.protection.digest(['unbound-stock']),masterRecordId:master.id,limit:101});
 if(ids.length>100)return null;const counts=new Map(),records=new Set();
 for(const entry of ids){
  const record=await env.tx.queryOne(require('../statements/import-history').IMPORT_HISTORY_STATEMENTS.get,{scopeId:env.scopeId,id:entry.id});const value=await env.document(record),f=value.fields;
  if(str(f.EAN)!==str(article)||value.provenance.fileSha256!==active.manifest.fileSha256)C.fail('IMPORT_HISTORY_INTEGRITY');
  const branch=str(f.FilialID).replace(/^0+(?=\d)/,'');counts.set(branch,(counts.get(branch)||0)+1);records.add(entry.id);
 }
 return {counts,records};
}
async function stockOperation(env,operation,input){
 const {p,tx,protection,scopeId,session}=env;if(!p.inventory)C.fail('IMPORT_FORBIDDEN',403);
 if(operation.startsWith('classification')){
  C.exact(input,['level','key','kind','expectedRevision']);if(!p.classify)C.fail('IMPORT_FORBIDDEN',403);
  const def=await groupDefinition(env,input.level,input.key),store=annotations(env),key=[def.level,def.key];
  if(operation==='classification')return {...def,...await store.read(tx,'classification',key),kinds:KINDS};
  if(!KINDS.includes(input.kind))C.fail('IMPORT_BESTELL_CLASSIFICATION_INVALID');
  await env.fresh(tx);const result=await store.write(tx,'classification',key,{kind:input.kind,sourceHash:def.sourceHash},input.expectedRevision,String(session.employeeNumber));await env.fresh(tx);return {...def,...result};
 }
 if(operation==='stock-metadata'){
  const groups=await env.reader.dictionary(tx,'ARTIKEL_Sortimente',['Sortiment','Bezeichnung','Warengruppe']);
  const wgr=await env.reader.dictionary(tx,'ARTIKEL_Warengruppen',['Warengruppe','Bezeichnung']);const cash=await cashContext(env);
  return {groups:groups.map(g=>({id:str(g.Sortiment),label:g.Bezeichnung})),wgr:wgr.map(g=>({id:str(g.Warengruppe),label:g.Bezeichnung})),cashPeriod:cash?.bounds||null};
 }
 C.exact(input,['query','locationId','dateFrom','dateTo','days','group','wgr','cursor']);
 const q={query:input.query||'',locationId:input.locationId||'',days:Number(input.days||180),group:input.group||'',wgr:input.wgr||'',dateTo:input.dateTo||env.today()};
 if(![90,180,365].includes(q.days))C.fail('IMPORT_HISTORY_DATE_RANGE');q.dateFrom=input.dateFrom||daysBefore(q.dateTo,q.days);
 const normalized=require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q.dateFrom,dateTo:q.dateTo},{today:env.today(),projection:{read:true,company:true}});q.dateFrom=normalized.dateFrom;q.dateTo=normalized.dateTo;
 for(const key of ['query','group','wgr','locationId'])if(q[key])C.text(q[key],120);
 if(q.locationId&&!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);
 const active=await env.source('ARTIKEL_FILIALEN','tradefoto-trade'),cash=await cashContext(env),cashId=cash?.publication.row.id||null;
 const signature=protection.digest([p,env.epoch,env.annotationEpoch,operation,q,active?.id||null,cashId]);const cursorContext=['trade-stock-cursor',scopeId,String(session.employeeNumber)];
 let token=null;if(input.cursor){C.text(input.cursor,100000);try{token=protection.open(input.cursor,cursorContext);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}if(token.signature!==signature||token.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);}
 if(operation==='prices'){
  if(!q.query||!/^[\p{L}\p{N}._/-]+$/u.test(q.query))C.fail('IMPORT_BESTELL_ARTICLE_REQUIRED');
  const sales=await articleCash(env,cash,q.query,{from:q.dateFrom,to:q.dateTo,after:token?.after||0,stats:token?.stats||null});
  const next=!sales.complete&&sales.after?protection.seal({signature,after:sales.after,stats:sales.stats,expires:Date.now()+900000},cursorContext):null;
  return {available:!!cash,rows:sales.complete?Object.values(sales.stats.prices).filter(r=>!q.locationId||r.locationId===q.locationId).map(r=>({...r,articleNumber:q.query,average:D.divide(r.extended,r.quantity,4)})):[],next,scanned:sales.stats?.processed||0,cumulative:true,
   sourceDate:cash?.publication.dataset.row.createdAt,note:`Gebuchte Artikelpreise vor separaten Rabattpositionen. ${sales.stats?.unverified||0} ungeklärte Positionen ausgeschlossen.${sales.coverage?'':' Zeitraum nicht vollständig durch den vorliegenden Kassenstand abgedeckt.'}`};
 }
 if(!active)return {available:false,rows:[],next:null};
 const prefetched=await historyPage(tx,{scopeId,source:'trade',sourceInstance:'tradefoto-trade',sourceTable:'ARTIKEL_FILIALEN',snapshot:active.manifest.fileSha256,after:token?.after||'',limit:11});
 const records=[...prefetched.records.values()],rows=[],cashCache=new Map(),stockCache=new Map();
 let last=token?.after||'',pendingCash=null,cashRead=false,visited=0;
 for(const record of records.slice(0,10)){
  const previous=last;last=record.id;visited++;
  const item=await env.document(record,prefetched),s=item.fields;if(!await env.visible(s.FilialID,q.locationId))continue;
  const a=await env.reader.byKey(tx,'ARTIKEL_STAMM',[str(s.EAN)],['EAN','Artikelbezeichnung','Sortiment','Sachkonto','OhneBestand',...(p.costs?['DurchschnittEK']:[])]);if(!a)continue;
  if(!require('../../flexible-search').matches([a.EAN,a.Artikelbezeichnung],q.query))continue;
  const kind=await classification(env,a);if(q.group&&kind.productGroup!==q.group||q.wgr&&kind.merchandiseGroup!==q.wgr)continue;
  if(kind.confirmed&&kind.kind==='goods'&&s.FBestand!=null&&D.compare(s.FBestand,'0')>0&&!cashCache.has(a.EAN)){
   if(cashRead){last=previous;visited--;break;}
   const saved=token?.pendingCash;
   if(saved&&saved.recordId!==record.id)C.fail('IMPORT_BESTELL_CURSOR',409);
   const sales=await articleCash(env,cash,str(a.EAN),{from:q.dateFrom,to:q.dateTo,after:saved?.after||0,stats:saved?.stats||null});cashRead=true;
   if(!sales.complete&&sales.after){pendingCash={recordId:record.id,after:sales.after,stats:sales.stats};last=previous;visited--;break;}
   cashCache.set(a.EAN,sales);
  }
  if(!stockCache.has(a.EAN))stockCache.set(a.EAN,await stockCounts(env,a.EAN,active));
  const counted=stockCache.get(a.EAN),stockConfirmed=counted?.records.has(item.id)&&counted.counts.get(str(s.FilialID).replace(/^0+(?=\d)/,''))===1,stock=stockConfirmed?s.FBestand??null:null;
  const metrics=inventoryMetrics(stock,kind,cashCache.get(a.EAN),{from:q.dateFrom,to:q.dateTo,branch:str(s.FilialID),company:p.company});
  rows.push({id:item.id,articleNumber:a.EAN,label:a.Artikelbezeichnung,sourceLocation:str(s.FilialID),stock,classification:kind,...metrics,...(!stockConfirmed?{reason:'Mehrdeutige oder unvollständige Bestandszuordnung'}:{}),
   ...(p.costs?{purchaseNet:a.DurchschnittEK??null,stockValue:kind.confirmed&&kind.kind==='goods'&&stock!=null&&a.DurchschnittEK!=null?D.multiply(stock,a.DurchschnittEK):null}:{}),sourceDate:item.provenance.snapshotAt});
 }
 const next=pendingCash||records.length&&last!==records.at(-1).id?protection.seal({signature,after:last,pendingCash,expires:Date.now()+900000},cursorContext):null;
 return {available:true,rows,next,scanned:visited,sourceDate:active.manifest.snapshotAt,note:`${q.dateFrom} bis ${q.dateTo}: Reichweite aus positivem Bestand und Nettoabsatz. „Ohne Verkauf“ beschreibt diesen Zeitraum, kein tatsächliches Lageralter.${pendingCash?' Weitere Verkäufe dieses Artikels werden geprüft.':''}`};
}
module.exports={stockOperation,cashKeys,classification,groupDefinition,articleCash,cashContext,inventoryMetrics};
