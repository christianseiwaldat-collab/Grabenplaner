"use strict";
const {randomUUID,createHash}=require('node:crypto');
const {assertCustomProcessManagementRepository}=require('./persistence/repositories/custom-process-management');
const {WorkflowStudioError,STUDIO_PREFIX,readWorkflowStudioSnapshot,workflowStudioScope}=require('./workflow-studio');
const sha=value=>createHash('sha256').update(String(value)).digest('hex');
const fail=(code,status,message)=>{throw new WorkflowStudioError(code,status,message);};
const invalid=message=>fail('WORKFLOW_STUDIO_INPUT_INVALID',400,message);
function exact(value,keys,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))invalid(label+' enthält nicht unterstützte Angaben.');return value;}
function text(value,max,label,min=0,lines=false){if(typeof value!=='string'||value.length>max||(lines?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value))invalid(label+' ist ungültig.');const out=value.trim();if(out.length<min)invalid(label+' fehlt.');return out;}
function revision(value){if(!Number.isSafeInteger(value)||value<1)invalid('Die gespeicherte Revision fehlt.');return value;}
const conflict=()=>fail('WORKFLOW_STUDIO_REVISION_CONFLICT',409,'Der Entwurf wurde zwischenzeitlich geändert. Bitte die gespeicherte Fassung neu laden oder die lokale Arbeitskopie behalten.');
function inputDraft(value){
 const v=exact(value,['revision','title','description','symbol','category','processTypeLabel','scope','steps'],'Der Entwurf');
 exact(v.scope,['type','locationId','departmentId'],'Der Geltungsbereich');if(v.scope.locationId!==null&&(typeof v.scope.locationId!=='string'||v.scope.locationId.length>80)||v.scope.departmentId!==null&&(!Number.isSafeInteger(v.scope.departmentId)||v.scope.departmentId<1))invalid('Der Geltungsbereich ist ungültig.');let scope;try{scope=workflowStudioScope(v.scope);}catch{invalid('Der Geltungsbereich ist ungültig.');}
 if(!Array.isArray(v.steps)||v.steps.length<2||v.steps.length>30)invalid('Ein Ablauf braucht 2 bis 30 Schritte.');
 const ids=new Set();const steps=v.steps.map((raw,index)=>{
  const s=exact(raw,['id','type','title','description','responsibilityType','responsibilityReference','conditionType','conditionText'],'Der Schritt');const id=text(s.id,80,'Die Schrittkennung',1);
  if(ids.has(id))invalid('Eine Schrittkennung kommt doppelt vor.');ids.add(id);
  if(!['task','approval','finish'].includes(s.type)||!['always','optional'].includes(s.conditionType))invalid('Schrittart oder Verbindlichkeit ist ungültig.');
  if(index===v.steps.length-1){if(s.type!=='finish'||s.responsibilityType!=='system'||s.conditionType!=='always'||s.responsibilityReference!=='')invalid('Der letzte Schritt muss ein erforderlicher Abschluss sein.');}
  else if(s.type==='finish'||!['role','employee'].includes(s.responsibilityType))invalid('Eine Aufgabe oder Freigabe braucht eine Rolle oder Person.');
  return{id,type:s.type,title:text(s.title,120,'Der Schritttitel',1),description:text(s.description,600,'Die Schrittbeschreibung',0,true),responsibilityType:s.responsibilityType,responsibilityReference:text(s.responsibilityReference,80,'Die Verantwortung',s.type==='finish'?0:1),conditionType:s.conditionType,conditionText:text(s.conditionText,600,'Der Ausführungshinweis',0,true),notificationChannels:[]};
 });
 return{title:text(v.title,120,'Der Prozesstitel',1),description:text(v.description,600,'Die Beschreibung',0,true),symbol:text(v.symbol,40,'Das Symbol',1),category:text(v.category,80,'Die Kategorie'),processTypeLabel:text(v.processTypeLabel,80,'Die Prozessart'),scope,steps};
}
function dto(row,value){const s=value.snapshot;return{id:s.id,revision:s.revision,snapshotSha256:value.snapshotSha256,title:s.title,description:s.description,symbol:s.symbol,category:s.category,processTypeLabel:s.studio.processTypeLabel,scope:s.scope,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,steps:s.steps.map(({notificationChannels,responsibilityLabel,sortOrder,...step})=>step)};}
function draftFromSnapshot(s){return{revision:s.revision,title:s.title,description:s.description,symbol:s.symbol,category:s.category,processTypeLabel:s.studio.processTypeLabel,scope:s.scope,steps:s.steps.map(({notificationChannels,responsibilityLabel,sortOrder,...step})=>step)};}
function createWorkflowStudioDraftService(repositoryValue,{catalog,clock=()=>new Date(),createId=randomUUID,vault=null}={}){
 const repository=assertCustomProcessManagementRepository(repositoryValue);
 const context={namespace:'workflow-studio',connectorId:'saved-revision-review',field:'review',purpose:'explicit-publication'};
 function authority(access,manage=false){if(access?.canRead!==true||typeof access.canReadScope!=='function'||manage&&access.canManage!==true)fail('WORKFLOW_STUDIO_FORBIDDEN',403,'Für diese Workflow-Aktion fehlt die Berechtigung.');}
 async function scoped(repo,scope,access){if(!access.canReadScope(scope))fail('WORKFLOW_STUDIO_SCOPE_DENIED',403,'Der Workflow liegt außerhalb des freigegebenen Bereichs.');if(!(await repo.scopeIsActive(scope))?.active)fail('WORKFLOW_STUDIO_SCOPE_INACTIVE',409,'Der Geltungsbereich ist nicht mehr aktiv.');}
 async function saved(repo,id,access,expected=null){
  if(!STUDIO_PREFIX.test(id))fail('WORKFLOW_STUDIO_NOT_FOUND',404,'Der Studio-Entwurf wurde nicht gefunden.');
  const row=await repo.processById({id,includeArchived:1});if(!row)fail('WORKFLOW_STUDIO_NOT_FOUND',404,'Der Studio-Entwurf wurde nicht gefunden.');
  await scoped(repo,workflowStudioScope({type:row.scope_type,locationId:row.location_id,departmentId:row.department_id}),access);
  if(expected&&Number(row.revision)!==expected)conflict();const revisionRow=await repo.processRevision({processId:id,revision:Number(row.revision)}),value=readWorkflowStudioSnapshot(revisionRow);
  if(value.snapshot.revision!==Number(row.revision)||JSON.stringify(value.scope)!==JSON.stringify(workflowStudioScope({type:row.scope_type,locationId:row.location_id,departmentId:row.department_id}))||row.trigger_type!=='manual')fail('WORKFLOW_STUDIO_INTEGRITY',409,'Die gespeicherte Fassung ist widersprüchlich.');
  return{row,value};
 }
 async function normalized(repo,input,id,old,access,executor){
  const draft=inputDraft(input);await scoped(repo,draft.scope,access);const base=await catalog(executor);const roles=new Map((base.roles||[]).filter(r=>r.active!==false).map(r=>[String(r.id),r]));
  const oldIds=new Set(old?.steps.map(s=>s.id)||[]),mapping={};
  for(const s of draft.steps){
   const submitted=s.id;
   if(oldIds.has(submitted)){}else if(/^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submitted)){s.id=id+':'+createId();}else invalid('Die Schrittkennung gehört nicht zur aktuellen Arbeitskopie.');
   mapping[submitted]=s.id;
   if(s.responsibilityType==='role'){const role=roles.get(s.responsibilityReference);if(!role)invalid('Die zuständige Rolle ist nicht aktiv.');s.responsibilityLabel=String(role.name);}
   else if(s.responsibilityType==='employee'){const person=await repo.responsibilityCandidate({employeeNumber:s.responsibilityReference});if(!person||!roles.has(String(person.role))||typeof access.canAssignUser!=='function'||!access.canAssignUser(person,draft.scope))invalid('Die zuständige Person hat keinen aktiven Zugang im gewählten Bereich.');s.responsibilityLabel=String(person.full_name||person.employee_number);}
   else s.responsibilityLabel='Grabenplaner';
  }
  if(await repo.conflictingStep({processId:id,stepIds:draft.steps.map(s=>s.id)}))invalid('Eine Schrittkennung gehört zu einem anderen Ablauf.');
  return{draft,mapping};
 }
 async function snapshot(repo,row,draft,actor){
  const value={id:row.id,revision:Number(row.revision),status:row.status,title:draft.title,description:draft.description,symbol:draft.symbol,category:draft.category,scope:draft.scope,trigger:{type:'manual',minimumShortfall:1},studio:{contractVersion:1,model:'linear-v1',processTypeLabel:draft.processTypeLabel},steps:draft.steps.map((s,i)=>({...s,sortOrder:i})),createdAt:row.created_at,updatedAt:row.updated_at,createdBy:row.created_by,updatedBy:row.updated_by};
  const encoded=JSON.stringify(value);await repo.insertProcessRevision({processId:row.id,revision:Number(row.revision),snapshotJson:encoded,actor});
  const stored=await repo.processRevision({processId:row.id,revision:Number(row.revision)});if(stored?.snapshot_json!==encoded)fail('WORKFLOW_STUDIO_INTEGRITY',409,'Die Revision konnte nicht unveränderlich gespeichert werden.');
  return readWorkflowStudioSnapshot(stored);
 }
 async function audit(repo,actor,action,id,rev,hash){await repo.insertAudit({actor,action:'workflow-studio.'+action,entityType:'custom_process',entityId:id,detail:JSON.stringify({revision:rev,snapshotSha256:hash})});}
 async function save(idValue,input,{access,actorId,current=async()=>{}}={}){
  authority(access,true);const actor=text(actorId,80,'Die handelnde Person',1),id=idValue||'studio-'+createId();if(idValue)revision(input?.revision);else if(input?.revision!==undefined&&input.revision!==0)invalid('Ein neuer Entwurf hat noch keine Revision.');await current();
  return repository.transaction(async (repo,executor)=>{
   await current(executor);const old=idValue?await saved(repo,id,access,input.revision):null;if(old?.row.status==='archived')conflict();
   const {draft,mapping}=await normalized(repo,input,id,old?.value.snapshot,access,executor);
   const params={id,revision:input.revision,title:draft.title,description:draft.description,symbol:draft.symbol,category:'other',scopeType:draft.scope.type,locationId:draft.scope.locationId,departmentId:draft.scope.departmentId,triggerType:'manual',triggerMinimumShortfall:1,status:'draft',actor};
   if(old){const r=await repo.updateProcess(params);if(r.rowsAffected!==1)conflict();await repo.deleteProcessSteps({processId:id});}else{const r=await repo.insertProcess(params);if(r.rowsAffected!==1)fail('WORKFLOW_STUDIO_INTEGRITY',409,'Der Entwurf wurde nicht angelegt.');}
   for(const [index,s]of draft.steps.entries())await repo.insertProcessStep({...s,type:s.type==='task'?'actor':s.type,processId:id,sortOrder:index,notificationChannels:'[]'});
   const row=await repo.processById({id,includeArchived:1}),value=await snapshot(repo,row,draft,actor);await audit(repo,actor,'save',id,Number(row.revision),value.snapshotSha256);await current(executor);
   return{definition:dto(row,value),stepIdMap:mapping};
  },{isolation:'serializable'});
 }
 async function read(id,{access,sourceRevision=null,current=async()=>{}}={}){authority(access);if(sourceRevision!==null)revision(sourceRevision);await current();const out=await repository.transaction(async (repo,executor)=>{const {row,value}=await saved(repo,id,access);let selected=value;if(sourceRevision!==null){if(sourceRevision>Number(row.revision))fail('WORKFLOW_STUDIO_NOT_FOUND',404,'Die gespeicherte Revision wurde nicht gefunden.');selected=readWorkflowStudioSnapshot(await repo.processRevision({processId:id,revision:sourceRevision}));await scoped(repo,selected.scope,access);}await current(executor);return{definition:dto({...row,status:selected.snapshot.status||row.status,created_at:selected.snapshot.createdAt||row.created_at,updated_at:selected.snapshot.updatedAt||row.updated_at},selected)};},{readOnly:true,isolation:'serializable'});await current();return out;}
 async function archive(id,input,{access,actorId,current=async()=>{}}={}){
  authority(access,true);exact(input,['revision'],'Die Archivierung');revision(input.revision);const actor=text(actorId,80,'Die handelnde Person',1);await current();return repository.transaction(async (repo,executor)=>{await current(executor);const old=await saved(repo,id,access,input.revision);if(old.row.status==='archived')conflict();const result=await repo.setProcessStatus({id,revision:input.revision,status:'archived',actor});if(result.rowsAffected!==1)conflict();const row=await repo.processById({id,includeArchived:1}),draft=inputDraft(draftFromSnapshot(old.value.snapshot));draft.steps=old.value.snapshot.steps;const value=await snapshot(repo,row,draft,actor);await audit(repo,actor,'archive',id,Number(row.revision),value.snapshotSha256);await current(executor);return{definition:dto(row,value)};},{isolation:'serializable'});
 }
 function verifyReview(token,actorBinding,value){
  if(!vault)fail('WORKFLOW_STUDIO_REVIEW_UNAVAILABLE',503,'Die geschützte Entwurfsprüfung ist derzeit nicht verfügbar.');if(typeof actorBinding!=='string'||!actorBinding)fail('WORKFLOW_STUDIO_REVIEW_INVALID',409,'Die Sitzung der Entwurfsprüfung fehlt.');let proof;
  try{vault.useSecretSync(token,context,b=>{proof=JSON.parse(b.toString('utf8'));});}catch{fail('WORKFLOW_STUDIO_REVIEW_INVALID',409,'Die Entwurfsprüfung ist ungültig. Bitte erneut prüfen.');}
  const now=clock().getTime();if(proof?.contractVersion!==1||proof.model!=='linear-v1'||proof.actorBinding!==sha(actorBinding)||proof.processId!==value.snapshot.id||proof.revision!==value.snapshot.revision||proof.snapshotSha256!==value.snapshotSha256||JSON.stringify(proof.scope)!==JSON.stringify(value.scope)||!Number.isSafeInteger(proof.issuedAt)||!Number.isSafeInteger(proof.expiresAt)||proof.issuedAt>now||proof.expiresAt<=now||proof.expiresAt-proof.issuedAt!==600000)fail('WORKFLOW_STUDIO_REVIEW_INVALID',409,'Die Entwurfsprüfung ist abgelaufen oder gehört zu einer anderen Fassung/Sitzung.');return proof;
 }
 async function review(id,input,{access,actorId,actorBinding,current=async()=>{}}={}){
  authority(access,true);exact(input,['revision','snapshotSha256'],'Die Entwurfsprüfung');revision(input.revision);if(!/^[0-9a-f]{64}$/.test(input.snapshotSha256))invalid('Der Prüffingerabdruck fehlt.');text(actorId,80,'Die handelnde Person',1);if(typeof actorBinding!=='string'||!actorBinding)invalid('Die Sitzungsbindung fehlt.');if(!vault)fail('WORKFLOW_STUDIO_REVIEW_UNAVAILABLE',503,'Die geschützte Entwurfsprüfung ist derzeit nicht verfügbar.');await current();return repository.transaction(async (repo,executor)=>{await current(executor);const {row,value}=await saved(repo,id,access,input.revision);if(row.status==='archived'||value.snapshotSha256!==input.snapshotSha256)conflict();await normalized(repo,draftFromSnapshot(value.snapshot),id,value.snapshot,access,executor);const issuedAt=clock().getTime(),proof={contractVersion:1,model:'linear-v1',processId:id,revision:input.revision,snapshotSha256:value.snapshotSha256,scope:value.scope,actorBinding:sha(actorBinding),issuedAt,expiresAt:issuedAt+600000},token=vault.seal(JSON.stringify(proof),context);await audit(repo,actorId,'review',id,input.revision,value.snapshotSha256);await current(executor);return{processId:id,revision:input.revision,snapshotSha256:value.snapshotSha256,reviewToken:token,expiresAt:new Date(proof.expiresAt).toISOString(),ready:true};},{isolation:'serializable'});
 }
 const guarded=fn=>async(...args)=>{try{return await fn(...args);}catch(error){if(['PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY'].includes(error.code))conflict();throw error;}};
 return Object.freeze({save:guarded(save),read:guarded(read),archive:guarded(archive),review:guarded(review),verifyReview});
}
module.exports={createWorkflowStudioDraftService,inputDraft,draftFromSnapshot};
