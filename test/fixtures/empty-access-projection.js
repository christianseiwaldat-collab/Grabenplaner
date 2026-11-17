'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../../lib/data-import-contract');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function emptyAccessProjection(directory,archiveGenerationSha256){
 const file='access-projection.rows';fs.writeFileSync(path.join(directory,file),'',{flag:'wx',mode:0o600});
 const plan={format:'grabenplaner-access-recovery-projection-v1',archiveGenerationSha256,dictionarySha256:hash('synthetic empty source dictionary'),file,bytes:0,sha256:hash(''),rows:0,tables:[],stats:{omittedValues:0,omittedByKind:Object.fromEntries(require('../../lib/data-import-source-catalog').SOURCE_KINDS.map(kind=>[kind,0]))}};
 return {...plan,planSha256:hash(C.canonical(plan))};
}
module.exports={emptyAccessProjection};
