"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {fixture,input}=require('../test-support/workflow-studio-service');
const {createPortalAccessRepository}=require('../lib/persistence/repositories/portal-access');
const {createOrganizationPersonnelRepository}=require('../lib/persistence/repositories/organization-personnel');
const {createCustomProcessManagementRepository}=require('../lib/persistence/repositories/custom-process-management');
const {functionSource}=require('../test-support/learning-workspace-ui');
test('Studio real server catalog helpers and actual typed session authorization use the same transaction executor through draft, publication, run and task reads',async()=>{
 let f,txSessionReads=0,txCatalogReads=0,throwAfterWrite=false;
 const ctx=vm.createContext({builtinPortalRoles:[],PROTECTED_PORTAL_ROLES:new Set(),allPortalPermissions:new Set(['rights:read','processes:write']),parsePortalPermissions:v=>JSON.parse(v),serializeDepartment:v=>v,serializeLocation:(v,departments)=>({...v,departments})});
 vm.runInContext(functionSource('getPortalRoles','../server.js')+functionSource('getLocations','../server.js'),ctx);
 f=fixture({persistenceCatalog:[...require('../lib/persistence/sqlite/organization-personnel-catalog').SQLITE_ORGANIZATION_PERSONNEL_CATALOG,...require('../lib/persistence/sqlite/portal-access-catalog').SQLITE_PORTAL_ACCESS_CATALOG],catalog:async(executor)=>{assert.ok(executor,'catalog must stay transaction-bound');txCatalogReads++;const repository=createOrganizationPersonnelRepository(executor);return{roles:await ctx.getPortalRoles(repository),locations:await ctx.getLocations(false,repository)};}});
 try{
  f.database.exec("INSERT INTO portal_roles(id,name,permissions)VALUES('hr','Personalleitung','[\"rights:read\",\"processes:write\"]'); INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at)VALUES('actual-session','BEISPIEL-A','synthetic-token',strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+8 hours'))");
  const current=async(executor)=>{const repository=createPortalAccessRepository(executor||f.provider),record=await repository.getEmployeeSessionByToken({tokenHash:'synthetic-token',now:new Date().toISOString(),businessDate:'2026-10-11'});assert.equal(record.id,'actual-session');assert.equal(record.employee_number,'BEISPIEL-A');assert.equal(record.role,'hr');if(executor){txSessionReads++;if(throwAfterWrite&&(await createCustomProcessManagementRepository(executor).listWorkflowPublications({includeArchived:1})).length)throw Error('actual session revoked at transactional publication boundary');}};
  const context={...f.context,actorId:'BEISPIEL-A',actorRole:'hr',actorBinding:'actual-session',current};
  await f.service.readCatalog(context);const d=(await f.service.save(null,input(),context)).definition;const proof=await f.service.review(d.id,{revision:1,snapshotSha256:d.snapshotSha256},context);
  throwAfterWrite=true;await assert.rejects(f.service.publish(d.id,{revision:1,snapshotSha256:d.snapshotSha256,reviewToken:proof.reviewToken},context),/actual session revoked/);assert.equal(f.database.prepare('SELECT COUNT(*) n FROM custom_process_publications').get().n,0);throwAfterWrite=false;
  const p=(await f.service.publish(d.id,{revision:1,snapshotSha256:d.snapshotSha256,reviewToken:proof.reviewToken},context)).publication;const run=(await f.service.start({publicationId:p.id,snapshotSha256:d.snapshotSha256,scope:d.scope,operationId:require('node:crypto').randomUUID()},context)).instance;
  await f.service.readPublication(p.id,context);await f.service.readInstance(run.id,context);const tasks=await f.service.tasks(context);assert.equal(tasks.items[0].studioWorkflow,true);assert.equal(tasks.items[0].runId,run.id);await f.service.complete(run.id,run.steps[0].id,{action:'complete',operationId:require('node:crypto').randomUUID(),note:''},context);assert.equal((await f.service.listInstances({},context)).items[0].status,'resolved');await f.service.archivePublication(p.id,{reason:'Verwendung beendet',snapshotSha256:d.snapshotSha256},context);assert.ok(txSessionReads>=18);assert.ok(txCatalogReads>=8);
 }finally{await f.close();}
});
