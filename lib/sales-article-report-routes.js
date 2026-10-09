'use strict';
const Model=require('./sales-article-report-model'),Pdf=require('./sales-article-report-pdf');
const crypto=require('node:crypto');
function register(app,{preferences,vault,sessionFor,assertFresh,assertCsrf,privateHeaders,loadReport}){
 const queues=new Map();
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
  if(post||req.method==='PUT')assertCsrf(req,session);
  await assertFresh(req,session);
  const fresh=async()=>{await assertFresh(req,session);return session;};
  const value=await handler(req,session,caps,fresh);await assertFresh(req,session);
  if(value?.buffer){res.setHeader('Content-Type','application/pdf');res.setHeader('X-PDF-Pages',String(value.pages));res.setHeader('X-Report-Rows',String(value.rows));
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
 const pdf=route(async(req,session,caps,fresh)=>{const spec=Pdf.normalize(req.body,caps),report=await loadReport(fresh,'export',spec.filters);await fresh();return Pdf.render({spec,report});},{post:true});
 app.post('/api/sales/article-report/pdf-preview',pdf);app.post('/api/sales/article-report/pdf',pdf);
}
module.exports={register};
