'use strict';
const {normalizeSalesArticleNumber}=require('./sales-article-catalog');
const {buildSalesArticleCatalogProjection}=require('./sales-article-catalog-access');
const {projectionFor}=require('./tradefoto-bestell/access');
const Sales=require('./sales-article-sales-model');
const Table=require('../public/trade-table-layout'),Export=require('../public/trade-export-options'),UI=require('../public/sales-article-tools');
const C=require('./data-import-contract');
function registerSalesArticleToolsRoutes(app,{catalog,preferences,sessionFor,assertFresh,refreshSession,assertCsrf,privateHeaders,loadDetail,notes,images,loadSales,loadMovements,loadHistoryContext,today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Vienna',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}){
 const grants=session=>({sales:Sales.capabilities(session).sales,movements:projectionFor(session).purchasing,write:buildSalesArticleCatalogProjection(session).write});
 function columns(session,table){
  const p=grants(session);if(table==='article-notes')return Object.keys(UI.noteColumns);
  if(table==='article-movements'&&p.movements)return Object.keys(UI.movementColumns);
  if(table==='article-sales'&&p.sales)return Sales.availableColumns(Sales.capabilities(session));
  if(table==='article-price-labels'&&buildSalesArticleCatalogProjection(session).pricesRead)return ['title','creator','format','updated'];
  C.fail('IMPORT_FORBIDDEN',403);
 }
 const route=(handler,pdf=false)=>async(req,res,next)=>{
  try{privateHeaders(res);const session=sessionFor(req,false);if(!session||session.mustChangePassword||!buildSalesArticleCatalogProjection(session).read)C.fail('IMPORT_FORBIDDEN',403);if(req.method!=='GET')assertCsrf(req,session);
   const signature=s=>C.canonical([s.employeeNumber||'',s.accountId||null,s.permissions||[],s.scopes||[],s.sessionKind||'',s.isEmployee??null]);
   const initialSignature=signature(session);
   const fresh=async()=>{await assertFresh(req,session);const current=refreshSession?await refreshSession(req,session):session;if(!current||current.mustChangePassword||!buildSalesArticleCatalogProjection(current).read||signature(current)!==initialSignature)C.fail('IMPORT_FORBIDDEN',403);return current;};
   await fresh();const result=await handler(req,session,fresh);await fresh();
   if(pdf)res.set({'Content-Security-Policy':"default-src 'none'; sandbox allow-downloads"}).type('application/pdf').attachment(result.filename).send(result.buffer);else res.json(result);
  }catch(error){if(error?.status>=400&&error.status<600||error instanceof TypeError)res.status(error.status||400).json({code:error.code||'ARTICLE_TOOLS_INPUT',error:error.status===403?'Für diesen Bereich fehlt die persönliche Freigabe.':error.status===413?'Bitte den Zeitraum oder die Auswahl verkleinern.':error.status>=500?'Die Artikeldaten konnten nicht sicher gelesen werden.':'Die Auswahl ist ungültig oder der Datenstand hat sich geändert. Bitte erneut versuchen.'});else next(error);}
 };
 const exact=(obj,keys)=>C.exact(obj,keys);
 async function historyContext(session,fresh){
  const p=grants(session),context=loadHistoryContext&&(p.sales||p.movements)?await loadHistoryContext(session,fresh):{};
  return {...p,today:today(),sellers:Sales.capabilities(session).sellers,
   salesLocations:p.sales?context.salesLocations||[]:[],movementLocations:p.movements?context.movementLocations||[]:[]};
 }
 app.get('/api/sales/articles/tools/context',route(async(req,session,fresh)=>{exact(req.query,[]);return historyContext(session,fresh);}));
 app.get('/api/sales/articles/tools/table-options/:table',route(async(req,session)=>{
  exact(req.query,[]);const allowed=columns(session,req.params.table),stored=await preferences.get(session.employeeNumber,'article_table_v1_'+req.params.table);
  try{const saved=JSON.parse(stored?.value||'null');return Table.normalize({columns:saved.columns.filter(k=>allowed.includes(k)),widths:Object.fromEntries(Object.entries(saved.widths||{}).filter(([k])=>allowed.includes(k)))},allowed);}catch{return {columns:allowed,widths:{}};}
 }));
 app.post('/api/sales/articles/tools/table-options/:table',route(async(req,session)=>{
  exact(req.query,[]);const allowed=columns(session,req.params.table),value=Table.normalize(req.body,allowed);await preferences.upsert(session.employeeNumber,'article_table_v1_'+req.params.table,JSON.stringify(value));return value;
 }));
 app.get('/api/sales/articles/tools/pdf-options',route(async(req,session)=>{exact(req.query,[]);const stored=await preferences.get(session.employeeNumber,'article_sheet_pdf_v1');try{return Export.options(JSON.parse(stored?.value||'{}'));}catch{return {...Export.defaults};}}));
 app.post('/api/sales/articles/tools/pdf-options',route(async(req,session)=>{exact(req.query,[]);const value=Export.options(req.body);await preferences.upsert(session.employeeNumber,'article_sheet_pdf_v1',JSON.stringify(value));return value;}));
 async function history(session,kind,articleNumber,input,fresh){
  const keys=UI.historyFilterKeys(kind);exact(input,keys);
  const defaults=UI.historyDefaults(kind,today()),query={articleNumber,...Object.fromEntries(keys.map(k=>[k,Object.hasOwn(input,k)?input[k]:defaults[k]||'']))};
  for(const k of keys)if(typeof query[k]!=='string')C.fail('IMPORT_SHAPE_INVALID');
  if(kind==='sales'&&query.personnel&&!Sales.capabilities(session).sellers)C.fail('IMPORT_FORBIDDEN',403);
  const rows=[];let cursor='',result,durationMs=0;
  do{result=kind==='sales'?await loadSales(session,{...query,limit:100,sort:'date',direction:'desc',...(cursor?{cursor}:{})},fresh):await loadMovements(session,{...query,...(cursor?{cursor}:{})},fresh);
   rows.push(...result.rows);durationMs+=result.durationMs||0;cursor=result.next;
  }while(cursor&&rows.length<1000);
  rows.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.id||'').localeCompare(String(a.id||'')));
  const context=await historyContext(session,fresh),locations=kind==='sales'?context.salesLocations:context.movementLocations;
  const filterLabels=keys.filter(k=>!k.startsWith('date')&&query[k]).map(k=>({label:{locationId:'Filiale',fromLocationId:'Von Filiale',toLocationId:'Zu Filiale',personnel:'Personalnummer'}[k],value:k==='personnel'?query[k]:locations.find(l=>l.id===query[k])?.label||query[k]}));
  return {...result,rows:rows.slice(0,1000),truncated:Boolean(cursor||rows.length>1000),durationMs,...query,filterLabels};
 }
 app.post('/api/sales/articles/sheet.pdf',route(async(req,session,fresh)=>{
  exact(req.query,[]);exact(req.body,['articleNumber','sections','includeImage','name','stamp','position','separator','suffix','movements','sales']);
  const body=req.body,number=normalizeSalesArticleNumber(body.articleNumber),allowed=Object.keys(UI.sectionLabels),p=grants(session);
  if(!Array.isArray(body.sections)||!body.sections.length||new Set(body.sections).size!==body.sections.length||body.sections.some(k=>!allowed.includes(k))||typeof body.includeImage!=='boolean'||typeof body.name!=='string'||!body.name.trim()||body.name.length>110)C.fail('IMPORT_SHAPE_INVALID');
  if(body.sections.includes('sales')&&!p.sales||body.sections.includes('movements')&&!p.movements)C.fail('IMPORT_FORBIDDEN',403);
  const options=Export.options(Object.fromEntries(['stamp','position','separator','suffix'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]])));
  const article=await catalog.getByArticleNumber(number);if(!article)C.fail('IMPORT_NOT_FOUND',404);
  const detail=await loadDetail(article,session),model={...detail,localNotes:body.sections.includes('notes')?await notes.list(number):null};
  if(body.includeImage){const image=await images.content(number);model.imageBuffer=image?.buffer||null;}
  if(body.sections.includes('sales'))model.sales=await history(session,'sales',number,body.sales||{},fresh);
  if(body.sections.includes('movements'))model.movements=await history(session,'movements',number,body.movements||{},fresh);
  return {filename:Export.filename(body.name,options),buffer:await require('./sales-article-sheet-pdf').createSalesArticleSheetPdf(model,{sections:body.sections,includeImage:body.includeImage})};
 },true));
}
module.exports={registerSalesArticleToolsRoutes};
