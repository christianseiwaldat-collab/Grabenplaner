'use strict';
const {Pool}=require('pg');
const {configuration,verifyEnvironment}=require('./environment');
const {schemaFingerprint}=require('./fingerprint');
const {createSchemaPlan}=require('./schema');
const {createCoreCatalog}=require('./catalog');
const {createPostgresqlPersistenceProvider}=require('../provider');
const {createApplicationRepositories}=require('../../application-repositories');

function coreRepositories(access){
  const all=createApplicationRepositories(access);
  // Cross-database methods remain unavailable at the statement boundary until
  // the explicit Core/Sales integration in block 7. No fallback to SQLite.
  return Object.freeze(Object.fromEntries(Object.entries(all).filter(([name])=>!['salesAnalytics','salesArticleCatalog'].includes(name))));
}
async function openCoreDevelopmentApplication(options={}){
  const config=configuration(options),pool=new Pool(config),initialized=new WeakSet();
  const catalog=createCoreCatalog();
  if(options.boundary)require('../boundary/catalog').assertBoundaryCatalog();
  const entries=[...catalog.entries,...(options.boundary?require('../boundary/catalog').CORE_BOUNDARY_CATALOG:[])];
  const guardedPool={
    async connect(){
      const acquired=performance.now();
      const client=await pool.connect();
      try{options.onDevelopmentMetric?.({domain:'core',kind:'poolWait',milliseconds:performance.now()-acquired});}catch{}
      try {
        if(!initialized.has(client)){
          await verifyEnvironment(client,{purpose:options.purpose||'app',binding:options.binding});
          await client.query('SET search_path=pg_catalog,gp');
          const state=await require('../boundary/migrate').verifyCoreSchema(client);
          if(options.boundary&&!state.boundary)throw new Error('Core boundary migration required');
          initialized.add(client);
        }
        return client;
      }catch(error){client.release(true);throw error;}
    },
    end:()=>pool.end(),on:(...args)=>pool.on(...args),removeListener:(...args)=>pool.removeListener(...args),
  };
  try {
    const client=await guardedPool.connect();client.release();
    const provider=createPostgresqlPersistenceProvider({pool:guardedPool,catalog:entries,poolOwnership:'provider'});
    return Object.freeze({provider,repositories:coreRepositories(provider),productActivation:false,statementCount:catalog.entries.length,
      transaction:(work,options)=>provider.transaction(access=>work(coreRepositories(access)),options),close:()=>provider.close()});
  }catch(error){await pool.end();throw error;}
}
module.exports={coreRepositories,openCoreDevelopmentApplication};
