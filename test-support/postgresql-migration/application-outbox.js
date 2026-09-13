'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
async function qualifyOutbox({root,config}){
 const identity=JSON.parse(fs.readFileSync(root+'/interrupted-report.json','utf8')).identity;
 assert.match(identity,/^b11-[a-f0-9-]{36}$/);
 const urls=Object.fromEntries(['core','sales'].map(domain=>{const u=new URL('postgresql://127.0.0.1:55487/gp_migration_'+domain);u.username='gp_'+domain+'_app';u.password=config.recoveryAccounts[u.username];return [domain+'Url',u.href];}));
 const app=await require('../../lib/persistence/postgresql/boundary/application').openTwoDatabaseDevelopmentApplication({...urls,stage:8,autoDeliver:false,authorize:()=>true});
 const repositories=require('../../lib/persistence/application-repositories').createApplicationRepositories;
 const {salesArticleImportContentSha256}=require('../../lib/sales-article-catalog');
 const made=[];
 try{
  await app.deliverAudits({limit:100});
  async function transaction(abort){
   return app.provider.transaction(async access=>{
    const repos=repositories(access),number='b11-outbox-'+crypto.randomBytes(5).toString('hex'),now=new Date().toISOString();
    const articles=[{sourceArticleKey:number,articleNumber:number,description:'Synthetische Übergabeprobe',active:true,sourceUpdatedAt:null,identifiers:[],prices:[]}];
    const result=await repos.salesArticleCatalog.importSnapshot({snapshot:{sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'block11-outbox-v1',sourceSchemaSha256:'a'.repeat(64),sourceFileSha256:crypto.createHash('sha256').update(number).digest('hex'),contentSha256:salesArticleImportContentSha256(articles),snapshotAt:now,articles},actor:identity,timestamp:now});
    const receipt=await repos.personalActionLog.record({actorId:identity,actionType:'sales.article-catalog.import',entityType:'sales_article_import_snapshot',entityId:result.snapshot.id,scope:'Synthetische Übergabeprobe',summary:'Importiert',compensatorKey:'sales.article-catalog.import.restore.v1',undoPayload:{snapshotId:result.snapshot.id},resultRevision:null,resultFingerprint:result.impactSha256,sourceAuditId:result.auditId,undoExpiresAt:new Date(Date.now()+3600000).toISOString(),compensatesActionId:null,createdAt:now});
    made.push(receipt.id);if(abort)throw new Error('BLOCK11_ABORT_BEFORE_SALES_COMMIT');return receipt;
   });
  }
  const receipt=await transaction(false),actions=repositories(app.provider).personalActionLog;
  assert.equal(await actions.getOwn(identity,receipt.id),null,'Core receipt is not written before durable delivery');
   let interruptedEvent;
   await assert.rejects(app.deliverAudits({limit:100,afterCoreCommit(event){
    if(event.action==='database-boundary.personal-action-v1'){
     interruptedEvent=event.eventId;throw new Error('BLOCK11_INTERRUPT_AFTER_CORE_COMMIT');
    }
   }}),/BLOCK11_INTERRUPT/);
   assert.ok(interruptedEvent,'The interruption must occur after committing the personal action receipt');
  const first=await actions.getOwn(identity,receipt.id);assert.ok(first);assert.equal(first.resultFingerprint,receipt.resultFingerprint);
  assert.equal((await app.deliverAudits({limit:100})).delivered,1);
  assert.deepEqual(await actions.getOwn(identity,receipt.id),first);assert.equal((await app.deliverAudits({limit:100})).delivered,0);
  await assert.rejects(transaction(true),/BLOCK11_ABORT_BEFORE_SALES_COMMIT/);
  assert.equal(await actions.getOwn(identity,made[1]),null);assert.equal((await app.deliverAudits({limit:100})).delivered,0);
  return {passed:true,interruptedAfterCoreCommit:true,idempotentDelivery:true,compensationRetained:true,rollbackBeforeSalesCommit:true,syntheticOnly:true};
 }finally{await app.close();}
}
module.exports={qualifyOutbox};
