'use strict';
const C=require('./data-import-contract'),{assertPersistenceAccess}=require('./persistence/contract');
const {loadManagedDataImportProtection}=require('./data-import-managed-protection'),{annotations}=require('./persistence/repositories/trade-annotations');
const {assertTemplateContext,assertImageProof,assertCurrentImageGrants,SalesPriceLabelTemplateError}=require('./sales-price-label-template-store');
const Draft=require('../public/sales-price-label-working-draft'),Labels=require('../public/sales-price-labels');
const fail=(message,code='PRICE_LABEL_DRAFT_INPUT',status=400)=>{throw new SalesPriceLabelTemplateError(message,code,status);};
function createSalesPriceLabelDraftStore({access,vault,validateImages,scopeId='grabenplaner-main'}){
  assertPersistenceAccess(access);const scope=scopeId+':price-label-drafts';
  async function work(context,write,operation,fresh=async()=>{}){
    assertTemplateContext(context);let protection;
    try{protection=await loadManagedDataImportProtection({access,vault,create:write});await fresh();
      if(!protection)return operation(null,null,{revision:0,value:null});
      return await access.transaction(async tx=>{
        const store=annotations({protection,scopeId:scope}),prior=await store.read(tx,'price-label-working-draft',context.owner.id);
        if(prior.value){try{C.exact(prior.value,['schemaVersion','ownerId','mutationId','draft']);if(prior.value.schemaVersion!==1||prior.value.ownerId!==context.owner.id||!Draft.UUID.test(prior.value.mutationId))throw new Error();prior.value.draft=Draft.normalize(prior.value.draft,Labels.normalizeOptions);}catch{fail('Der geschützte Entwurf ist beschädigt.','PRICE_LABEL_DRAFT_INTEGRITY',503);}}
        return operation(store,tx,prior,protection);
      },{isolation:'serializable',readOnly:!write});
    }catch(error){
      if(['IMPORT_CONCURRENT_CHANGE','PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY','PERSISTENCE_UNIQUE_VIOLATION'].includes(error.code))fail('Der Arbeitsentwurf wurde zwischenzeitlich geändert. Deine Eingaben bleiben erhalten.','PRICE_LABEL_DRAFT_CONFLICT',409);
      if(['IMPORT_PROTECTED_PAYLOAD_INVALID','IMPORT_PROTECTION_KEY_INVALID','IMPORT_VAULT_UNAVAILABLE'].includes(error.code))fail('Der geschützte Arbeitsentwurf ist nicht verfügbar.','PRICE_LABEL_DRAFT_INTEGRITY',503);
      throw error;
    }finally{protection?.destroy();}
  }
  return {
    async getSearchPreferences(context,{assertFresh=async()=>{}}={}){assertTemplateContext(context);const model=require('../public/sales-price-label-search-window');let protection;try{protection=await loadManagedDataImportProtection({access,vault,create:false});await assertFresh();if(!protection)return{revision:0,preferences:model.defaults()};return await access.transaction(async tx=>{const row=await annotations({protection,scopeId:scope}).read(tx,'price-label-search-table',context.owner.id);if(!row.value)return{revision:0,preferences:model.defaults()};try{C.exact(row.value,['ownerId','preferences']);if(row.value.ownerId!==context.owner.id)throw new Error();return{revision:row.revision,preferences:model.normalize(row.value.preferences)};}catch{fail('Die geschützten Suchtabelleneinstellungen sind beschädigt.','PRICE_LABEL_DRAFT_INTEGRITY',503);}},{readOnly:true});}finally{protection?.destroy();}},
    async saveSearchPreferences(context,input,{assertFresh=async()=>{}}={}){assertTemplateContext(context);C.exact(input,['revision','preferences']);C.integer(input.revision,0,Number.MAX_SAFE_INTEGER-1);const preferences=require('../public/sales-price-label-search-window').normalize(input.preferences);return work(context,true,async(store,tx)=>{const prior=await store.read(tx,'price-label-search-table',context.owner.id);if(prior.revision!==input.revision)fail('Ein anderes Fenster hat die Suchtabelleneinstellungen geändert.','PRICE_LABEL_DRAFT_CONFLICT',409);const saved=await store.write(tx,'price-label-search-table',context.owner.id,{ownerId:context.owner.id,preferences},prior.revision,context.owner.id);return{revision:saved.revision,preferences};},assertFresh);},
    get(context,{assertFresh}={}){return work(context,false,(_store,_tx,prior)=>({revision:prior.revision,draft:prior.value?.draft||null,lastMutationId:prior.value?.mutationId||null}),assertFresh);},
    async save(context,input,{assertFresh=async()=>{}}={}){
      assertTemplateContext(context);C.exact(input,['revision','mutationId','draft']);C.integer(input.revision,0,Number.MAX_SAFE_INTEGER-1);
      if(!Draft.UUID.test(input.mutationId))fail('Die Speicherkennung ist ungültig.');
      const draft=Draft.normalize(input.draft,Labels.normalizeOptions);
      const seenImages=new Set(),proof=[];for(const options of [draft.options,...(draft.project?.data.labels||[]).map(label=>label.options)]){const imageBoxes=options.imageBoxes.filter(box=>!seenImages.has(box.assetId));if(imageBoxes.length){if(!validateImages)fail('Die Bildablage ist nicht verfügbar.','PRICE_LABEL_IMAGE_STORAGE',503);proof.push(...assertImageProof(await validateImages(context,{...options,imageBoxes},{assertFresh}),imageBoxes));imageBoxes.forEach(box=>seenImages.add(box.assetId));}}
      await assertFresh();return work(context,true,async(store,tx,prior,protection)=>{
        await assertCurrentImageGrants({tx,protection,scopeId,context,proof});
        if(prior.value?.mutationId===input.mutationId&&C.canonical(prior.value.draft)===C.canonical(draft))return {revision:prior.revision,draft:prior.value.draft};
        if(prior.revision!==input.revision)fail('Ein anderes Fenster hat den Arbeitsentwurf geändert.','PRICE_LABEL_DRAFT_CONFLICT',409);
        const saved=await store.write(tx,'price-label-working-draft',context.owner.id,{schemaVersion:1,ownerId:context.owner.id,mutationId:input.mutationId,draft},prior.revision,context.owner.id);
        return {revision:saved.revision,draft};
      },assertFresh);
    },
  };
}
module.exports={createSalesPriceLabelDraftStore};
