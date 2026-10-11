"use strict";

const {createHash}=require("node:crypto");
const {assertCustomProcessManagementRepository}=require("./persistence/repositories/custom-process-management");
const {verifyPersonnelWorkflowPublication}=require("./personnel-workflow-publications");
const STUDIO_PREFIX=/^studio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class WorkflowStudioError extends Error {
  constructor(code,status,message){super(message);this.name="WorkflowStudioError";this.code=code;this.status=status;}
}
const fail=(code="WORKFLOW_STUDIO_INTEGRITY",status=409,message="Der gespeicherte Workflow ist nicht widerspruchsfrei.")=>{throw new WorkflowStudioError(code,status,message);};
const sha256=value=>createHash("sha256").update(String(value)).digest("hex");
function workflowStudioScope(value){
  const type=value?.type,locationId=String(value?.locationId||"")||null,departmentId=Number(value?.departmentId||0)||null;
  if(type==="company"&&!locationId&&!departmentId)return{type,locationId:null,departmentId:null};
  if(type==="location"&&locationId&&!departmentId)return{type,locationId,departmentId:null};
  if(type==="department"&&locationId&&Number.isSafeInteger(departmentId)&&departmentId>0)return{type,locationId,departmentId};
  fail();
}
function rowScope(row){return workflowStudioScope({type:row.scope_type,locationId:row.location_id,departmentId:row.department_id});}
function sameScope(a,b){return a.type===b.type&&a.locationId===b.locationId&&a.departmentId===b.departmentId;}
function readWorkflowStudioSnapshot(row){
  if(!row)fail();
  let snapshot;try{snapshot=JSON.parse(row?.snapshot_json);}catch{fail();}
  if(!snapshot||snapshot.id!==row.process_id||Number(snapshot.revision)!==Number(row.revision||row.source_revision)
    ||!STUDIO_PREFIX.test(snapshot.id)||snapshot.studio?.contractVersion!==1||snapshot.studio?.model!=="linear-v1"
    ||typeof snapshot.studio.processTypeLabel!=="string"||snapshot.studio.processTypeLabel.length>80
    ||typeof snapshot.title!=="string"||snapshot.title.length>120||typeof snapshot.description!=="string"||snapshot.description.length>600
    ||snapshot.trigger?.type!=="manual"||!Array.isArray(snapshot.steps)||snapshot.steps.length<2||snapshot.steps.length>30)fail();
  const ids=new Set();
  for(const [index,step]of snapshot.steps.entries()){
    if(!step||typeof step.id!=="string"||ids.has(step.id)||!['task','approval','finish'].includes(step.type)
      ||typeof step.title!=="string"||step.title.length>120||typeof step.description!=="string"||step.description.length>600
      ||!['always','optional'].includes(step.conditionType)||!Array.isArray(step.notificationChannels)||step.notificationChannels.length)fail();
    if(index===snapshot.steps.length-1){if(step.type!=="finish"||step.responsibilityType!=="system"||step.conditionType!=="always")fail();}
    else if(step.type==="finish"||!['role','employee'].includes(step.responsibilityType)||typeof step.responsibilityReference!=="string")fail();
    ids.add(step.id);
  }
  return{snapshot,scope:workflowStudioScope(snapshot.scope),snapshotSha256:sha256(row.snapshot_json)};
}
function createWorkflowStudioService(repositoryValue,{catalog=async()=>({roles:[],locations:[]}),clock=()=>new Date()}={}){
  const repository=assertCustomProcessManagementRepository(repositoryValue);
  async function readCatalog({access,current=async()=>{}}={}){
    if(access?.canRead!==true||typeof access.canReadScope!=="function"||typeof access.canAssignUser!=="function")fail("WORKFLOW_STUDIO_FORBIDDEN",403,"Für das Workflow-Studio fehlt das Leserecht.");
    await current();
    const result=await repository.transaction(async (repo,executor)=>{
      const [rows,publishedRows,runs,base,recipientRows]=await Promise.all([
        repo.listProcesses({includeArchived:1}),repo.listWorkflowPublications({includeArchived:1}),repo.listOpenRuns(),catalog(executor),repo.listRecipientCandidates(),
      ]);
      if(rows.length>2000||publishedRows.length>10000||runs.length>10000)fail("WORKFLOW_STUDIO_CATALOG_LIMIT",503,"Der Workflow-Katalog ist für diese Übersicht zu groß.");
      const visibleScope=scope=>access.canReadScope(scope)===true;
      const scopeLabels=new Map([["company","Unternehmen"]]);
      const locations=(base.locations||[]).filter(l=>l.active!==false).map(l=>({id:String(l.id),name:String(l.name),departments:(l.departments||[]).filter(d=>d.active!==false&&visibleScope({type:"department",locationId:String(l.id),departmentId:Number(d.id)})).map(d=>({id:Number(d.id),name:String(d.name)}))})).filter(l=>visibleScope({type:"location",locationId:l.id,departmentId:null})||l.departments.length);
      for(const l of locations){scopeLabels.set(`location:${l.id}`,l.name);for(const d of l.departments)scopeLabels.set(`department:${l.id}:${d.id}`,`${l.name} · ${d.name}`);}
      const label=scope=>scopeLabels.get(scope.type==="company"?"company":`${scope.type}:${scope.locationId}${scope.type==="department"?':'+scope.departmentId:''}`)||"Freigegebener Bereich";
      const roles=(base.roles||[]).filter(r=>r.active!==false).map(r=>({id:String(r.id),name:String(r.name)}));
      const scopes=[...(access.global?[{type:"company",locationId:null,departmentId:null,label:"Unternehmen"}]:[])];
      for(const l of locations){const scope={type:"location",locationId:l.id,departmentId:null};if(visibleScope(scope))scopes.push({...scope,label:label(scope)});for(const d of l.departments)scopes.push({type:"department",locationId:l.id,departmentId:d.id,label:`${l.name} · ${d.name}`});}
      const roleIds=new Set(roles.map(r=>r.id));
      const people=recipientRows.filter(u=>roleIds.has(String(u.role))&&scopes.some(scope=>access.canAssignUser(u,scope)===true)).map(u=>({employeeNumber:String(u.employee_number),fullName:String(u.full_name||u.employee_number),role:String(u.role)}));
      const definitions=[],legacyDefinitions=[];
      for(const row of rows){
        const scope=rowScope(row);if(!visibleScope(scope))continue;
        if(!await repo.scopeIsActive(scope).then(v=>Boolean(v?.active)))continue;
        if(String(row.id).startsWith("studio-")){
          const revision=await repo.processRevision({processId:row.id,revision:Number(row.revision)}),value=readWorkflowStudioSnapshot(revision);
          if(!sameScope(scope,value.scope)||value.snapshot.id!==row.id||value.snapshot.revision!==Number(row.revision))fail();
          definitions.push({id:row.id,revision:Number(row.revision),title:value.snapshot.title,description:value.snapshot.description,symbol:value.snapshot.symbol||"workflow",category:value.snapshot.category||"",processTypeLabel:value.snapshot.studio.processTypeLabel,status:row.status,scope:{...scope,label:label(scope)},snapshotSha256:value.snapshotSha256,steps:value.snapshot.steps.map(s=>({id:s.id,type:s.type,title:s.title,description:s.description,responsibilityType:s.responsibilityType,responsibilityReference:s.responsibilityReference,conditionType:s.conditionType,conditionText:String(s.conditionText||"")})),updatedAt:row.updated_at});
        }else if(row.status!=="archived"||access.canManage){
          legacyDefinitions.push({id:row.id,revision:Number(row.revision||1),title:String(row.title),description:String(row.description||""),status:row.status,scope:{...scope,label:label(scope)},source:"existing",readOnly:true});
        }
      }
      const publications=[],publicationByRevision=new Map();
      for(const row of publishedRows){
        if(!String(row.process_id).startsWith("studio-")||!visibleScope(rowScope(row)))continue;
        const verified=verifyPersonnelWorkflowPublication(row),value=readWorkflowStudioSnapshot(row);
        if(!visibleScope(value.scope))continue;
        const revision=await repo.processRevision({processId:row.process_id,revision:Number(row.source_revision)});
        if(!revision||sha256(revision.snapshot_json)!==row.snapshot_sha256||!sameScope(value.scope,verified.scope)||row.workflow_type!=="custom_personnel")fail();
        const item={id:row.id,processId:row.process_id,sourceRevision:Number(row.source_revision),versionNumber:Number(row.version_number),title:value.snapshot.title,scope:{...value.scope,label:label(value.scope)},snapshotSha256:row.snapshot_sha256,archived:Boolean(row.archived_at),publishedAt:row.published_at};
        const key=`${item.processId}:${item.sourceRevision}`;if(publicationByRevision.has(key))fail();publicationByRevision.set(key,{item,snapshot:value.snapshot});publications.push(item);
      }
      const instances=[];
      for(const run of runs){
        if(run.trigger_type!=="manual_studio")continue;
        const scope=run.location_id?workflowStudioScope({type:run.department_id?"department":"location",locationId:run.location_id,departmentId:run.department_id}):workflowStudioScope({type:"company"});
        if(!visibleScope(scope))continue;
        const publication=publicationByRevision.get(`${run.process_id}:${run.process_revision}`);if(!publication)fail();
        const frozen=workflowStudioScope(publication.snapshot.scope);
        if(frozen.type!=="company"&&(scope.locationId!==frozen.locationId||(frozen.type==="department"&&scope.departmentId!==frozen.departmentId)))fail();
        const active=await repo.activeRunStep({runId:run.id}),index=publication.snapshot.steps.findIndex(s=>s.id===active?.step_id);
        if(index<0)fail();
        instances.push({id:run.id,processId:run.process_id,sourceRevision:Number(run.process_revision),publicationId:publication.item.id,versionNumber:publication.item.versionNumber,snapshotSha256:publication.item.snapshotSha256,title:publication.snapshot.title,status:"open",scope:{...scope,label:label(scope)},activeStep:{title:publication.snapshot.steps[index].title,position:index+1,total:publication.snapshot.steps.length},createdAt:run.created_at});
      }
      return{contractVersion:1,model:"linear-v1",capabilities:{canRead:true,canManage:access.canManage===true,canEdit:access.canManage===true,canPublish:access.canManage===true,canStart:access.canManage===true},roles,locations,scopes,people,definitions,legacyDefinitions,publications,instances,instanceWindow:"open",generatedAt:clock().toISOString()};
    },{readOnly:true,isolation:"serializable"});
    await current();return result;
  }
  return Object.freeze({readCatalog});
}
module.exports={WorkflowStudioError,createWorkflowStudioService,readWorkflowStudioSnapshot,workflowStudioScope,STUDIO_PREFIX};
