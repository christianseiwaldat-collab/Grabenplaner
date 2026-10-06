'use strict';
const {normalizeSalesArticleNumber} = require('./sales-article-catalog');
const {articleTablePreferences,PRICE_SEARCH_FIELDS} = require('./sales-article-table');
const {decimal} = require('./branch-article-basis');
const KEY = 'sales_recent_articles_v1';
const empty = () => ({version:1, articleNumbers:[], table:{}});
function normalize(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key=>!['version','articleNumbers','table'].includes(key))
    || !Array.isArray(value.articleNumbers) || value.articleNumbers.length > 12
    || value.table!==undefined && (!value.table || typeof value.table!=='object' || Array.isArray(value.table))) throw new TypeError('Der persönliche Artikelverlauf ist ungültig.');
  const numbers=value.articleNumbers.map(normalizeSalesArticleNumber);
  if (new Set(numbers).size !== numbers.length) throw new TypeError('Der persönliche Artikelverlauf ist ungültig.');
  return {version:1,articleNumbers:numbers,table:value.table || {}};
}
function visit(value,number) { const previous=normalize(value), next=normalizeSalesArticleNumber(number);
  return {...previous,articleNumbers:[next,...previous.articleNumbers.filter(n=>n!==next)].slice(0,12)}; }
function register(app, {catalog,preferences,sessionFor,assertFresh,assertCsrf,privateHeaders,vault,projectionFor}) {
  const queues=new Map();
  const context = session => ({namespace:'sales-recent-articles',connectorId:session.employeeNumber,field:'history',purpose:'personal-ui-preference'});
  async function read(session) {
    const row=await preferences.get(session.employeeNumber,KEY);
    if (!row) return empty();
    let value; await vault.useSecret(row.value,context(session),bytes=>{value=normalize(JSON.parse(bytes.toString('utf8')));}); return value;
  }
  const route = handler => async(req,res,next)=>{try {
    const session=sessionFor(req,false); privateHeaders(res);
    if (!session?.isEmployee || session.mustChangePassword || !session.employeeNumber) throw Object.assign(new Error('Der Artikelverlauf benötigt ein persönliches Konto.'),{status:403});
    if (req.method!=='GET') assertCsrf(req,session);
    await assertFresh(req,session); const result=await handler(req,session); await assertFresh(req,session);res.json(result);
  }catch(error){if(error instanceof TypeError || error.name==='SalesArticleCatalogError')error.status=400;next(error);}};
  async function update(req, session, operation) {
    const key=session.employeeNumber, prior=queues.get(key)||Promise.resolve();
    const work=prior.catch(()=>{}).then(async()=>{const value=operation(await read(session));await assertFresh(req,session);
      await preferences.upsert(key,KEY,vault.seal(JSON.stringify(value),context(session)));return value;});
    queues.set(key,work); try {return await work;} finally {if(queues.get(key)===work)queues.delete(key);}
  }
  app.get('/api/sales/articles/recent',route(async(req,session)=>{
    const value=await read(session), projection=projectionFor(session);
    const articles=(await Promise.all(value.articleNumbers.map(number=>catalog.getByArticleNumber(number)))).filter(Boolean).map(article=>{
      const row={articleNumber:article.articleNumber,description:article.description,status:article.active?'active':'archived',sourceSystem:article.sourceSystem,
        primaryIdentifier:(article.identifiers||[]).find(i=>i.isPrimary)?.identifierValue || article.identifiers?.[0]?.identifierValue || ''};
      for(const spec of PRICE_SEARCH_FIELDS) {
        if(!projection[spec.permission])continue;
        const prices=(article.prices||[]).filter(p=>p.priceType===spec.type&&p.priceBasis===spec.basis&&p.currency==='EUR'&&p.usable!==false&&['confirmed','inferred'].includes(p.qualityStatus)&&decimal(p.amount)!==null);
        row[spec.id]=prices.length===1?prices[0].amount:null;
      }return row;
    });
    return {articles,preferences:{...articleTablePreferences(value.table,projection),...(!value.table.sort || value.table.sort==='recent'?{sort:'recent'}:{})}};
  }));
  app.post('/api/sales/articles/recent',route(async(req,session)=>{
    if(!req.body || Object.keys(req.body).length!==1 || !Object.hasOwn(req.body,'articleNumber')) throw Object.assign(new Error('Bitte einen Artikel auswählen.'),{status:400});
    const number=normalizeSalesArticleNumber(req.body.articleNumber);if(!await catalog.getByArticleNumber(number)) throw Object.assign(new Error('Der Artikel wurde nicht gefunden.'),{status:404});
    const value=await update(req,session,previous=>visit(previous,number));return {articleNumbers:value.articleNumbers};
  }));
  app.put('/api/sales/articles/recent/preferences',route(async(req,session)=>{
    const table={...articleTablePreferences(req.body,projectionFor(session)),...(req.body?.sort==='recent'?{sort:'recent'}:{})}; await update(req,session,previous=>({...previous,table}));return table;
  }));
}
module.exports={KEY,empty,normalize,visit,register};
