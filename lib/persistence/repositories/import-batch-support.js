'use strict';
// A provider may use packet statements only when its composition installed the
// runtime catalog. Older migration stages and custom providers keep their path.
const providers=new WeakSet(),references=new WeakSet();
function enableImportBatches(provider,{coreReferences=false}={}){providers.add(provider);if(coreReferences)references.add(provider);}
function supportsImportBatches(provider){return providers.has(provider);}
function supportsCoreImportReferences(provider){return references.has(provider);}
module.exports={enableImportBatches,supportsImportBatches,supportsCoreImportReferences};
