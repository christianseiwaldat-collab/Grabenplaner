'use strict';
const crypto=require('node:crypto'),C=require('./data-import-contract'),P=require('./tradefoto-article-source-profile');
const {inspectTradeFotoArticleImportPayload,TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS,TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS,TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW}=require('./tradefoto-article-import');
const {salesArticleImportContentSha256,normalizeSalesArticleImportSnapshot}=require('./sales-article-catalog');
const {createSalesArticleCatalogRepository}=require('./persistence/repositories/sales-article-catalog');
const {civil}=require('./data-import-content-date');
const BATCH_SIZE=40;
const snapshot=(prepared,articles)=>({sourceSystem:prepared.sourceSystem,sourceProfileVersion:prepared.sourceProfileVersion,
  sourceSchemaSha256:prepared.sourceSchemaSha256,sourceFileSha256:prepared.source.fileSha256,
  contentSha256:salesArticleImportContentSha256(articles),snapshotAt:prepared.source.snapshotAt,articles});
function createDataImportArticleSync() {
  // A bounded cache of immutable source adaptation only. Catalog heads and
  // permissions are always checked afresh in the transaction that writes them.
  let cached=null;
  async function prepareSource(source,readRows,check) {
    const key=C.canonical([source.id,source.fileSha256,source.tables.filter(t=>['ARTIKEL_STAMM','ARTIKEL_ZWEITEAN'].includes(t.name)).map(t=>t.run?.id)]);
    if(cached?.key===key)return cached.prepared;
    cached=null;
    const articles=[],aliases=[];
    for(const [table,target,limit] of [['ARTIKEL_STAMM',articles,TRADEFOTO_ARTICLE_IMPORT_MAX_ROWS],['ARTIKEL_ZWEITEAN',aliases,TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS]]) {
      let after=0;
      for(;;) {
        await check();const page=await readRows(table,after);
        target.push(...page.rows);
        if(target.length>limit)C.fail('IMPORT_ARTICLE_CATALOG_LIMIT',413);
        if(page.complete)break;
        if(page.after<=after)C.fail('IMPORT_SOURCE_INTEGRITY');after=page.after;
      }
    }
    if(articles.length*TRADEFOTO_ARTICLE_IMPORT_WORK_UNITS_PER_ROW+aliases.length>TRADEFOTO_ARTICLE_IMPORT_MAX_WORK_UNITS)C.fail('IMPORT_ARTICLE_CATALOG_LIMIT',413);
    const keys=new Set(articles.map(r=>r.EAN)),byKey=new Map();
    for(const row of aliases) {
      if(!keys.has(row.EAN))C.fail('IMPORT_ARTICLE_CATALOG_RELATION',409);
      const list=byKey.get(row.EAN)||[];list.push(row);byKey.set(row.EAN,list);
      if(list.length>256)C.fail('IMPORT_ARTICLE_CATALOG_LIMIT',413);
    }
    let latest=null;
    for(const row of articles) {const date=civil(row['Änderungsdatum']);if(date&&(!latest||date>latest))latest=date;}
    if(articles.length&&!latest)C.fail('IMPORT_ARTICLE_CATALOG_DATE',409);
    const inspected=inspectTradeFotoArticleImportPayload({sourceFileSha256:source.fileSha256,safeFileName:source.fileName||'Trade_Daten.accdb',payload:{
      format:P.TRADEFOTO_ARTICLE_IMPORT_FORMAT,sourceSystem:P.TRADEFOTO_ARTICLE_SOURCE_SYSTEM,
      sourceProfileVersion:P.TRADEFOTO_ARTICLE_SOURCE_PROFILE_VERSION,sourceSchemaSha256:P.TRADEFOTO_ARTICLE_SOURCE_SCHEMA_SHA256,
      snapshotAt:latest?latest+'Z':source.createdAt,currency:'EUR',
      articles:articles.map(row=>({articleRow:Object.fromEntries(P.TRADEFOTO_ARTICLE_ROW_FIELDS.map(field=>[field,row[field]])),aliasRows:byKey.get(row.EAN)||[]})),
    }});
    const prepared=Object.freeze({...inspected,sourceProfileVersion:inspected.sourceProfileVersion+'.db1.'+source.id.slice(0,16)});
    cached={key,prepared};return prepared;
  }
  async function plan(tx,source,prepared) {
    const repo=createSalesArticleCatalogRepository(tx),progress=structuredClone(source.catalog||{after:0,changed:0,unchanged:0,
      blocked:prepared.rows.filter(r=>r.action==='blocked').length,total:prepared.rows.length,batches:[]});
    const before={unchanged:progress.unchanged,blocked:progress.blocked};
    const rows=prepared.normalizedArticles.slice(progress.after,progress.after+BATCH_SIZE);
    if(rows.length) {
      const preview=await repo.inspectImportSnapshot({snapshot:snapshot(prepared,rows)}),accepted=[];
      for(let i=0;i<rows.length;i++) {
        if(['create','update'].includes(preview.rows[i].action))accepted.push(rows[i]);
        else if(preview.rows[i].action==='unchanged')progress.unchanged++;
        else progress.blocked++;
      }
      if(accepted.length) {
        const selected=snapshot(prepared,accepted),fresh=await repo.inspectImportSnapshot({snapshot:selected});
        // Core stores this encrypted intent before Sales is allowed to write.
        // A retry uses exactly the same snapshot, even after a lost reply.
        progress.pending={snapshot:selected,expectedStateSha256:fresh.stateSha256,nextAfter:progress.after+rows.length,
          complete:progress.after+rows.length===prepared.normalizedArticles.length,before};
        progress.complete=false;return progress;
      }
      progress.after+=rows.length;
    }
    progress.complete=progress.after===prepared.normalizedArticles.length;
    return progress;
  }
  const intentSnapshot=pending=>normalizeSalesArticleImportSnapshot(pending.snapshot);
  function acknowledge(progress,result) {
    const next=structuredClone(progress),pending=next.pending;
    if(result.snapshot.id!==intentSnapshot(pending).id)C.fail('IMPORT_SOURCE_INTEGRITY');
    next.batches.push({id:result.snapshot.id,impactSha256:result.impactSha256});next.changed+=pending.snapshot.articles.length;
    next.after=pending.nextAfter;next.complete=pending.complete;delete next.pending;return next;
  }
  async function commit(tx,progress,{ownerId,at},recoverOnly=false) {
    const repo=createSalesArticleCatalogRepository(tx),pending=progress.pending;
    const reconsider=()=>{const next=structuredClone(progress);Object.assign(next,pending.before);delete next.pending;return next;};
    const existing=await repo.getImportSnapshot(intentSnapshot(pending).idempotencyKey);
    if(!existing) {
      if(recoverOnly)return reconsider();
      const current=await repo.inspectImportSnapshot({snapshot:pending.snapshot});
      if(current.stateSha256!==pending.expectedStateSha256) {
        // Changed/manual heads are reconsidered by the normal inspector; never
        // retry an obsolete decision indefinitely or overwrite a manual edit.
        return reconsider();
      }
    }
    const result=await repo.importSnapshot({snapshot:pending.snapshot,actor:ownerId,timestamp:at,
      ...(!existing?{expectedStateSha256:pending.expectedStateSha256}:{})});
    return acknowledge(progress,result);
  }
  async function planUndo(tx,progress) {
    const next=structuredClone(progress),batch=[...next.batches].reverse().find(b=>!b.reverted);
    if(!batch)return next;
    const preview=await createSalesArticleCatalogRepository(tx).inspectImportUndo({snapshotId:batch.id});
    if(!preview.canUndo||preview.impactSha256!==batch.impactSha256)C.fail('IMPORT_UNDO_MANUAL_CHANGE',409);
    next.pendingUndo={snapshotId:batch.id,impactSha256:batch.impactSha256,undoId:crypto.randomUUID()};return next;
  }
  async function commitUndo(tx,progress,{ownerId,at}) {
    const next=structuredClone(progress),pending=next.pendingUndo,repo=createSalesArticleCatalogRepository(tx);
    const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
    const key=hash(`sales-article-import-undo-v1\0${pending.undoId}`),existing=await repo.getImportSnapshot(key);
    if(existing) {
      if(existing.sourceSystem!=='tradefoto.article.import.undo'||existing.sourceFileSha256!==hash(`sales-article-import-undo-event-v1\0${pending.snapshotId}\0${pending.undoId}`))C.fail('IMPORT_SOURCE_INTEGRITY');
    } else {
      const result=await repo.undoImport({snapshotId:pending.snapshotId,expectedImpactSha256:pending.impactSha256,undoId:pending.undoId,actor:ownerId,timestamp:at});
      if(result.outcome!=='updated')C.fail('IMPORT_UNDO_MANUAL_CHANGE',409);
    }
    next.batches.find(b=>b.id===pending.snapshotId).reverted=true;delete next.pendingUndo;return next;
  }
  return {prepareSource,plan,commit,planUndo,commitUndo,clear(){cached=null;}};
}
module.exports={createDataImportArticleSync,BATCH_SIZE};
