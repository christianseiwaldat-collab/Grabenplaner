"use strict";
const {definePersistenceStatement}=require('../contract');
const read=(id,parameters)=>definePersistenceStatement({id:'workflow-studio.'+id,operation:'queryAll',parameters,columns:{data:'json'}});
module.exports={S:Object.freeze({listStudioRuns:read('instances.page',{after:'text',limit:'safe_integer'}),listStudioRunSteps:read('instance.steps',{runId:'text'}),completedStudioOperation:read('completion.lookup',{key:'text'})})};
