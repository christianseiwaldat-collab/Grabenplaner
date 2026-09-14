'use strict';
const {Pool}=require('pg');
const {configuration,verifyEnvironment}=require('../core/environment');
const {schemaFingerprint}=require('../core/fingerprint');
const {createPostgresqlPersistenceProvider}=require('../provider');
const {SCHEMAS,SEARCH_PATH}=require('./layout');
const {createSalesSchemaPlan}=require('./schema');
const {createSalesCatalog}=require('./catalog');
async function openSalesDevelopmentApplication(options={}){
  const stage=options.stage||5;
  const config=configuration({...options,domain:'sales'}),pool=new Pool(config),initialized=new WeakSet();
  const catalog=createSalesCatalog(stage);
  if(stage>=7)require('../boundary/catalog').assertBoundaryCatalog();
  if(stage>=8)require('../reporting/catalog').assertReportingCatalog();
  const guarded={
    async connect(){
      const acquired=performance.now();
      const client=await pool.connect();
      try{options.onDevelopmentMetric?.({domain:'sales',kind:'poolWait',milliseconds:performance.now()-acquired});}catch{}
      try{
        if(!initialized.has(client)){
          await verifyEnvironment(client,{domain:'sales',purpose:options.purpose||'app',binding:options.binding});
          await client.query('SET search_path='+SEARCH_PATH);
          const rows=(await client.query('SELECT stage,source_sha256,plan_sha256,target_sha256 FROM gp.sales_migration_history ORDER BY stage')).rows;
          if(rows.at(-1)?.stage!==stage||rows.some(r=>r.plan_sha256!==createSalesSchemaPlan(r.stage).digest||r.source_sha256!==createSalesSchemaPlan(r.stage).sourceSchemaSha256)||rows.at(-1).target_sha256!==await schemaFingerprint(client,SCHEMAS))throw new Error('Sales application schema contract mismatch');
          initialized.add(client);
        }
        return client;
      }catch(error){client.release(true);throw error;}
    },
    end:()=>pool.end(),on:(...args)=>pool.on(...args),removeListener:(...args)=>pool.removeListener(...args),
  };
  try{
    const client=await guarded.connect();client.release();
    const entries=[...catalog.entries,...(stage>=7?[...require('../boundary/catalog').SALES_BOUNDARY_CATALOG,...require('../boundary/personal-actions').CATALOG]:[]),...(stage>=8?require('../reporting/catalog').REPORTING_BOUNDARY_CATALOG:[])];
    if(stage>=8)entries.push(...require('../reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG);
    const provider=createPostgresqlPersistenceProvider({pool:guarded,catalog:entries,poolOwnership:'provider'});
    return Object.freeze({provider,close:()=>provider.close(),stage,productActivation:false});
  }catch(error){await pool.end();throw error;}
}
module.exports={openSalesDevelopmentApplication};
