'use strict';
const crypto=require('node:crypto'),C=require('./data-import-contract'),{assertPersistenceAccess}=require('./persistence/contract');
const {annotations}=require('./persistence/repositories/trade-annotations'),{loadManagedDataImportProtection}=require('./data-import-managed-protection');
const {assertTemplateContext,assertImageProof,assertCurrentImageGrants,SalesPriceLabelTemplateError}=require('./sales-price-label-template-store');
const Project=require('../public/sales-price-label-project'),Labels=require('../public/sales-price-labels');
const fail=(message,code='PRICE_LABEL_PROJECT_INPUT',status=400)=>{throw new SalesPriceLabelTemplateError(message,code,status);};
function createSalesPriceLabelProjectStore({access,vault,validateImages,scopeId='grabenplaner-main'}){
 assertPersistenceAccess(access);const scope=scopeId+':price-label-projects';
 function id(v){if(typeof v!=='string'||!Project.UUID.test(v))fail('Die Projektkennung ist ungültig.');return v;}
 async function transaction(context,write,action,fresh=async()=>{}){
  assertTemplateContext(context);let protection;
  try{protection=await loadManagedDataImportProtection({access,vault,create:write});await fresh();
   if(!protection)return action(null,null,{revision:0,value:{schemaVersion:1,ownerId:context.owner.id,projects:[]}});
   return await access.transaction(async tx=>{
    const store=annotations({protection,scopeId:scope}),index=await store.read(tx,'price-label-project-index',context.owner.id);
    if(!index.value)index.value={schemaVersion:1,ownerId:context.owner.id,projects:[]};
    try{C.exact(index.value,['schemaVersion','ownerId','projects']);if(index.value.schemaVersion!==1||index.value.ownerId!==context.owner.id||!Array.isArray(index.value.projects)||index.value.projects.length>100||new Set(index.value.projects).size!==index.value.projects.length)throw new Error();index.value.projects.forEach(id);}catch{fail('Die geschützte Projektliste ist beschädigt.','PRICE_LABEL_PROJECT_INTEGRITY',503);}
    return action(store,tx,index,protection);
   },{isolation:'serializable',readOnly:!write});
  }catch(error){if(['IMPORT_CONCURRENT_CHANGE','PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY','PERSISTENCE_UNIQUE_VIOLATION'].includes(error.code))fail('Das Projekt wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten.','PRICE_LABEL_PROJECT_CONFLICT',409);
   if(['IMPORT_PROTECTED_PAYLOAD_INVALID','IMPORT_PROTECTION_KEY_INVALID','IMPORT_VAULT_UNAVAILABLE'].includes(error.code))fail('Das geschützte Projekt ist nicht verfügbar.','PRICE_LABEL_PROJECT_INTEGRITY',503);throw error;
  }finally{protection?.destroy();}
 }
 async function read(store,tx,index,context,projectId){
  if(!index.value.projects.includes(projectId))fail('Das Projekt wurde nicht gefunden.','PRICE_LABEL_PROJECT_NOT_FOUND',404);
  const row=await store.read(tx,'price-label-project',context.owner.id+':'+projectId);
  try{C.exact(row.value,['schemaVersion','ownerId','id','createdAt','updatedAt','project']);if(row.value.schemaVersion!==1||row.value.ownerId!==context.owner.id||row.value.id!==projectId||![row.value.createdAt,row.value.updatedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))throw new Error();row.value.project=Project.normalize(row.value.project,Labels.normalizeOptions);}catch{fail('Das geschützte Projekt ist beschädigt.','PRICE_LABEL_PROJECT_INTEGRITY',503);}return row;
 }
 const visible=row=>({id:row.value.id,version:row.revision,createdAt:row.value.createdAt,updatedAt:row.value.updatedAt,project:row.value.project});
 async function validate(context,project,fresh){const seen=new Set(),proof=[];for(const label of project.labels){const imageBoxes=label.options.imageBoxes.filter(box=>!seen.has(box.assetId));if(imageBoxes.length){if(!validateImages)fail('Die Bildablage ist nicht verfügbar.','PRICE_LABEL_IMAGE_STORAGE',503);proof.push(...assertImageProof(await validateImages(context,{...label.options,imageBoxes},{assertFresh:fresh}),imageBoxes));imageBoxes.forEach(box=>seen.add(box.assetId));}}await fresh();return proof;}
 return{
  list(context,{assertFresh}={}){return transaction(context,false,async(store,tx,index)=>{const rows=[];for(const projectId of index.value.projects){const row=await read(store,tx,index,context,projectId);rows.push({id:projectId,version:row.revision,name:row.value.project.name,labelCount:row.value.project.labels.length,updatedAt:row.value.updatedAt});}return{projects:rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))};},assertFresh);},
  get(context,projectId,{assertFresh}={}){id(projectId);return transaction(context,false,async(store,tx,index)=>visible(await read(store,tx,index,context,projectId)),assertFresh);},
  async create(context,input,{assertFresh=async()=>{}}={}){C.exact(input,['project']);assertTemplateContext(context);const project=Project.normalize(input.project,Labels.normalizeOptions);if(!project.name.trim())fail('Bitte einen Projektnamen eingeben.');const proof=await validate(context,project,assertFresh);
   return transaction(context,true,async(store,tx,index,protection)=>{await assertCurrentImageGrants({tx,protection,scopeId,context,proof});if(index.value.projects.length>=100)fail('Höchstens 100 gespeicherte Projekte je Konto.','PRICE_LABEL_PROJECT_LIMIT',413);const projectId=crypto.randomUUID(),now=new Date().toISOString();
    const row=await store.write(tx,'price-label-project',context.owner.id+':'+projectId,{schemaVersion:1,ownerId:context.owner.id,id:projectId,createdAt:now,updatedAt:now,project},0,context.owner.id);
    await store.write(tx,'price-label-project-index',context.owner.id,{...index.value,projects:[...index.value.projects,projectId]},index.revision,context.owner.id);return{id:projectId,version:row.revision,createdAt:now,updatedAt:now,project};},assertFresh);},
  async update(context,projectId,input,{assertFresh=async()=>{}}={}){id(projectId);C.exact(input,['version','project']);C.integer(input.version,1,Number.MAX_SAFE_INTEGER-1);assertTemplateContext(context);const project=Project.normalize(input.project,Labels.normalizeOptions);if(!project.name.trim())fail('Bitte einen Projektnamen eingeben.');const proof=await validate(context,project,assertFresh);
   return transaction(context,true,async(store,tx,index,protection)=>{await assertCurrentImageGrants({tx,protection,scopeId,context,proof});const row=await read(store,tx,index,context,projectId);if(row.revision!==input.version)fail('Ein anderes Fenster hat das Projekt geändert. Bitte als Kopie speichern oder neu öffnen.','PRICE_LABEL_PROJECT_CONFLICT',409);const next={...row.value,updatedAt:new Date().toISOString(),project};const saved=await store.write(tx,'price-label-project',context.owner.id+':'+projectId,next,row.revision,context.owner.id);return visible({revision:saved.revision,value:next});},assertFresh);},
  remove(context,projectId,input,{assertFresh}={}){id(projectId);C.exact(input,['version']);C.integer(input.version,1,Number.MAX_SAFE_INTEGER-1);return transaction(context,true,async(store,tx,index)=>{const row=await read(store,tx,index,context,projectId);if(row.revision!==input.version)fail('Das Projekt wurde zwischenzeitlich geändert.','PRICE_LABEL_PROJECT_CONFLICT',409);await store.write(tx,'price-label-project-index',context.owner.id,{...index.value,projects:index.value.projects.filter(v=>v!==projectId)},index.revision,context.owner.id);return{removed:true};},assertFresh);},
 };
}
module.exports={createSalesPriceLabelProjectStore};
