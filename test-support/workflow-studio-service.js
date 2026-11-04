"use strict";
const {randomUUID}=require('node:crypto');
const {createCustomProcessManagementRepository}=require('../lib/persistence/repositories/custom-process-management');
const {SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG}=require('../lib/persistence/sqlite/custom-process-management-catalog');
const {openSqliteApplicationPersistence}=require('../lib/persistence/sqlite/provider');
const {ensureSqliteApplicationSchema}=require('../lib/persistence/sqlite/operations/application-schema');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {createWorkflowStudioService}=require('../lib/workflow-studio');
const {createWorkflowStudioDraftService}=require('../lib/workflow-studio-drafts');
const Editor=require('../public/workflow-studio-editor');
const access={canRead:true,canManage:true,global:true,canReadScope:()=>true,canAssignUser:(u,s)=>s.type==='company'||u.home_location_id===s.locationId};
function fixture(options={}){
 const app=openSqliteApplicationPersistence({databasePath:':memory:',catalog:[...SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,...require('../lib/persistence/sqlite/workflow-studio-catalog').CATALOG,...(options.persistenceCatalog||[])]});ensureSqliteApplicationSchema(app.database);
 app.database.exec("INSERT INTO locations(id,name,active)VALUES('A','Filiale Innenstadt',1),('B','Filiale Nord',1),('C','Historischer Standort',0); INSERT INTO employees(personnel_number,full_name,nickname,home_location_id)VALUES('BEISPIEL-A','Alexandra Beispiel','Alex','A'); INSERT INTO portal_users(employee_number,password_hash,role,active)VALUES('BEISPIEL-A','synthetic-hash','hr',1)");
 const repo=createCustomProcessManagementRepository(app.provider),base={roles:[{id:'hr',name:'Personalleitung'}],locations:[{id:'A',name:'Filiale Innenstadt',departments:[]},{id:'B',name:'Filiale Nord',departments:[]},{id:'C',name:'Historischer Standort',active:false,departments:[]}]};let now=new Date();
 const config={catalog:async()=>base,clock:()=>now,vault:createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,7)}}),...options};
 const drafts=createWorkflowStudioDraftService(repo,config),service={...createWorkflowStudioService(repo,config),...drafts,...require('../lib/workflow-studio-instances').createWorkflowStudioInstanceService(repo,{...config,drafts})};
 return{...app,repo,service,base,config,access,context:{access,actorId:'BEISPIEL-MANAGER',actorBinding:'session-synthetic-1'},setNow:date=>{now=new Date(date);},async close(){await app.provider.close();app.database.close();}};
}
function input(){const d=Editor.createDraft(null,{type:'company',locationId:null,departmentId:null},randomUUID);d.title='Beschaffung im Team';d.description='Erste Zeile\nZweite Zeile';d.category='Waren für die Filiale';d.processTypeLabel='Einkauf';d.steps[0].title='Bestellung prüfen';d.steps[0].description='Dokumentation\nmit mehreren Zeilen';d.steps[0].responsibilityReference='hr';return{revision:0,title:d.title,description:d.description,symbol:d.symbol,category:d.category,processTypeLabel:d.processTypeLabel,scope:d.scope,steps:d.steps};}
function payload(d){const{id,status,snapshotSha256,createdAt,updatedAt,...data}=d;return data;}
module.exports={fixture,input,payload,access};
