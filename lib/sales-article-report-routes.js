'use strict';
const Model=require('./sales-article-report-model'),Pdf=require('./sales-article-report-pdf');
const crypto=require('node:crypto');
function register(app,{preferences,vault,sessionFor,assertFresh,assertCsrf,privateHeaders,loadReport,savedReports,previewCache}){
 const queues=new Map();
 const previews=savedReports?(previewCache||require('./sales-article-report-previews').createArticleReportPreviews()):null;
 let rendering=0;
 const sealContext=session=>({namespace:'sales-article-report',connectorId:session.employeeNumber,field:'preferences',purpose:'personal-ui-preference'});
 const revision=value=>crypto.createHash('sha256').update(value||'empty').digest('hex');
 async function read(session,caps){const saved=await preferences.get(session.employeeNumber,Model.KEY);let value={};
  if(saved)await vault.useSecret(saved.value,sealContext(session),bytes=>{value=JSON.parse(bytes.toString('utf8'));});
  // Permission withdrawal reduces a previously saved layout before returning it.
  const available=Model.columnsFor(caps).map(c=>c.id);
  value={...value,columns:Array.isArray(value.columns)?value.columns.filter(c=>available.includes(c)):undefined,columnWidths:Object.fromEntries(Object.entries(value.columnWidths||{}).filter(([id])=>available.includes(id))),sort:available.includes(value.sort)?value.sort:'articleNumber'};
  if(!value.columns?.length)delete value.columns;
  return {preferences:Model.normalizePreferences(value,caps),revision:revision(saved?.value)};
 }
 const route=(handler,{post=false}={})=>async(req,res,next)=>{try{
  const session=sessionFor(req,false);privateHeaders(res);const caps=Model.capabilities(session);
  if(!caps.read||!session?.employeeNumber||session.isEmployee===false||session.mustChangePassword)Model.fail('Die Artikelauswertung benötigt einen persönlichen Zugang mit Artikel- und Bestandsrechten.',403,'ARTICLE_REPORT_FORBIDDEN');
  if(post||['PUT','DELETE'].includes(req.method))assertCsrf(req,session);
  await assertFresh(req,session);
  const fresh=async()=>{await assertFresh(req,session);return session;};
  const value=await handler(req,session,caps,fresh);await assertFresh(req,session);
  if(value?.buffer){res.setHeader('Content-Type','application/pdf');res.setHeader('X-PDF-Pages',String(value.pages));res.setHeader('X-Report-Rows',String(value.rows));
   if(value.previewToken)res.setHeader('X-Report-Preview-Token',value.previewToken);
   const disposition=req.path.endsWith('/pdf-preview')?'inline':'attachment';res.setHeader('Content-Disposition',`${disposition}; filename="Artikel-Auswertung.pdf"; filename*=UTF-8''${encodeURIComponent(value.name)}`);res.send(value.buffer);
  }else res.json(value);
 }catch(error){next(error);}};
 app.get('/api/sales/article-report/context',route(async(req,session,caps,fresh)=>{Model.exact(req.query||{},[]);return loadReport(fresh,'context',{});}));
 app.get('/api/sales/article-report/query',route(async(req,session,caps,fresh)=>loadReport(fresh,'query',Model.normalizeFilters(req.query||{},caps))));
 app.get('/api/sales/article-report/preferences',route(async(req,session,caps)=>{Model.exact(req.query||{},[]);return read(session,caps);}));
 app.put('/api/sales/article-report/preferences',route(async(req,session,caps)=>{
  Model.exact(req.body,['preferences','revision']);if(typeof req.body.revision!=='string'||!/^[a-f0-9]{64}$/.test(req.body.revision))Model.fail('Bitte die gespeicherte Tabellenansicht neu laden.',409,'ARTICLE_REPORT_PREFERENCES_CHANGED');
  const next=Model.normalizePreferences(req.body.preferences,caps),key=session.employeeNumber,prior=queues.get(key)||Promise.resolve();
  const work=prior.catch(()=>{}).then(async()=>{const previous=await read(session,caps);if(previous.revision!==req.body.revision)Model.fail('Die Tabellenansicht wurde inzwischen geändert. Bitte neu laden.',409,'ARTICLE_REPORT_PREFERENCES_CHANGED');
   await assertFresh(req,session);const sealed=vault.seal(JSON.stringify(next),sealContext(session));await preferences.upsert(key,Model.KEY,sealed);return {preferences:next,revision:revision(sealed)};});
  queues.set(key,work);try{return await work;}finally{if(queues.get(key)===work)queues.delete(key);}
 }));
 const pdf=route(async(req,session,caps,fresh)=>{
  if(rendering>=2)Model.fail('Die PDF-Aufbereitung ist gerade ausgelastet. Bitte kurz erneut versuchen.',503,'ARTICLE_REPORT_PDF_BUSY');
  rendering++;try{const spec=Pdf.normalize(req.body,caps),report=await loadReport(fresh,'export',spec.filters);await fresh();const result=await Pdf.render({spec,report});await fresh();
   if(previews&&req.path.endsWith('/pdf-preview'))result.previewToken=previews.put(session,spec,report,result);return result;
  }finally{rendering--;}
 },{post:true});
 app.post('/api/sales/article-report/pdf-preview',pdf);app.post('/api/sales/article-report/pdf',pdf);
 if(savedReports){
  const base='/api/sales/article-report/reports',emptyQuery=req=>Model.exact(req.query||{},[]);
  app.get(base,route(async(req,session,caps,fresh)=>{emptyQuery(req);return savedReports.list(session,{assertFresh:fresh});}));
  app.post(base,route(async(req,session,caps,fresh)=>{
   emptyQuery(req);Model.exact(req.body,['previewToken']);const entry=previews.get(session,req.body.previewToken);
   if(entry.saved){await savedReports.get(session,entry.saved.report.id,{assertFresh:fresh});return entry.saved;}
   if(!entry.pending)entry.pending=(async()=>{
    const context=await loadReport(fresh,'context',{});await fresh();previews.get(session,req.body.previewToken);
    if(!context.available||context.sourceAt!==entry.snapshot.sourceAt)Model.fail('Der Bestandsstand wurde inzwischen geändert. Bitte die PDF-Vorschau neu erstellen.',409,'ARTICLE_REPORT_SOURCE_CHANGED');
    if(entry.snapshot.locationIds.some(id=>!context.locations?.some(location=>location.id===id)))Model.fail('Eine Filiale liegt inzwischen außerhalb deiner Freigabe.',403,'ARTICLE_REPORT_FORBIDDEN');
    entry.saved=await savedReports.create(session,entry.snapshot,{assertFresh:fresh});return entry.saved;
   })().finally(()=>{entry.pending=null;});
   return entry.pending;
  },{post:true}));
  app.get(base+'/:id',route(async(req,session,caps,fresh)=>{emptyQuery(req);return savedReports.get(session,req.params.id,{assertFresh:fresh});}));
  for(const leaf of ['pdf-preview','pdf'])app.get(base+'/:id/'+leaf,route(async(req,session,caps,fresh)=>{emptyQuery(req);return savedReports.content(session,req.params.id,{assertFresh:fresh});}));
  app.delete(base+'/:id',route(async(req,session,caps,fresh)=>{emptyQuery(req);Model.exact(req.body||{},[]);const result=await savedReports.remove(session,req.params.id,{assertFresh:fresh});previews.removeReport(session,req.params.id);return result;}));
 }
}
module.exports={register};
