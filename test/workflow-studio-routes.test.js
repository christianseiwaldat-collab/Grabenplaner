"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {registerWorkflowStudioRoutes}=require("../lib/workflow-studio-routes");
test("Studio Katalog-GET benötigt eigene Admin/HR- und rights:read-Autorität, no-store und frische Sitzung; Katalog-POST bleibt gesperrt",async()=>{
 const app=express();let actor={id:1,employeeNumber:'BEISPIEL',role:'hr',active:true,permissions:['rights:read']},late=false,reads=0;
 const requireActor=()=>{if(!actor)throw Object.assign(Error('login required'),{status:401});if(!['developer','it_admin','admin','hr'].includes(actor.role)||!actor.permissions.includes('rights:read'))throw Object.assign(Error('forbidden'),{status:403});return structuredClone(actor);};
 registerWorkflowStudioRoutes(app,{requireActor,refreshActor:async()=>requireActor(),accessFor:()=>({canRead:true}),service:{readCatalog:async({current})=>{reads++;if(late)actor.permissions=[];await current();return{contractVersion:1};}}});app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const url=`http://127.0.0.1:${server.address().port}/api/portal/v1/workflow-studio/catalog`;
 try{let r=await fetch(url);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(reads,1);
  actor.role='manager';r=await fetch(url);assert.equal(r.status,403);assert.equal(reads,1);actor.role='hr';actor.permissions=['personnel:lifecycle:editor:read'];r=await fetch(url);assert.equal(r.status,403);actor.permissions=['rights:read'];r=await fetch(url+'?permission=processes:write');assert.equal(r.status,400);r=await fetch(url,{method:'POST'});assert.equal(r.status,404);late=true;r=await fetch(url);assert.equal(r.status,403);actor=null;r=await fetch(url);assert.equal(r.status,401);
 }finally{await new Promise(r=>server.close(r));}
});
