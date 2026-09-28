'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles');
const D=require('../../tradefoto-bestell/decimal'),Search=require('../../flexible-search');
const {INVOICE_LINES,INVOICE_DATA,ARTICLE_SOURCE_STATE}=require('../statements/trade-insights');
const {SALES_ARTICLE_CATALOG_STATEMENTS:A}=require('../statements/sales-article-catalog');

const INSTANCE='tradefoto-lieferantenrechnungen',HEAD='Rechnung_A',LINE='Rechnungsdetails_A';
const day=v=>v?String(v).slice(0,10):null;
async function supplierInvoices(env,input){
 const {tx,scopeId,p,source,protection,document,byKey,reader,today}=env;
 if(!p.supplierInvoices)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','articleNumber','dateFrom','dateTo','dateField']);
 const q={query:input.query||'',articleNumber:input.articleNumber||'',dateFrom:input.dateFrom||'',dateTo:input.dateTo||'',dateField:input.dateField||'booked'};
 for(const name of ['query','articleNumber'])if(q[name])C.text(q[name],150);
 if(!['created','booked'].includes(q.dateField))C.fail('IMPORT_SHAPE_INVALID');
 for(const k of ['dateFrom','dateTo'])if(q[k])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[k],dateTo:q[k]},{today:today(),projection:{read:true,company:true}});
 if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo)C.fail('IMPORT_HISTORY_DATE_RANGE');
 const state=await tx.queryOne(ARTICLE_SOURCE_STATE,{scopeId,currentHash:H.profileFor('trade',HEAD).fingerprint,archiveHash:H.profileFor('trade',LINE).fingerprint});
 if(state.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const head=await source(HEAD,INSTANCE),line=await source(LINE,INSTANCE);
 const empty={available:false,articles:[],article:null,rows:[],costs:p.supplierInvoiceCosts};
 if(!head||!line)return empty;
 if(head.manifest.fileSha256!==line.manifest.fileSha256||head.manifest.snapshotAt!==line.manifest.snapshotAt)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const result={...empty,available:true,sourceDate:head.manifest.snapshotAt};
 const records=(number,limit)=>tx.queryAll(INVOICE_LINES,{scopeId,lookupHash:protection.digest(['supplier-invoice-article',scopeId,number]),snapshot:line.manifest.fileSha256,limit});
 if(!q.articleNumber){
  if(!q.query.trim())return result;
  if(await tx.queryOne(A.searchProjectionDirty,{}))C.fail('IMPORT_ARTICLE_SEARCH_NOT_CURRENT',409);
  // Reuse the indexed GP article catalog. No decrypt-and-scan of the invoice archive.
  const found=await tx.queryAll(A.search,{...Search.parameters(q.query),identifierLike:'%',active:null,sourceSystem:null,sort:'articleNumber',direction:'asc',limit:31,offset:0});
  const articles=found.slice(0,30).map(a=>({number:a.articleNumber,label:a.description}));
  const exact=await records(q.query.trim(),1);
  if(exact.length){const d=await document(exact[0]);if(d.fields.EAN!==q.query.trim())C.fail('IMPORT_HISTORY_INTEGRITY');
   const number=d.fields.EAN;const i=articles.findIndex(a=>a.number===number);if(i>=0)articles.splice(i,1);
   articles.unshift({number,label:d.fields.Artikelbezeichnung||'Bezeichnung nicht hinterlegt'});
  }
  return {...result,articles:articles.slice(0,30),more:found.length>30};
 }
 const selected=await records(q.articleNumber,10001);
 if(selected.length>10000)C.fail('IMPORT_REPORT_DATA_LIMIT',413);
 const prefetched={records:new Map(selected.map(r=>[r.id,r]))};
 for(const [name,statement] of Object.entries(INVOICE_DATA)){
  const rows=await tx.queryAll(statement,{scopeId,lookupHash:protection.digest(['supplier-invoice-article',scopeId,q.articleNumber]),snapshot:line.manifest.fileSha256,limit:10001}),map=new Map();
  for(const r of rows){const k=r.recordId+':'+r.revision;if(name==='versions')map.set(k,r);else{if(!map.has(k))map.set(k,[]);map.get(k).push(r);}}
  prefetched[name]=map;
 }
 const groups=new Map();let fallback='';
 for(const r of selected){
  const d=await document(r,prefetched),f=d.fields,h=await byKey(HEAD,[f.Rechnungsnr,f.Suchname],INSTANCE);
  if(f.EAN!==q.articleNumber||!h||d.provenance.parentId!==h.id||d.provenance.parentRevision!==h.revision||d.provenance.fileSha256!==head.manifest.fileSha256||h.provenance.fileSha256!==head.manifest.fileSha256)C.fail('IMPORT_HISTORY_INTEGRITY');
  fallback||=f.Artikelbezeichnung||'';
  const date=day(h.fields[q.dateField==='created'?'Anlegedatum':'Buchdatum']);
  if(q.dateFrom&&(!date||date<q.dateFrom)||q.dateTo&&(!date||date>q.dateTo))continue;
  let row=groups.get(h.id);
  if(!row){row={id:h.id,number:h.fields.Rechnungsnr,supplier:h.fields.BFirma||h.fields.Suchname,supplierCode:h.fields.Suchname,created:day(h.fields.Anlegedatum),booked:day(h.fields.Buchdatum),quantity:'0',quantityMissing:false,negative:false,positions:[]};groups.set(h.id,row);}
  if(f.menge==null)row.quantityMissing=true;else{row.quantity=D.add(row.quantity,f.menge);if(D.compare(f.menge,'0')<0)row.negative=true;}
  row.positions.push({id:f.ID,movement:f.we_id,quantity:f.menge,delivery:f.WELieferscheinnr,location:f.Filialid,...(p.supplierInvoiceCosts?{price:f.Rechnungspreis,netNet:f.NNPreis}:{})});
 }
 for(const row of groups.values()){
  if(row.quantityMissing)row.quantity=null;
  if(p.supplierInvoiceCosts){const prices=row.positions.map(v=>v.price).filter(v=>v!=null).sort(D.compare);row.priceMin=prices[0]??null;row.priceMax=prices.at(-1)??null;row.priceMissing=row.positions.some(v=>v.price==null);}
 }
 const masterState=await require('./trade-article-history').createTradeArticleReader({access:env.access,tx,protection,scopeId,ownerId:String(env.session.employeeNumber)}).state();
 if(masterState.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 const m=await reader.byKey(tx,'ARTIKEL_STAMM',[q.articleNumber],['EAN','Artikelbezeichnung','Verkaufspreis',...(p.supplierInvoiceCosts?['DurchschnittEK']:[])]);
 const article=m||selected.length?{number:q.articleNumber,label:m?.Artikelbezeichnung||fallback||'Bezeichnung nicht hinterlegt',current:!!m,saleGross:m?.Verkaufspreis??null,...(p.supplierInvoiceCosts?{averageNet:m?.DurchschnittEK??null}:{})}:null;
 return {...result,article,rows:[...groups.values()].sort((a,b)=>(b.booked||'').localeCompare(a.booked||'')||(b.created||'').localeCompare(a.created||'')||a.id.localeCompare(b.id))};
}
module.exports={supplierInvoices,INSTANCE};
