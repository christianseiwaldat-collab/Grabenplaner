'use strict';
const {createPersistenceProviderFacade}=require('../contract');
const {POSTGRESQL_CAPABILITIES}=require('./provider');
const {openTwoDatabaseDevelopmentApplication}=require('./boundary/application');
const {openCoreOperations}=require('./application-operations/access');
function openDeferredPostgresqlApplication({coreUrl,salesUrl,readers,profile='core-migration-development',binding,authorize,onOperation=()=>{}}){
 let operations,authorization;
 const ready=(async()=>{
  const application=await openTwoDatabaseDevelopmentApplication({coreUrl,salesUrl,stage:8,profile,binding,authorize,autoDeliver:true});
  try{
   authorization=await require('./core/application').openCoreDevelopmentApplication({profile,binding,databaseUrl:readers.coreUrl,purpose:'reader',tlsMode:'disable-local-only',boundary:true});
   operations=await openCoreOperations({profile,binding,databaseUrl:coreUrl,tlsMode:'disable-local-only',authorize:()=>authorize({readOnly:false,statementIds:['application-operation']})});
  }catch(error){await authorization?.close();await application.close();throw error;}
  return Object.freeze({...application,authorizationRepositories:authorization.repositories});
 })();ready.catch(()=>{});
 const adapter={providerId:'postgresql',capabilities:POSTGRESQL_CAPABILITIES,
  async query(statement,parameters){onOperation(statement.id);const provider=(await ready).provider;if(statement.operation==='queryOne'){const row=await provider.queryOne(statement,parameters);return row?[row]:[];}return provider.queryAll(statement,parameters);},
  async execute(statement,parameters){onOperation(statement.id);return (await ready).provider.execute(statement,parameters);},
  async beginTransaction(options){
   const provider=(await ready).provider;let started,failed,finish,cancel;
   const available=new Promise((resolve,reject)=>{started=resolve;failed=reject;});
   const end=new Promise((resolve,reject)=>{finish=resolve;cancel=reject;});end.catch(()=>{});
   const completed=provider.transaction(async tx=>{started(tx);await end;},options);completed.catch(failed);
   const tx=await available,abort=new Error('PG_APPLICATION_ROLLBACK');let closed=false;
   async function close(commit){if(closed)return;closed=true;commit?finish():cancel(abort);try{await completed;}catch(error){if(error!==abort)throw error;}}
   return {async query(statement,parameters){if(statement.operation==='queryOne'){const row=await tx.queryOne(statement,parameters);return row?[row]:[];}return tx.queryAll(statement,parameters);},execute:(s,p)=>tx.execute(s,p),commit:()=>close(true),rollback:()=>close(false)};
  },
  async close(){try{await (await ready).close();}finally{await operations?.close();await authorization?.close();}},
 };
 const access=Object.freeze({prepare(sql){return Object.freeze(Object.fromEntries(['get','all','run'].map(method=>[method,async(...args)=>{onOperation('application.'+sql.trim().slice(0,70));await ready;return operations.prepare(sql)[method](...args);}])));},async transaction(work,options){onOperation('application.transaction');await ready;return operations.transaction(work,options);}});
 return Object.freeze({database:null,provider:createPersistenceProviderFacade(adapter),operations:access,ready});
}
module.exports={openDeferredPostgresqlApplication};
