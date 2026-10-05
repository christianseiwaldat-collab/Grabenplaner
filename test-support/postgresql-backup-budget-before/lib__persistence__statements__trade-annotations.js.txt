'use strict';
const {definePersistenceStatement:d}=require('../contract');
const identity={id:'text',scopeId:'text',kind:'text'},columns={...identity,revision:'safe_integer',payload:'text'};
const A=Object.freeze({
 epoch:d({id:'trade-annotations.epoch',operation:'queryOne',parameters:{scopeId:'text'},columns:{revision:'safe_integer'}}),
 get:d({id:'trade-annotations.get',operation:'queryOne',parameters:identity,columns}),
 insert:d({id:'trade-annotations.insert',operation:'execute',parameters:columns}),
 update:d({id:'trade-annotations.update',operation:'execute',parameters:{...columns,expectedRevision:'safe_integer'}}),
});
module.exports={A};
