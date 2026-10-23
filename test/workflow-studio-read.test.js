"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {createWorkflowStudioService,readWorkflowStudioSnapshot}=require("../lib/workflow-studio");
const {createCustomProcessManagementRepository}=require("../lib/persistence/repositories/custom-process-management");
const {SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG}=require("../lib/persistence/sqlite/custom-process-management-catalog");
const {openSqliteApplicationPersistence}=require("../lib/persistence/sqlite/provider");
const {ensureSqliteApplicationSchema}=require("../lib/persistence/sqlite/operations/application-schema");
const {createPersonnelWorkflowPublicationService}=require("../lib/personnel-workflow-publications");
const ID="studio-11111111-1111-4111-8111-111111111111",FOREIGN="studio-22222222-2222-4222-8222-222222222222";
const scope=id=>({type:"location",locationId:id,departmentId:null});
const globalAccess={canRead:true,canManage:true,global:true,canReadScope:()=>true,canAssignUser:()=>true,canPublish:true,canPublishScope:()=>true};
function snapshot(id=ID,revision=1,locationId="A",title="Freigabe einer Warenbestellung"){return{id,revision,title,description:"Ein klar abgegrenzter manueller ERP-Ablauf.",scope:scope(locationId),trigger:{type:"manual"},studio:{contractVersion:1,model:"linear-v1",processTypeLabel:"Einkauf"},steps:[{id:id+"-task",type:"approval",title:"Bestellung prüfen",description:"Menge und Konditionen prüfen.",responsibilityType:"role",responsibilityReference:"hr",conditionType:"always",conditionText:"",notificationChannels:[]},{id:id+"-finish",type:"finish",title:"Vorgang abschließen",description:"",responsibilityType:"system",responsibilityReference:"system",conditionType:"always",conditionText:"",notificationChannels:[]}]};}
async function fixture(){
 const app=openSqliteApplicationPersistence({databasePath:":memory:",catalog:SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG});ensureSqliteApplicationSchema(app.database);
 app.database.exec("INSERT INTO locations(id,name,active)VALUES('A','Filiale Innenstadt',1),('B','Filiale Nord',1),('C','Historische Filiale',0)");
 const repo=createCustomProcessManagementRepository(app.provider),base={roles:[{id:'hr',name:'Personalleitung'}],locations:[{id:'A',name:'Filiale Innenstadt',departments:[]},{id:'B',name:'Filiale Nord',departments:[]},{id:'C',name:'Historische Filiale',active:false,departments:[]}]};
 const service=createWorkflowStudioService(repo,{catalog:async()=>base});
 async function insert(value,status="draft"){
  const p={id:value.id,revision:value.revision-1,title:value.title,symbol:"W",description:value.description,category:"other",scopeType:value.scope.type,locationId:value.scope.locationId,departmentId:null,triggerType:"manual",triggerMinimumShortfall:1,status,actor:"BEISPIEL-HR"};
  if(value.revision===1)await repo.insertProcess(p);else await repo.updateProcess(p);
  await repo.insertProcessRevision({processId:value.id,revision:value.revision,snapshotJson:JSON.stringify(value),actor:"BEISPIEL-HR"});
 }
 async function publish(id=ID){return createPersonnelWorkflowPublicationService(repo).publish(id,{workflowCode:id,workflowType:"custom_personnel",requirementKind:"supplemental",dataClassification:"standard",containsConfidentialSteps:false},{access:globalAccess,actorId:"BEISPIEL-HR"});}
 return{...app,repo,service,base,insert,publish,close:async()=>{await app.provider.close();app.database.close();}};
}
test("Studio-Katalog liest echte bestehende Tabellen transaktional, trennt Legacy und verändert keine Daten",async()=>{
 const f=await fixture();try{await f.insert(snapshot());await f.insert({...snapshot('legacy-example'),title:'Bestehender Notbesetzungsablauf'});const before=f.database.prepare('SELECT COUNT(*) AS n FROM custom_process_revisions').get().n;
 const out=await f.service.readCatalog({access:globalAccess});assert.equal(out.definitions.length,1);assert.equal(out.legacyDefinitions.length,1);assert.equal(out.legacyDefinitions[0].readOnly,true);assert.equal(out.people.length,0);assert.equal(out.locations.length,2);assert.deepEqual(out.capabilities,{canRead:true,canManage:true,canEdit:true,canPublish:true,canStart:true});assert.equal(out.instanceWindow,'open');assert.equal(out.definitions[0].snapshotSha256,crypto.createHash('sha256').update(JSON.stringify(snapshot())).digest('hex'));assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM custom_process_revisions').get().n,before);
 assert.doesNotMatch(JSON.stringify(out),/password|granted_permissions|trigger_key|triggered_by/);
 }finally{await f.close();}
});
test("Scope-Projektion lädt nur freigegebene Definitionen, Standorte und zuordenbare Empfänger",async()=>{
 const f=await fixture();try{await f.insert(snapshot());await f.insert(snapshot(FOREIGN,1,'B','Fremde Vorlage'));const access={...globalAccess,global:false,canManage:false,canReadScope:s=>s.locationId==='A',canAssignUser:(u,s)=>u.home_location_id===s.locationId};const out=await f.service.readCatalog({access});assert.deepEqual(out.definitions.map(d=>d.id),[ID]);assert.deepEqual(out.locations.map(l=>l.id),['A']);assert.equal(out.scopes.some(s=>s.type==='company'),false);assert.doesNotMatch(JSON.stringify(out),/Fremde Vorlage|Filiale Nord/);}finally{await f.close();}
});
test("Veröffentlichung und offene Instanz behalten ihre eingefrorene Revision nach Änderung des aktuellen Entwurfs/Scopes",async()=>{
 const f=await fixture();try{await f.insert(snapshot());await f.publish();
  await f.repo.insertRun({id:'run-example',processId:ID,processRevision:1,triggerType:'manual_studio',triggerKey:'example',locationId:'A',departmentId:null,triggeredBy:'BEISPIEL-HR'});
  await f.repo.insertRunStep({runId:'run-example',stepId:ID+'-task',sortOrder:0});await f.repo.activateRunStep({runId:'run-example',stepId:ID+'-task'});
  await f.insert(snapshot(ID,2,'B','Später geänderte Vorlage'));
  const out=await f.service.readCatalog({access:{...globalAccess,global:false,canReadScope:s=>s.locationId==='A'}});
  assert.equal(out.definitions.length,0);assert.equal(out.publications.length,1);assert.equal(out.publications[0].sourceRevision,1);assert.equal(out.instances.length,1);assert.equal(out.instances[0].title,'Freigabe einer Warenbestellung');assert.equal(out.instances[0].sourceRevision,1);assert.equal(out.instances[0].activeStep.title,'Bestellung prüfen');assert.equal(out.instances[0].scope.locationId,'A');
 }finally{await f.close();}
});
test("Katalog verweigert manipulierte Studio-Metadaten/Benachrichtigung und nach dem Lesen widerrufene Autorität",async()=>{
 const f=await fixture();try{const value=snapshot();value.steps[0].notificationChannels=['email'];await f.insert(value);await assert.rejects(f.service.readCatalog({access:globalAccess}),e=>e.code==='WORKFLOW_STUDIO_INTEGRITY');await assert.rejects(f.service.readCatalog({access:{canRead:false}}),e=>e.status===403);
 const good={...value,steps:snapshot().steps};assert.equal(readWorkflowStudioSnapshot({process_id:ID,revision:1,snapshot_json:JSON.stringify(good)}).snapshot.id,ID);
 }finally{await f.close();}
 const g=await fixture();try{await g.insert(snapshot());let checks=0;await assert.rejects(g.service.readCatalog({access:globalAccess,current:async()=>{if(++checks===2)throw Error('scope revoked');}}),/scope revoked/);assert.equal(checks,2);}finally{await g.close();}
});
