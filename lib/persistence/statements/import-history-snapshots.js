'use strict';
const {definePersistenceStatement}=require('../contract');
const HEADER={runId:'text',scopeId:'text',sourceInstance:'text',profileHash:'text',fileSha256:'text',snapshotAt:'utc_timestamp',ownerId:'text',expectedRows:'safe_integer',status:'text',payload:'text'};
const MEMBER={runId:'text',rowNumber:'safe_integer',recordId:'text',revision:'safe_integer',payload:'text'};
const define=(name,operation,parameters,columns={})=>definePersistenceStatement({id:'import-history-snapshots.'+name,operation,parameters,columns});
const S=Object.freeze({
 get:define('get','queryOne',{runId:'text'},{...HEADER,publicationCheck:'text',coverageVerified:'safe_integer'}),
 insert:define('insert','execute',HEADER),
 transition:define('transition','execute',{runId:'text',expectedStatus:'text',status:'text',payload:'text'}),
 member:define('member','queryOne',{runId:'text',recordId:'text'},MEMBER),
 membersPut:define('members-put','execute',{rows:'json'}),
 membersClear:define('members-clear','execute',{runId:'text'}),
 coverage:define('coverage','queryOne',{runId:'text'},{count:'safe_integer',first:'safe_integer',last:'safe_integer',qualified:'safe_integer'}),
 dependencies:define('dependencies','queryOne',{runId:'text',recordId:'text',fromRevision:'safe_integer'},{count:'safe_integer'}),
 deleteMembers:define('delete-members','execute',{runId:'text',scopeId:'text',ownerId:'text'}),
 deleteHeader:define('delete-header','execute',{runId:'text',scopeId:'text',ownerId:'text'}),
});
module.exports={S,HEADER,MEMBER};
