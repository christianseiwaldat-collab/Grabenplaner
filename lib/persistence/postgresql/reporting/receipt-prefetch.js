'use strict';
const {createCashHistoryBackend}=require('../../repositories/cash-history-backend');
const {prefetch}=require('./catalog');
function createPostgresqlCashHistoryBackend(options){
  return createCashHistoryBackend({...options,prefetchRows(tx,kind,datasetSlot,ordinals,limit){
    if(!prefetch[kind]||ordinals.length>20||!ordinals.length||limit>2001)throw new TypeError('Bounded receipt prefetch required');
    return tx.queryAll(prefetch[kind],{datasetSlot,ordinals,limit});
  }});
}
module.exports={createPostgresqlCashHistoryBackend};
