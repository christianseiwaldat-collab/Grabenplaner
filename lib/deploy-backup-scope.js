"use strict";
const crypto=require('node:crypto');
const KEY='deploy_backup_scope',FORMAT='grabenplaner-deploy-backup-scope-v1';
const SCOPES=Object.freeze(['full','deploy-owned']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function read(raw){
 if(raw===undefined||raw===null||raw==='')return {scope:'full',revision:'0',valid:true};
 try{
  const value=JSON.parse(raw);
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='format,revision,scope'||value.format!==FORMAT||!SCOPES.includes(value.scope)||typeof value.revision!=='string'||!UUID.test(value.revision))throw new Error();
  return {scope:value.scope,revision:value.revision,valid:true};
 }catch{return {scope:'full',revision:'invalid-'+crypto.createHash('sha256').update(String(raw)).digest('hex'),valid:false};}
}
function validateChange(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expectedRevision,scope'||!SCOPES.includes(body.scope)
  ||typeof body.expectedRevision!=='string'||!(body.expectedRevision==='0'||UUID.test(body.expectedRevision)||/^invalid-[a-f0-9]{64}$/.test(body.expectedRevision)))fail('DEPLOY_BACKUP_SCOPE_INVALID');
 return {scope:body.scope,expectedRevision:body.expectedRevision};
}
function change(raw,body){
 const input=validateChange(body),current=read(raw);
 if(input.expectedRevision!==current.revision)fail('DEPLOY_BACKUP_SCOPE_STALE');
 if(current.valid&&input.scope===current.scope)return {changed:false,value:raw,state:current};
 const value=JSON.stringify({format:FORMAT,scope:input.scope,revision:crypto.randomUUID()});
 return {changed:true,value,state:read(value)};
}
function response(state,{available=true}={}){
 return {scope:state.scope,revision:state.revision,label:state.scope==='deploy-owned'?'GP Core und eigene Inhalte':'Vollständig: GP Core und Sales',appliesTo:'deploy-auto',available,valid:state.valid};
}
// A preference never bypasses the protected full-recovery gates. It selects
// which existing classifier handles automatic updates; explicit CLI wins.
function effectivePolicy(verification,scope){
 if(!['auto','full','deploy-owned'].includes(verification)||!SCOPES.includes(scope))fail('DEPLOY_BACKUP_SCOPE_INVALID');
 return verification==='auto'&&scope==='deploy-owned'?'deploy-owned':verification;
}
module.exports={KEY,FORMAT,SCOPES,read,validateChange,change,response,effectivePolicy};
