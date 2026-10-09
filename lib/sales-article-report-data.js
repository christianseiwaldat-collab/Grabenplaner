'use strict';
// Reuses the authenticated TradeInsight transaction and existing stock indexes.
// No raw database handles, new source imports or per-article detail requests.
const Model=require('./sales-article-report-model');
const C=require('./data-import-contract');
const M=require('./tradefoto-master-profiles');
const MS=require('./persistence/statements/import-master-data').IMPORT_MASTER_STATEMENTS;
const HS=require('./persistence/statements/import-history').IMPORT_HISTORY_STATEMENTS;
const Statements=require('./sales-article-report-statements');
const A=require('./persistence/statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS;
const {prefetch}=require('./sales-article-reader-batch');
const PAGE=200;
const text=v=>v==null?'':String(v);
const packetTx=tx=>({queryOne:(s,p)=>tx.queryOne(s,p),queryAll:(s,p)=>tx.queryAll(s,p)});
const caches=new WeakMap();
async function locationsFor(env){
 const sources=await env.reader.list(env.tx,'FILIALEN',['FilialID','FName'],1000),result=[];
 for(const source of sources){if(source.FilialID==null||!await env.visible(source.FilialID))continue;
  const sourceId=text(source.FilialID),locationId=await env.location(sourceId);
  result.push({id:locationId||'trade-source:'+sourceId,sourceId,locationId,label:`${sourceId.replace(/^0+(?=\d)/,'')} · ${source.FName||'Filiale'}`});
 }
 return result.sort((a,b)=>a.sourceId.localeCompare(b.sourceId,'de-AT',{numeric:true}));
}
async function context(env){const caps=Model.capabilities(env.session);if(!caps.read)Model.fail('Für die Artikelauswertung fehlen Artikel- oder Bestandsrechte.',403,'ARTICLE_REPORT_FORBIDDEN');
 const locations=await locationsFor(env),active=await env.source('ARTIKEL_FILIALEN','tradefoto-trade');
 const preferences=Model.normalizePreferences({},caps);
 return {available:!!active,columns:Model.columnsFor(caps),defaultColumns:preferences.columns,sortiments:Model.SORTIMENTS,
  locations:[...new Map(locations.map(l=>[l.id,{id:l.id,label:l.label}])).values()],capabilities:caps,sourceAt:active?.manifest.snapshotAt||null};
}
async function stockPage(env,active,articles,locations,after){
 const tx=packetTx(env.tx),candidates=await env.tx.queryAll(Statements.stockCandidates,{scopeId:env.scopeId,snapshot:active.manifest.fileSha256,
  articles,locations,after,limit:PAGE+1}),ids=candidates.map(r=>({scopeId:env.scopeId,id:r.id})),versions=candidates.map(r=>({recordId:r.id,revision:r.revision}));
 const records=await prefetch(tx,HS.get,ids),v=await prefetch(tx,HS.version,versions),s=await prefetch(tx,HS.segments,versions),refs=await prefetch(tx,HS.references,versions);
 if(records.some(r=>!r))C.fail('IMPORT_HISTORY_INTEGRITY');
 return {records:new Map(records.map(r=>[r.id,r])),versions:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,v[i]])),
  segments:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,s[i]])),references:new Map(candidates.map((r,i)=>[r.id+':'+r.revision,refs[i]]))};
}
async function articleCandidates(env,caps,q){
 const cacheKey=C.canonical([env.scopeId,env.session.employeeNumber,env.p,caps,env.epoch,env.sourceRevision]);
 const cache=caches.get(env.access)||new Map();caches.set(env.access,cache);
 const cached=cache.get(cacheKey);let masters=cached&&cached.expires>Date.now()?cached.value:null;
 const fields=['EAN','Artikelbezeichnung','Sortimentsart','Abverkauf','Auslaufartikel','OhneBestand','Sachkonto',...(caps.margin?['MWST']:[]),...(caps.costs?['DurchschnittEK']:[])];
 if(!masters){masters=[];let after='';const reader=require('./persistence/repositories/sales-master-data').createSalesMasterReader({protection:env.protection,scopeId:env.scopeId});
  for(;;){const records=await env.tx.queryAll(MS.listMappings,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade',sourceTable:'ARTIKEL_STAMM',status:'all',after,limit:PAGE});
   if(masters.length+records.length>Model.MAX_SCANNED)Model.fail('Der Artikelstamm überschreitet die begrenzte Berichtsauswahl.',413,'ARTICLE_REPORT_LIMIT');
   const tx=packetTx(env.tx);await prefetch(tx,MS.segments,records.map(r=>({recordId:r.id})));
   for(const record of records){const source=await reader.projectedRecord(tx,record,fields);
    if(!source?.EAN||M.masterIdentity(env.protection,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade'},'ARTIKEL_STAMM',[source.EAN])!==record.identityHash)C.fail('IMPORT_MASTER_INTEGRITY');
    masters.push({masterId:record.id,source});}
   if(records.length<PAGE)break;after=records.at(-1).id;
  }
  if(cache.size>=4)cache.delete(cache.keys().next().value);cache.set(cacheKey,{expires:Date.now()+30000,value:C.freeze(masters)});
 }
 const selected=masters.filter(m=>Model.assortmentMatches(m.source,q.assortment)),catalog=new Map();
 // Accepted current numbers/descriptions are read before search selection. No
 // imported name can hide a later manually renamed accepted article.
 for(let offset=0;offset<selected.length;offset+=PAGE){const keys=selected.slice(offset,offset+PAGE).map(m=>text(m.source.EAN)),rows=await env.tx.queryAll(Statements.catalog,{keys,limit:PAGE});
  for(const row of rows){if(!keys.includes(row.sourceArticleKey)||catalog.has(row.sourceArticleKey))C.fail('IMPORT_MASTER_INTEGRITY');catalog.set(row.sourceArticleKey,row);}
 }
 return {scanned:masters.length,catalog,candidates:selected.filter(m=>require('./flexible-search').matches([catalog.get(text(m.source.EAN))?.articleNumber||Model.articleNumber(m.source.EAN),catalog.get(text(m.source.EAN))?.description||m.source.Artikelbezeichnung],q.query))};
}
async function stockRows(env,active,branches,candidates){
 const tx=packetTx(env.tx),requests=branches.map(branch=>({scopeId:env.scopeId,identityHash:M.masterIdentity(env.protection,{scopeId:env.scopeId,sourceInstance:'tradefoto-trade'},'FILIALEN',[branch.sourceId])}));
 const locations=[...new Set((await prefetch(tx,MS.find,requests)).filter(Boolean).map(m=>m.id))],pairs=new Map(),sources=new Map(candidates.map(m=>[text(m.source.EAN),m.source]));let scanned=0;
 if(!locations.length)return {pairs:[],scanned};
 for(let offset=0;offset<candidates.length;offset+=PAGE){const articles=candidates.slice(offset,offset+PAGE).map(m=>m.masterId);let after='';
  for(;;){const packet=await stockPage(env,active,articles,locations,after),records=[...packet.records.values()];
   scanned+=Math.min(records.length,PAGE);if(scanned>Model.MAX_SCANNED)Model.fail('Die Auswahl umfasst zu viele passende Bestandszeilen. Bitte die Auswahl eingrenzen.',413,'ARTICLE_REPORT_LIMIT');
   for(const record of records.slice(0,PAGE)){const value=await env.document(record,packet);
    if(value.provenance.fileSha256!==active.manifest.fileSha256)C.fail('IMPORT_HISTORY_INTEGRITY');const stock=value.fields,source=sources.get(text(stock.EAN)),location=branches.find(b=>b.sourceId===text(stock.FilialID));
    if(!source||!location||!await env.visible(stock.FilialID))C.fail('IMPORT_HISTORY_INTEGRITY');
    const key=C.canonical([text(stock.EAN),location.id]),previous=pairs.get(key);pairs.set(key,{key,stock,source,location,ambiguous:!!previous});
   }
   if(records.length<=PAGE)break;after=records[PAGE-1].id;
  }
  }
 return {pairs:[...pairs.values()],scanned};
}
async function query(env,input,all=false){const caps=Model.capabilities(env.session);if(!caps.read)Model.fail('Für die Artikelauswertung fehlen Artikel- oder Bestandsrechte.',403,'ARTICLE_REPORT_FORBIDDEN');
 const q=Model.normalizeFilters(input,caps),available=await locationsFor(env);
 if(q.locations.some(id=>!available.some(l=>l.id===id)))Model.fail('Eine gewählte Filiale liegt außerhalb deiner Freigabe.',403,'ARTICLE_REPORT_FORBIDDEN');
 const branches=available.filter(l=>!q.locations.length||q.locations.includes(l.id)),active=await env.source('ARTIKEL_FILIALEN','tradefoto-trade');
 if(!active)return {available:false,rows:[],total:0,hasMore:false,sourceAt:null,summary:null,note:'Noch kein vollständiger importierter Filialbestand vorhanden.'};
 if(await env.tx.queryOne(A.searchProjectionDirty,{}))C.fail('IMPORT_ARTICLE_SEARCH_NOT_CURRENT',409);
 const selection=await articleCandidates(env,caps,q),source=await stockRows(env,active,branches,selection.candidates);
 const rows=source.pairs.map(pair=>Model.projectRow({...pair,catalog:selection.catalog.get(text(pair.source.EAN))},caps));
 return Model.resultFor(rows,all?{...q,offset:0,limit:Model.MAX_ROWS}:q,active.manifest.snapshotAt,caps,{sourceRevision:env.sourceRevision,scanned:source.scanned,candidateScanned:selection.scanned});
}
async function run(env,operation,input){if(operation==='context'){Model.exact(input,[]);return context(env);}if(operation==='query'||operation==='export')return query(env,input,operation==='export');Model.fail('Unbekannte Artikelauswertung.',404);}
function emptyContext(session){const caps=Model.capabilities(session);if(!caps.read)Model.fail('Für die Artikelauswertung fehlen Artikel- oder Bestandsrechte.',403,'ARTICLE_REPORT_FORBIDDEN');return {available:false,columns:Model.columnsFor(caps),defaultColumns:Model.normalizePreferences({},caps).columns,sortiments:Model.SORTIMENTS,locations:[],capabilities:caps,sourceAt:null};}
function emptyResult(){return {available:false,rows:[],total:0,hasMore:false,sourceAt:null,summary:null,note:'Noch kein vollständiger importierter Filialbestand vorhanden.'};}
module.exports={run,context,query,stockPage,articleCandidates,stockRows,locationsFor,emptyContext,emptyResult};
