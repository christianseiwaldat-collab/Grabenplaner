'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../lib/tradefoto-article-source-profile'),I=require('../lib/tradefoto-article-import');
const {normalizeSalesArticleImportSnapshot}=require('../lib/sales-article-catalog');
const {ADAPTATION_VERSION}=require('../lib/data-import-catalog-price');
const SYNC=require.resolve('../lib/data-import-article-sync');
const TIME='2026-11-11T10:00:00.000Z',OLD_VERSION='db2-decimal12-half-up';
const article=(key='0000000000042',extra={})=>({...Object.fromEntries(P.TRADEFOTO_ARTICLE_ROW_FIELDS.map(field=>[field,null])),
 EAN:key,Artikelbezeichnung:'Synthetic article',MWST:1,'Änderungsdatum':'2026-11-10T10:00:00.000',...extra});
const alias=(key,value,rank=1)=>({EAN:key,ZweitEAN:value,Rang:rank});
const source=(extra={})=>({id:'a'.repeat(64),fileSha256:'b'.repeat(64),createdAt:TIME,
 tables:[{name:'ARTIKEL_STAMM',run:{id:'synthetic-articles'}},{name:'ARTIKEL_ZWEITEAN',run:{id:'synthetic-aliases'}}],...extra});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
async function prepare(sync,articles,aliases=[]){
 return sync.prepareSource(source(),async(name,after)=>{
  const all=name==='ARTIKEL_STAMM'?articles:aliases;
  return {rows:all.slice(after,after+200),after:Math.min(after+200,all.length),complete:after+200>=all.length};
 },async()=>{});
}
const freshSync=()=>require(SYNC).createDataImportArticleSync();
function repositorySync(t,repository){
 const module=require('../lib/persistence/repositories/sales-article-catalog');
 t.mock.method(module,'createSalesArticleCatalogRepository',()=>repository);
 delete require.cache[SYNC];t.after(()=>{delete require.cache[SYNC];});
 return freshSync();
}

test('catalog projection keeps valid aliases and the article while holding each unsupported optional alias without changing source rows',async()=>{
 const key='0000000000042';
 const articles=freeze([article(key,{Artikelbezeichnung:'Synthetic\r\narticle\tlabel'})]);
 const aliases=freeze([alias(key,'4006381333931'),alias(key,'96385074',2),alias(key,'4006381333932',3),
  alias(key,'internal-code',4),alias(key,'036000291452',null)]);
 const before=JSON.stringify({articles,aliases}),sync=freshSync();
 const result=await prepare(sync,articles,aliases);
 assert.equal(result.quarantinedAliases,3);assert.equal(result.normalizedArticles.length,1);
 assert.equal(result.rows[0].action,'ready');assert.equal(result.normalizedArticles[0].description,'Synthetic article label');
 assert.deepEqual(result.normalizedArticles[0].identifiers.map(row=>row.identifierValue).sort(),['4006381333931','96385074']);
 assert.equal(JSON.stringify({articles,aliases}),before,'Only the catalog projection may change');
 assert.equal(ADAPTATION_VERSION,'db3-label-space-alias');
 assert.ok(result.sourceProfileVersion.includes('.'+ADAPTATION_VERSION+'.'));
 assert.ok(result.sourceProfileVersion.length<=64);
 const direct=P.inspectTradeFotoArticleSourceAliases(key,aliases);
 assert.deepEqual(direct.quarantined.map(row=>row.aliasIndex),[2,3,4]);
 const standalone=P.adaptTradeFotoArticleSourceRow({articleRow:Object.fromEntries(P.TRADEFOTO_ARTICLE_ROW_FIELDS.map(f=>[f,article(key)[f]])),aliasRows:aliases,currency:'EUR'});
 assert.deepEqual(direct.quarantined,standalone.quarantine.identifiers,'Reuse the actual standalone adapter rules');
});

test('optional alias quarantine preserves cross-article GTIN ownership conflicts and held-parent aliases',async()=>{
 const a='0000000000042',b='0000000000043';
 const result=await prepare(freshSync(),[article(a),article(b)],[alias(a,'4006381333931'),alias(b,'4006381333931'),
  alias(a,'internal-code'),alias('0000000000099','96385074')]);
 assert.equal(result.quarantinedAliases,2);assert.equal(result.normalizedArticles.length,0);
 assert.deepEqual(result.rows.map(row=>row.issueCodes),[['duplicate_gtin'],['duplicate_gtin']]);
});

test('label projection and optional aliases do not relax price, tax, source-key or remaining control-character gates',async()=>{
 const examples=[
  [article('0000000000042',{NNPreis:'-1'}),'negative_price'],
  [article('0000000000043',{Verkaufspreis:'12',eNvk:null}),'gross_net_pair_incomplete'],
  [article('0000000000044',{Verkaufspreis:'15',eNvk:'10'}),'gross_net_mismatch'],
  [article('0000000000045',{MWST:null}),'tax_code_unknown'],
  [article('1234567890123'),'invalid_source_key'],
  [article('0000000000046',{Artikelbezeichnung:'Synthetic\u0000article'}),'row_invalid'],
 ];
 const result=await prepare(freshSync(),examples.map(([row])=>row));
 assert.equal(result.normalizedArticles.length,0);
 examples.forEach(([,code],index)=>assert.ok(result.rows[index].issueCodes.includes(code)));
 assert.equal(result.quarantinedAliases,0);
});

test('optional quarantine cannot bypass the alias work limit or the supported identifier limit',async()=>{
 const key='0000000000042';
 await assert.rejects(prepare(freshSync(),[article(key)],Array.from({length:257},(_,i)=>alias(key,'internal-'+i))),
  error=>error.code==='IMPORT_ARTICLE_CATALOG_LIMIT');
 const validGtin=number=>{
  const body=String(number).padStart(12,'0');let sum=0;
  for(let i=0;i<body.length;i++)sum+=Number(body[i])*(i%2?3:1);
  return body+String((10-sum%10)%10);
 };
 const result=await prepare(freshSync(),[article(key)],Array.from({length:33},(_,i)=>alias(key,validGtin(100000+i))));
 assert.equal(result.quarantinedAliases,0);assert.equal(result.normalizedArticles.length,0);
 assert.deepEqual(result.rows[0].issueCodes,['row_invalid']);
});

test('an older partial catalog revisits the new projection with prior undo batches retained',async t=>{
 let inspected;
 const sync=repositorySync(t,{async inspectImportSnapshot({snapshot}){inspected=snapshot;return {rows:snapshot.articles.map(()=>({action:'unchanged'})),stateSha256:'c'.repeat(64)};}});
 const prepared=await prepare(sync,[article()]);
 const batch={id:'d'.repeat(64),impactSha256:'e'.repeat(64)},previous={after:1,changed:1,unchanged:0,blocked:1,total:2,
  complete:false,adaptationVersion:OLD_VERSION,batches:[batch]},before=structuredClone(previous);
 const result=await sync.plan({},source({catalog:previous}),prepared);
 assert.deepEqual(previous,before);assert.deepEqual(result.batches,[batch]);
 assert.equal(result.after,1);assert.equal(result.changed,0);assert.equal(result.unchanged,1);assert.equal(result.blocked,0);
 assert.equal(result.complete,true);assert.equal(result.adaptationVersion,ADAPTATION_VERSION);
 assert.deepEqual(result.previousAdaptation,{version:OLD_VERSION,changed:1,unchanged:0,blocked:1});
 assert.ok(inspected.sourceProfileVersion.includes('.'+ADAPTATION_VERSION+'.'));
});

test('a version revisit never silently reinterprets pending apply, pending undo or reverted prior batches',async()=>{
 const sync=freshSync(),prepared=await prepare(sync,[article()]);
 for(const extra of [{pending:{snapshot:{synthetic:'original'}}},{pendingUndo:{snapshotId:'c'.repeat(64)}},{batches:[{reverted:true}]}]){
  const previous={after:1,changed:1,unchanged:0,blocked:1,total:2,adaptationVersion:OLD_VERSION,batches:[],...extra},before=structuredClone(previous);
  await assert.rejects(sync.plan({},source({catalog:previous}),prepared),error=>error.code==='IMPORT_STATE_CONFLICT');
  assert.deepEqual(previous,before);
 }
});

test('an old pending catalog intent commits its exact old snapshot before a version revisit',async t=>{
 let input;
 const sync=repositorySync(t,{async getImportSnapshot(){return null;},
  async inspectImportSnapshot({snapshot}){input=structuredClone(snapshot);return {stateSha256:'c'.repeat(64)};},
  async importSnapshot({snapshot,expectedStateSha256}){assert.equal(expectedStateSha256,'c'.repeat(64));return {snapshot:{id:normalizeSalesArticleImportSnapshot(snapshot).id},impactSha256:'d'.repeat(64)};}});
 const prepared=await prepare(sync,[article()]),snapshot={sourceSystem:prepared.sourceSystem,
  sourceProfileVersion:P.TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION+'.'+OLD_VERSION+'.'+'a'.repeat(16),
  sourceSchemaSha256:prepared.sourceSchemaSha256,sourceFileSha256:prepared.source.fileSha256,
  contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(prepared.normalizedArticles),
  snapshotAt:prepared.source.snapshotAt,articles:prepared.normalizedArticles};
 const previous={after:0,changed:0,unchanged:0,blocked:1,total:2,adaptationVersion:OLD_VERSION,batches:[],complete:false,
  pending:{snapshot,expectedStateSha256:'c'.repeat(64),nextAfter:1,complete:true,before:{unchanged:0,blocked:1}}};
 const before=structuredClone(previous),committed=await sync.commit({},previous,{ownerId:'synthetic-owner',at:TIME});
 assert.deepEqual(input,snapshot);assert.deepEqual(previous,before);
 assert.equal(committed.pending,undefined);assert.equal(committed.changed,1);assert.equal(committed.complete,true);
 assert.equal(committed.adaptationVersion,OLD_VERSION);assert.equal(sync.needsRefresh(committed),true);
});

test('an already committed old intent replays after a lost reply without new projection or stale-state checks',async t=>{
 let writes=0,reads=0;
 const sync=repositorySync(t,{async getImportSnapshot(){return {id:'synthetic-existing'};},
  async inspectImportSnapshot(){reads++;throw new Error('A committed intent must replay without re-planning');},
  async importSnapshot({snapshot,...options}){writes++;assert.equal(Object.hasOwn(options,'expectedStateSha256'),false);
   assert.ok(snapshot.sourceProfileVersion.includes('.'+OLD_VERSION+'.'));
   return {snapshot:{id:normalizeSalesArticleImportSnapshot(snapshot).id},impactSha256:'d'.repeat(64)};}});
 const prepared=await prepare(sync,[article()]),snapshot={sourceSystem:prepared.sourceSystem,
  sourceProfileVersion:P.TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION+'.'+OLD_VERSION+'.'+'a'.repeat(16),
  sourceSchemaSha256:prepared.sourceSchemaSha256,sourceFileSha256:prepared.source.fileSha256,
  contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(prepared.normalizedArticles),
  snapshotAt:prepared.source.snapshotAt,articles:prepared.normalizedArticles};
 const previous={after:0,changed:0,unchanged:0,blocked:1,total:2,adaptationVersion:OLD_VERSION,batches:[],complete:false,
  pending:{snapshot,expectedStateSha256:'c'.repeat(64),nextAfter:1,complete:true,before:{unchanged:0,blocked:1}}};
 const before=structuredClone(previous),committed=await sync.commit({},previous,{ownerId:'synthetic-owner',at:TIME});
 assert.equal(writes,1);assert.equal(reads,0);assert.deepEqual(previous,before);
 assert.equal(committed.pending,undefined);assert.equal(committed.changed,1);assert.equal(committed.complete,true);
 assert.equal(sync.needsRefresh(committed),true);
});
