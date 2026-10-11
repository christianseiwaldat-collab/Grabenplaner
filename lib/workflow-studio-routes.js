"use strict";
const {WorkflowStudioError}=require("./workflow-studio");
const identity=actor=>JSON.stringify([actor?.id,actor?.employeeNumber,actor?.accountId,actor?.sessionKind,actor?.role,actor?.active,actor?.mustChangePassword,actor?.permissions,actor?.scopes,actor?.permissionScopes]);
function registerWorkflowStudioRoutes(app,{service,requireActor,refreshActor,accessFor}){
  function route(permission,work,queries=[]){return async(request,response)=>{
    response.set("Cache-Control","private, no-store");
    try{
      const initial=requireActor(request,permission),actor=await refreshActor(request,initial,permission),owner=identity(actor);
      if(owner!==identity(initial))throw new WorkflowStudioError("WORKFLOW_STUDIO_SESSION_CHANGED",403,"Der Workflow-Zugriff hat sich geändert.");
      if(Object.keys(request.query).some(k=>!queries.includes(k)))throw new WorkflowStudioError("WORKFLOW_STUDIO_QUERY_INVALID",400,"Diese Ansicht akzeptiert keine zusätzlichen Parameter.");
      const current=async(executor)=>{const fresh=await refreshActor(request,actor,permission,executor);if(identity(fresh)!==owner)throw new WorkflowStudioError("WORKFLOW_STUDIO_SESSION_CHANGED",403,"Der Workflow-Zugriff hat sich geändert.");};
      const result=await work(request,{access:accessFor(actor),actorId:actor.employeeNumber,actorRole:actor.role,actorBinding:owner,current});
      await current();if(result?.replayed===true)response.set('Idempotency-Replayed','true');response.json(result);
    }catch(error){if(error instanceof WorkflowStudioError)response.status(error.status).json({error:error.message,code:error.code});else throw error;}
  };}
  const prefix='/api/portal/v1/workflow-studio';
  app.get(prefix+'/catalog',route('rights:read',(_r,context)=>service.readCatalog(context)));
  app.get(prefix+'/definitions/:id',route('rights:read',(r,context)=>service.read(r.params.id,context)));
  app.get(prefix+'/definitions/:id/revisions/:revision',route('rights:read',(r,context)=>service.read(r.params.id,{...context,sourceRevision:Number(r.params.revision)})));
  app.post(prefix+'/definitions',route('processes:write',(r,context)=>service.save(null,r.body,context)));
  app.put(prefix+'/definitions/:id',route('processes:write',(r,context)=>service.save(r.params.id,r.body,context)));
  app.post(prefix+'/definitions/:id/archive',route('processes:write',(r,context)=>service.archive(r.params.id,r.body,context)));
  app.post(prefix+'/definitions/:id/review',route('processes:write',(r,context)=>service.review(r.params.id,r.body,context)));
  app.post(prefix+'/definitions/:id/publish',route('processes:write',(r,context)=>service.publish(r.params.id,r.body,context)));
  app.get(prefix+'/publications/:id',route('rights:read',(r,context)=>service.readPublication(r.params.id,context)));
  app.post(prefix+'/publications/:id/archive',route('processes:write',(r,context)=>service.archivePublication(r.params.id,r.body,context)));
  app.post(prefix+'/instances',route('processes:write',(r,context)=>service.start(r.body,context)));
  app.get(prefix+'/instances',route('rights:read',(r,context)=>service.listInstances(r.query,context),['cursor']));
  app.get(prefix+'/instances/:id',route('rights:read',(r,context)=>service.readInstance(r.params.id,context)));
  app.post(prefix+'/instances/:id/steps/:stepId/complete',route('rights:read',(r,context)=>service.complete(r.params.id,r.params.stepId,r.body,context)));
}
module.exports={registerWorkflowStudioRoutes,identity};
