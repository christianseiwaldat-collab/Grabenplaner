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
const gtin=number=>{
 const body=String(number).padStart(12,'0');let sum=0;
 for(let i=0;i<body.length;i++)sum+=Number(body[i])*(i%2?3:1);
 return body+String((10-sum%10)%10);
};
const decoded=entries=>({sourceFileSha256:'b'.repeat(64),safeFileName:'synthetic-articles.json',payload:{
 format:P.TRADEFOTO_ARTICLE_IMPORT_FORMAT,sourceSystem:P.TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
 sourceProfileVersion:P.TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,sourceSchemaSha256:P.TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
 snapshotAt:TIME,currency:'EUR',articles:entries.map(({articleRow,aliasRows})=>({
  articleRow:Object.fromEntries(P.TRADEFOTO_ARTICLE_ROW_FIELDS.map(field=>[field,articleRow[field]])),aliasRows,
 })),
}});
function inspectorBeforeBatching(){
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
 const filename=require.resolve('../lib/tradefoto-article-import'),compiled=new Module(filename,module);
 compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
 const baseline=fs.readFileSync(path.join(__dirname,'../test-support/fixtures/tradefoto-article-inspector-before-batching.cjs'),'utf8');
 compiled._compile(fs.readFileSync(filename,'utf8')+'\n'+baseline+'\nmodule.exports.inspectBeforeBatching=inspectTradeFotoArticleImportPayloadBeforeBatching;\n',filename);
 return compiled.exports.inspectBeforeBatching;
}
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

test('40-row inspection packets preserve the complete legacy result including cross-packet blocked owners and finding hashes',()=>{
 const entries=Array.from({length:125},(_,index)=>{
  const key=String(index+1).padStart(13,'0');
  return {articleRow:article(key),aliasRows:[alias(key,gtin(100000+index))]};
 });
 // Source identities reserve ownership even when an unrelated price gate blocks the first owner.
 entries[0].articleRow.NNPreis='-1';
 entries[40].articleRow.EAN=entries[0].articleRow.EAN;
 entries[40].aliasRows[0].EAN=entries[0].articleRow.EAN;
 // Raw alias ownership also survives tax-invalid and invalid-source-key articles.
 entries[1].articleRow.MWST=null;
 entries[1].aliasRows=[alias(entries[1].articleRow.EAN,'4006381333931')];
 entries[81].aliasRows=[alias(entries[81].articleRow.EAN,'4006381333931')];
 entries[2].articleRow.EAN='1234567890123';
 entries[2].aliasRows=[alias(entries[2].articleRow.EAN,'96385074')];
 entries[82].aliasRows=[alias(entries[82].articleRow.EAN,'96385074')];
 // Keep representative local findings in the byte comparison as well.
 entries[3].aliasRows.push(alias('0000000000999','036000291452',2));
 entries[4].articleRow.Verkaufspreis='15';entries[4].articleRow.eNvk='10';
 entries[5].articleRow.Artikelbezeichnung='Synthetic\u0000article';
 entries[6].aliasRows.push(alias(entries[6].articleRow.EAN,entries[6].articleRow.EAN,2));
 // Repeated observations and equivalent GTIN widths on one row have only one owner.
 const lastKey=entries[124].articleRow.EAN;
 entries[124].aliasRows=[alias(lastKey,'036000291452',3),alias(lastKey,'0036000291452',2),
  alias(lastKey,'00036000291452',1),alias(lastKey,'036000291452',4)];
 const legacy=inspectorBeforeBatching()(decoded(structuredClone(entries)));
 const input=decoded(structuredClone(entries)),session=I.createTradeFotoArticleImportInspectionSession(input);
 for(let after=0;after<input.payload.articles.length;after+=40)session.consume(input.payload.articles.slice(after,after+40));
 const actual=session.finish();
 assert.equal(JSON.stringify(actual),JSON.stringify(legacy),'Packet inspection must be byte-identical to the saved pre-batching algorithm');
 assert.equal(JSON.stringify(I.inspectTradeFotoArticleImportPayload(decoded(structuredClone(entries)))),JSON.stringify(legacy));
 assert.equal(actual.rows.length,125);assert.equal(actual.source.articleCount,125);
 for(const rowNumber of [1,41]){
  assert.ok(actual.rows[rowNumber-1].issueCodes.includes('duplicate_source_key'));
  assert.ok(actual.rows[rowNumber-1].issueCodes.includes('duplicate_article_number'));
 }
 for(const rowNumber of [2,3,82,83])assert.ok(actual.rows[rowNumber-1].issueCodes.includes('duplicate_gtin'));
 assert.ok(actual.rows[0].issueCodes.includes('negative_price'));
 assert.ok(actual.rows[1].issueCodes.includes('tax_code_unknown'));
 assert.ok(actual.rows[2].issueCodes.includes('invalid_source_key'));
 assert.equal(actual.rows[124].action,'ready');assert.equal(actual.rows[124].identifierCount,1);
 assert.equal(actual.normalizedArticles.find(row=>row.articleNumber==='000125').identifiers[0].identifierValue,'00036000291452');
 const expectedHash=require('node:crypto').createHash('sha256').update(JSON.stringify({
  rowNumber:82,articleNumber:'000082',code:'duplicate_gtin',detail:'',
 })).digest('hex');
 assert.equal(actual.findings.find(row=>row.rowNumber===82&&row.code==='duplicate_gtin').detailSha256,expectedHash);
 assert.equal(actual.counts.identifierCount,actual.normalizedArticles.reduce((sum,row)=>sum+row.identifiers.length,0));
 assert.equal(actual.counts.priceCount,actual.normalizedArticles.reduce((sum,row)=>sum+row.prices.length,0));
});

test('standalone limits remain bounded while Full Access prepares all 19,762 articles and 38,924 aliases',async()=>{
 assert.equal(I.TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,25000);
 assert.equal(I.TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS,750000);
 assert.equal(I.TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW,36);
 const articles=Array.from({length:19762},(_,index)=>article(String(index+1).padStart(13,'0'),
  index===19761?{'Änderungsdatum':'2026-11-11T12:34:56.789'}:{}));
 const aliases=Array.from({length:38924},(_,index)=>alias(articles[Math.floor(index/2)].EAN,gtin(100000+index),index%2));
 assert.equal(articles.length*36+aliases.length,750356);
 const byKey=new Map();
 for(const row of aliases){const list=byKey.get(row.EAN)||[];list.push(row);byKey.set(row.EAN,list);}
 const standalone=decoded(articles.map(articleRow=>({articleRow,aliasRows:byKey.get(articleRow.EAN)||[]})));
 assert.throws(()=>I.inspectTradeFotoArticleImportPayload(standalone),error=>error.code==='SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED'&&error.status===413);
 const before=JSON.stringify({articles,aliases}),result=await prepare(freshSync(),articles,aliases);
 assert.equal(result.rows.length,19762);assert.equal(result.source.articleCount,19762);
 assert.equal(result.normalizedArticles.length,19762);assert.equal(result.quarantinedAliases,0);
 assert.equal(result.counts.identifierCount,38924);assert.deepEqual(result.findings,[]);
 assert.ok(result.rows.every(row=>row.action==='ready'));
 assert.equal(result.source.snapshotAt,'2026-11-11T12:34:56.789Z','Every packet shares the dataset-wide source date');
 assert.equal(JSON.stringify({articles,aliases}),before);
});

test('standalone envelope, per-parent aliases and normalized identifier limits remain unchanged',()=>{
 const key='0000000000042',entry={articleRow:article(key),aliasRows:[]};
 const tooManyRows=decoded(Array.from({length:25001},()=>entry));
 assert.throws(()=>I.decodeTradeFotoArticleImportBuffer(Buffer.from(JSON.stringify(tooManyRows.payload)),{fileName:'synthetic.json'}),
  error=>error.code==='SALES_ARTICLE_IMPORT_ROW_LIMIT'&&error.status===413);
 const tooManyAliases=decoded([{articleRow:article(key),aliasRows:Array.from({length:257},(_,index)=>alias(key,'internal-'+index))}]);
 assert.throws(()=>I.inspectTradeFotoArticleImportPayload(tooManyAliases),error=>error.code==='SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH');
 const tooManyIdentifiers=I.inspectTradeFotoArticleImportPayload(decoded([{articleRow:article(key),
  aliasRows:Array.from({length:33},(_,index)=>alias(key,gtin(100000+index)))}]));
 assert.equal(tooManyIdentifiers.normalizedArticles.length,0);
 assert.deepEqual(tooManyIdentifiers.rows[0].issueCodes,['row_invalid']);
});

test('Full Access retains its dataset article and raw-alias bounds before optional quarantine',async()=>{
 const key='0000000000042',row=article(key);
 await assert.rejects(prepare(freshSync(),Array.from({length:25001},()=>row)),
  error=>error.code==='IMPORT_ARTICLE_CATALOG_LIMIT'&&error.status===413);
 const orphan=alias('0000000000999','internal-code');
 await assert.rejects(prepare(freshSync(),[row],Array.from({length:750001},()=>orphan)),
  error=>error.code==='IMPORT_ARTICLE_CATALOG_LIMIT'&&error.status===413);
});

test('the finding cap covers all packets and final duplicate findings together',()=>{
 const key='0000000000042',entry={articleRow:article(key,{NNPreis:'-1',MWST:null}),
  aliasRows:[alias(key,'4006381333931'),alias(key,'internal-code',2),alias(key,key,3)]};
 // Four local findings and three global duplicate findings per row cross 100,000.
 const entries=Array.from({length:14300},()=>entry),matchesFindingLimit=error=>
  error.code==='SALES_ARTICLE_IMPORT_FINDING_LIMIT'&&error.status===413;
 assert.equal(I.TRADEFOTO_ARTICLE_IMPORT_MAX_FINDINGS,100000);
 assert.throws(()=>inspectorBeforeBatching()(decoded(structuredClone(entries))),matchesFindingLimit);
 assert.throws(()=>{
  const input=decoded(entries),session=I.createTradeFotoArticleImportInspectionSession(input);
  for(let after=0;after<input.payload.articles.length;after+=40)session.consume(input.payload.articles.slice(after,after+40));
  session.finish();
 },matchesFindingLimit);
});

test('late GTIN-owner ordering matches legacy key order and hashes through the final packet row',()=>{
 const entries=Array.from({length:125},(_,index)=>{
  const key=String(index+1).padStart(13,'0');
  return {articleRow:article(key),aliasRows:[]};
 });
 for(const index of [0,124])entries[index].aliasRows=[alias(entries[index].articleRow.EAN,'4006381333931')];
 for(const index of [1,80])entries[index].aliasRows=[alias(entries[index].articleRow.EAN,'96385074')];
 const legacy=inspectorBeforeBatching()(decoded(structuredClone(entries)));
 const input=decoded(entries),session=I.createTradeFotoArticleImportInspectionSession(input);
 for(let after=0;after<input.payload.articles.length;after+=40)session.consume(input.payload.articles.slice(after,after+40));
 const actual=session.finish();
 assert.deepEqual(legacy.findings.map(row=>[row.rowNumber,row.code]),
  [[1,'duplicate_gtin'],[125,'duplicate_gtin'],[2,'duplicate_gtin'],[81,'duplicate_gtin']],
  'The earlier source key is finalized first even though its collision is discovered last');
 assert.equal(JSON.stringify(actual.findings),JSON.stringify(legacy.findings),'Finding order and each global-ordinal hash must match');
 assert.equal(JSON.stringify(actual),JSON.stringify(legacy));
 assert.deepEqual(actual.rows[124].issueCodes,['duplicate_gtin']);
 assert.equal(actual.rows[124].action,'blocked');assert.equal(actual.normalizedArticles.length,121);
});

test('an over-budget consume poisons the inspection session and cannot return a partial result',()=>{
 const input=decoded([{articleRow:article(),aliasRows:[]}]);
 const entry=input.payload.articles[0],session=I.createTradeFotoArticleImportInspectionSession(input);
 session.consume([entry]);
 assert.throws(()=>session.consume(Array.from({length:20834},()=>entry)),
  error=>error.code==='SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED'&&error.status===413);
 for(const operation of [()=>session.finish(),()=>session.consume([entry])]){
  assert.throws(operation,error=>error.code==='SALES_ARTICLE_IMPORT_SESSION_STATE'&&error.status===409);
 }
});

test('the cumulative session row bound covers earlier packets and poisons a failed continuation',()=>{
 const input=decoded([{articleRow:article(),aliasRows:[]}]);
 const entry=input.payload.articles[0],session=I.createTradeFotoArticleImportInspectionSession(input);
 session.consume(Array.from({length:12500},()=>entry));
 session.consume(Array.from({length:12500},()=>entry));
 assert.throws(()=>session.consume([entry]),error=>error.code==='SALES_ARTICLE_IMPORT_ROW_LIMIT'&&error.status===413);
 assert.throws(()=>session.finish(),error=>error.code==='SALES_ARTICLE_IMPORT_SESSION_STATE'&&error.status===409);
});
