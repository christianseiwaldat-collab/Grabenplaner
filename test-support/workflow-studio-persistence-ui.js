"use strict";
const UI=require('./workflow-studio-ui');
const {fixture}=require('./workflow-studio-service');
async function prepare(page,{dark=false}={}){
 await page.route('http://127.0.0.1/__studio-example',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'}));
 await page.goto('http://127.0.0.1/__studio-example');
 const service=fixture();service.context.actorId='BEISPIEL-A';service.context.actorRole='hr';
 await page.exposeFunction('syntheticStudioPersistence',async({url,method,body})=>{
  try{
   const tail=url.slice('/api/portal/v1/workflow-studio/'.length),context=service.context;
   let value;
   if(tail==='instances'&&method==='POST')value=await service.service.start(body,context);
   else if(tail==='instances'&&method==='GET')value=await service.service.listInstances({},context);
   else if(tail.startsWith('instances?cursor=')&&method==='GET')value=await service.service.listInstances({cursor:decodeURIComponent(tail.slice('instances?cursor='.length))},context);
   else if(tail.match(/^publications\/[^/]+$/)&&method==='GET')value=await service.service.readPublication(tail.split('/')[1],context);
   else if(tail.match(/^publications\/[^/]+\/archive$/)&&method==='POST')value=await service.service.archivePublication(tail.split('/')[1],body,context);
   else if(tail.match(/^instances\/[^/]+$/)&&method==='GET')value=await service.service.readInstance(tail.split('/')[1],context);
   else if(tail.match(/^instances\/[^/]+\/steps\/[^/]+\/complete$/)&&method==='POST')value=await service.service.complete(tail.split('/')[1],decodeURIComponent(tail.split('/')[3]),body,{...context,actorId:'BEISPIEL-A',actorRole:'hr'});
   else if(tail==='catalog'&&method==='GET')value=await service.service.readCatalog(context);
   else if(tail==='definitions'&&method==='POST')value=await service.service.save(null,body,context);
   else{
    const match=tail.match(/^definitions\/(studio-[0-9a-f-]+)(?:\/(review|archive|publish))?$/);
    if(!match)throw Error('Unexpected synthetic Studio request');
    const [,id,action]=match;
    if(action==='publish'&&method==='POST')value=await service.service.publish(id,body,context);
    else if(action==='review'&&method==='POST')value=await service.service.review(id,body,context);
    else if(action==='archive'&&method==='POST')value=await service.service.archive(id,body,context);
    else if(!action&&method==='PUT')value=await service.service.save(id,body,context);
    else if(!action&&method==='GET')value=await service.service.read(id,context);
    else throw Error('Unexpected synthetic Studio method');
   }
   return{value};
  }catch(error){return{error:error.message,status:error.status||500,code:error.code||'SYNTHETIC_ERROR'};}
 });
 const result=await UI.prepare(page,{dark,editors:true});
 await page.evaluate(()=>{
  const baseApi=api;window.studioHolds={};window.studioFailAfter={};window.heldStudio=[];
  window.api=async(url,request={})=>{
   if(!url.startsWith('/api/portal/v1/workflow-studio/'))return baseApi(url,request);
   const method=request.method||'GET',kind=url.endsWith('/catalog')?'catalog':url.endsWith('/review')?'review':url.endsWith('/archive')?'archive':url.endsWith('/publish')?'publish':url.endsWith('/complete')?'complete':url.endsWith('/instances')&&method==='POST'?'start':method==='GET'?'read':'save';
   const body=request.body?JSON.parse(request.body):undefined;apiCalls.push({url,method,body});
   const reply=await syntheticStudioPersistence({url,method,body});
   if(studioHolds[kind])await new Promise(resolve=>heldStudio.push({kind,resolve,signal:request.signal}));
   if(studioFailAfter[kind]){studioFailAfter[kind]--;throw Object.assign(Error('BEISPIEL lost reply after committed operation'),{status:500});}
   if(reply.error)throw Object.assign(Error(reply.error),{status:reply.status,code:reply.code});
   return reply.value;
  };
  workflowStudioWorkspace.destroy();workflowStudioWorkspace=null;syncWorkflowStudio();
 });
 await page.waitForFunction(()=>workflowStudioWorkspace.current().status==='ready'&&workflowStudioWorkspace.current().data.capabilities.canEdit===true);
 return{...result,service,async close(){await service.close();}};
}
module.exports={...UI,prepare};
