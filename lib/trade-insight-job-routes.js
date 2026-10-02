'use strict';
const C=require('./data-import-contract');
const {projectionFor}=require('./tradefoto-bestell/access');
function registerTradeInsightJobRoutes(app,{jobs,requireSession,refreshSession,assertCsrf,preferences}){
 const exportOptions=require('../public/trade-export-options');
 const tableOptions=require('../public/trade-table-layout'),model=require('../public/trade-insight-results');
 function tableColumns(session,table){
  if(table==='jobs')return ['title','kind','created','status','count'];
  const kind=table==='stocktakes-detail'?'stocktakes':table==='supplier-invoice-positions'?'supplier-invoices':table;
  if(!Object.hasOwn(model.titles,kind))C.fail('IMPORT_SHAPE_INVALID');
  const p=projectionFor(session),key=['inventory','stock-summary','stocktakes','suggestions'].includes(kind)?'inventory':kind==='repairs'?'repairs':['customer-history','device-history'].includes(kind)?'customers':kind==='supplier-invoices'?'supplierInvoices':'purchasing';
  if(kind==='article-history'){if(!require('./sales-article-catalog-access').buildSalesArticleCatalogProjection(session).read)C.fail('IMPORT_FORBIDDEN',403);}else if(!p[key])C.fail('IMPORT_FORBIDDEN',403);
  if(table==='supplier-invoice-positions')return ['location','quantity',...(p.supplierInvoiceCosts?['price','netNet']:[]),'delivery','movement'];
  return model.columns(kind,kind==='supplier-invoices'?{costs:p.supplierInvoiceCosts}:p,{stocktake:table==='stocktakes-detail'}).filter(c=>kind!=='supplier-invoices'||c.key!=='priceMax').map(c=>c.key);
 }
 const route=(work,pdf=false)=>async(req,res)=>{
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  try{
   const original=requireSession(req,'sales:history:read');if(req.method!=='GET')assertCsrf(req);
   const fresh=async()=>{const session=await refreshSession(req);if(!session||session.employeeNumber!==original.employeeNumber||session.accountId!==original.accountId||!projectionFor(session).read||session.mustChangePassword)C.fail('IMPORT_FORBIDDEN',403);return session;};
   const session=await fresh(),signature=C.canonical([projectionFor(session),session.permissions||[],session.scopes||[]]),result=await work(session,req);
   const current=await fresh();if(signature!==C.canonical([projectionFor(current),current.permissions||[],current.scopes||[]]))C.fail('IMPORT_FORBIDDEN',403);
   if(pdf){res.set({'Content-Security-Policy':"default-src 'none'; sandbox allow-downloads"});res.type('application/pdf').attachment(result.filename).send(result.buffer);}else res.json(result);
  }catch(error){const status=error.status>=400&&error.status<=599?error.status:500;res.status(status).json({code:status===500?'IMPORT_REPORT_FAILED':error.code,error:status===403?'Die Berechtigung für diesen Ergebnisstand fehlt oder wurde geändert.':status===404?'Dieser Ergebnisstand ist nicht mehr vorhanden.':status===409?'Der Auftrag ist noch nicht fertig, wurde geändert oder die Ablage ist voll (höchstens 50 Ergebnisse, 3 laufende Suchen).':status===413?'Die Ergebnismenge ist zu groß. Bitte die Auswahl eingrenzen.':status===503?'Die Datenquelle ist noch nicht verfügbar.':'Der Ergebnisstand konnte nicht verarbeitet werden.'});}
 };
 const base='/api/trade-insights/jobs';
 app.get(base,route(session=>jobs.list(session)));
 app.post(base,route((session,req)=>jobs.create(session,req.body)));
 app.get('/api/trade-insights/export-options',route(async session=>{const stored=await preferences?.get(session.employeeNumber,exportOptions.preferenceKey);try{return exportOptions.options(JSON.parse(stored?.value||'{}'));}catch{return {...exportOptions.defaults};}}));
 app.post('/api/trade-insights/export-options',route(async(session,req)=>{let value;try{value=exportOptions.options(req.body);}catch{C.fail('IMPORT_SHAPE_INVALID');}if(preferences)await preferences.upsert(session.employeeNumber,exportOptions.preferenceKey,JSON.stringify(value));return value;}));
 app.get('/api/trade-insights/table-options/:table',route(async(session,req)=>{const allowed=tableColumns(session,req.params.table),stored=await preferences?.get(session.employeeNumber,'trade_table_v1_'+req.params.table);try{const saved=JSON.parse(stored?.value||'null');return tableOptions.normalize({columns:saved.columns.filter(k=>allowed.includes(k)),widths:Object.fromEntries(Object.entries(saved.widths||{}).filter(([k])=>allowed.includes(k)))},allowed);}catch{return {columns:allowed,widths:{}};}}));
 app.post('/api/trade-insights/table-options/:table',route(async(session,req)=>{const allowed=tableColumns(session,req.params.table);let value;try{value=tableOptions.normalize(req.body,allowed);}catch{C.fail('IMPORT_SHAPE_INVALID');}if(preferences)await preferences.upsert(session.employeeNumber,'trade_table_v1_'+req.params.table,JSON.stringify(value));return value;}));
 app.get(base+'/:id/pdf',route(async(session,req)=>{
  const snapshot=await jobs.get(session,req.params.id);let settings;
  try{settings=exportOptions.options(Object.fromEntries(['stamp','position','separator','suffix'].filter(k=>Object.hasOwn(req.query,k)).map(k=>[k,req.query[k]])));if(req.query.name!==undefined&&(typeof req.query.name!=='string'||req.query.name.length>110))throw Error();}catch{C.fail('IMPORT_SHAPE_INVALID');}
  return {buffer:await require('./trade-insight-pdf').createTradeInsightPdf(snapshot,{sort:req.query.sort||'',direction:req.query.direction||'asc'}),filename:exportOptions.filename(req.query.name||snapshot.title,settings)};
 },true));
 app.get(base+'/:id',route((session,req)=>jobs.get(session,req.params.id)));
 app.post(base+'/:id/rename',route((session,req)=>jobs.rename(session,req.params.id,req.body)));
 app.post(base+'/:id/cancel',route((session,req)=>jobs.cancel(session,req.params.id)));
 app.post(base+'/:id/remove',route((session,req)=>jobs.remove(session,req.params.id)));
}
module.exports={registerTradeInsightJobRoutes};
