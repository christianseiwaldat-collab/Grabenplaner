'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),D=require('../../tradefoto-bestell/decimal'),Search=require('../../flexible-search');
const {ARTICLE_SOURCE_STATE,STOCKTAKE_DETAILS:SQL}=require('../statements/trade-insights');
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {historyPage}=require('./history-page');
const {createTradeArticleReader}=require('./trade-article-history');
const INSTANCE='tradefoto-inventur';
const NOTE='Positionszahlen umfassen die vollständige Inventur. Gespeichert sind nur Abweichungen und Mengenprüffälle; unveränderte Einzelpositionen und leere Inventurköpfe werden nicht übernommen. Mengen verschiedener Artikel sind nicht zu einem Verlustwert addierbar. „Gebucht“ ist ein Quellkennzeichen, kein Vollständigkeitsnachweis.';
function difference(f){
 const incomplete=['AlteMenge','NeueMenge','Differenz'].some(k=>f[k]==null);
 const calculated=incomplete?null:D.subtract(f.NeueMenge,f.AlteMenge);
 const deviation=calculated===null?null:D.subtract(calculated,f.Differenz);
 const inconsistent=deviation!==null&&(D.compare(deviation,'0.00001')>0||D.compare(deviation,'-0.00001')<0);
 const state=incomplete?'incomplete':inconsistent?'inconsistent':D.compare(f.Differenz,'0')>0?'positive':D.compare(f.Differenz,'0')<0?'negative':'unchanged';
 return {oldQuantity:f.AlteMenge??null,newQuantity:f.NeueMenge??null,difference:f.Differenz??null,calculated,state,stateLabel:({incomplete:'Mengen unvollständig',inconsistent:'Mengenrechnung prüfen',positive:'Mehrbestand',negative:'Minderbestand',unchanged:'Ohne Differenz'})[state]};
}
async function stocktakesPage(env,input={}){
 const {tx,scopeId,p,protection,session,epoch,source,document,location,visible,today}=env;
 if(!p.inventory)C.fail('IMPORT_FORBIDDEN',403);
 const keys=['query','locationId','dateFrom','dateTo','stocktakeId','stocktakeVersion','stocktakeSource','difference'];C.exact(input,[...keys,'cursor']);
 const q=Object.fromEntries(keys.map(k=>[k,input[k]||'']));for(const value of Object.values(q))if(value)C.text(value,150);
 if(q.locationId){C.id(q.locationId);if(!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);}
 if(!['','positive','negative','incomplete','inconsistent'].includes(q.difference))C.fail('IMPORT_SHAPE_INVALID');
 for(const k of ['dateFrom','dateTo'])if(q[k])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[k],dateTo:q[k]},{today:today(),projection:{read:true,company:true}});
 if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo)C.fail('IMPORT_HISTORY_DATE_RANGE');
 const state=await tx.queryOne(ARTICLE_SOURCE_STATE,{scopeId,currentHash:H.profileFor('trade','Inventur').fingerprint,archiveHash:H.profileFor('trade','Inventurdetails').fingerprint});
 if(state.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const headSource=await source('Inventur',INSTANCE),detailSource=await source('Inventurdetails',INSTANCE);
 if(!headSource&&!detailSource)return {available:false,rows:[],next:null,scanned:0,note:'Noch keine vollständig übernommene Inventur-Datenbank.'};
 if(!headSource||!detailSource||headSource.manifest.fileSha256!==detailSource.manifest.fileSha256||headSource.manifest.snapshotAt!==detailSource.manifest.snapshotAt)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const snapshot=headSource.manifest.fileSha256,sourceDate=headSource.manifest.snapshotAt;
 const signature=protection.digest([q,epoch,p,session.employeeNumber,headSource.id,detailSource.id]),cursorContext=['trade-stocktakes',scopeId,String(session.employeeNumber)];let after='',inspected=0;
 if(input.cursor){let c;try{C.text(input.cursor,2400);c=protection.open(input.cursor,cursorContext);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}if(c.signature!==signature||c.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);after=C.id(c.after);inspected=C.integer(c.inspected,0,10000000);}
 async function head(record,prefetched){
  const value=await document(record,prefetched),f=value.fields;
  if(record.sourceTable!=='Inventur'||value.provenance.fileSha256!==snapshot)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
  if(!await visible(f.InventurFilialid,q.locationId))return null;
  const counts={positions:f.Positionszahl,positive:f.PositiveDifferenzen,negative:f.NegativeDifferenzen,unchanged:f.OhneDifferenz,incomplete:f.UnvollstaendigeMengen};
  const countsValid=Object.values(counts).every(n=>Number.isSafeInteger(n)&&n>=0)&&counts.positions===counts.positive+counts.negative+counts.unchanged+counts.incomplete;
  return {id:record.id,revision:record.revision,sourceHash:snapshot,number:f.InventurNummer,sourceLocation:String(f.InventurFilialid),locationId:await location(f.InventurFilialid),date:f.InventurDatum||null,...counts,countsValid,booking:f.gebucht===true?'Gebucht':f.gebucht===false?'Nicht gebucht':'Nicht hinterlegt',quality:countsValid?'Zählwerte vollständig':'Zählwerte prüfen',sourceDate};
 }
 let prefetched,records,stocktake=null;
 if(q.stocktakeId){
  C.id(q.stocktakeId);const record=await tx.queryOne(S.get,{scopeId,id:q.stocktakeId});
  if(!record||record.sourceInstance!==INSTANCE||record.sourceTable!=='Inventur')C.fail('IMPORT_HISTORY_NOT_FOUND',404);
  stocktake=await head(record);if(!stocktake)C.fail('IMPORT_HISTORY_NOT_FOUND',404);
  if(q.stocktakeVersion!==String(record.revision)||q.stocktakeSource!==snapshot)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
  const parameters={scopeId,parentId:record.id,snapshot,after,limit:201};
  const entries={};for(const name of Object.keys(SQL))entries[name]=await tx.queryAll(SQL[name],parameters);
  const grouped=rows=>{const map=new Map();for(const row of rows){const k=row.recordId+':'+row.revision;if(!map.has(k))map.set(k,[]);map.get(k).push(row);}return map;};
  records=entries.records;prefetched={records:new Map(records.map(r=>[r.id,r])),versions:new Map(entries.versions.map(r=>[r.recordId+':'+r.revision,r])),segments:grouped(entries.segments),references:grouped(entries.references)};
 }else{
  if(q.stocktakeVersion||q.stocktakeSource||q.difference)C.fail('IMPORT_SHAPE_INVALID');
  prefetched=await historyPage(tx,{scopeId,sourceInstance:INSTANCE,source:'trade',sourceTable:'Inventur',after,limit:201,snapshot});records=[...prefetched.records.values()];
 }
 const rows=[],articles=createTradeArticleReader({access:env.access,tx,protection,scopeId,ownerId:String(session.employeeNumber)});
 for(const record of records.slice(0,200)){
  if(!stocktake){const r=await head(record,prefetched);if(r&&(!q.dateFrom||r.date?.slice(0,10)>=q.dateFrom)&&(!q.dateTo||r.date?.slice(0,10)<=q.dateTo)&&Search.matches([r.number,r.sourceLocation],q.query))rows.push(r);continue;}
  if(q.dateFrom&&(!stocktake.date||stocktake.date.slice(0,10)<q.dateFrom)||q.dateTo&&(!stocktake.date||stocktake.date.slice(0,10)>q.dateTo))continue;
  const value=await document(record,prefetched),f=value.fields,v=value.provenance;
  if(v.fileSha256!==snapshot||v.parentId!==stocktake.id||v.parentRevision!==stocktake.revision||String(f.Inventurnummer)!==String(stocktake.number)||String(f.InventurFilialid)!==stocktake.sourceLocation)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
  const row=difference(f);if(q.difference&&q.difference!==row.state)continue;
  const a=await articles.resolve(f.EAN,stocktake.date);if(!Search.matches([f.EAN,...a.candidates.map(c=>c.label)],q.query))continue;
  rows.push({...row,id:record.id,articleNumber:f.EAN||'',label:a.label||'Artikelreferenz ungeklärt',articleReference:a,sourceDate});
 }
 inspected+=Math.min(200,records.length);
 if(!stocktake&&records.length<=200&&inspected!==headSource.receivedCount)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 return {available:true,rows,stocktake,scanned:Math.min(200,records.length),sourceDate,sourceDates:[sourceDate],note:NOTE,next:records.length>200?protection.seal({signature,after:records[199].id,inspected,expires:Date.now()+900000},cursorContext):null};
}
module.exports={stocktakesPage,difference,NOTE};
