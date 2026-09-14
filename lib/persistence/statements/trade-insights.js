'use strict';
const {definePersistenceStatement:define}=require('../contract');
const {IMPORT_HISTORY_STATEMENTS:S,IMPORT_HISTORY_COLUMNS:C}=require('./import-history');
const page=(name,columns)=>define({id:'trade-insights.'+name,operation:'queryAll',parameters:S.list.parameters,columns});
const T=Object.freeze({versions:page('versions',C.VERSION),segments:page('segments',C.SEGMENT),references:page('references',C.REFERENCE)});
const {CASH_SNAPSHOT_COLUMNS:{ROW}}=require('./cash-snapshots');
const KEY_PARAMETERS=Object.fromEntries(Array.from({length:14},(_,i)=>['key'+(i+1),'bytes']));
const CASH=Object.freeze({customer:define({id:'trade-insights.cash-customer',operation:'queryAll',parameters:{datasetSlot:'safe_integer',...KEY_PARAMETERS,dateFrom:'date',dateTo:'date',after:'safe_integer',limit:'safe_integer'},columns:ROW}),article:define({id:'trade-insights.cash-article',operation:'queryAll',parameters:{datasetSlot:'safe_integer',...KEY_PARAMETERS,dateFrom:'date',dateTo:'date',after:'safe_integer',limit:'safe_integer'},columns:ROW}),
 bounds:define({id:'trade-insights.cash-bounds',operation:'queryOne',parameters:{datasetSlot:'safe_integer'},columns:{dateFrom:{kind:'date',nullable:true},dateTo:{kind:'date',nullable:true}}})});
const SOURCES=define({id:'trade-insights.sources',operation:'queryAll',parameters:{scopeId:'text',profileHash:'text',limit:'safe_integer'},columns:require('./data-import').DATA_IMPORT_COLUMNS.RUN});
const HISTORY_HOLDS=Object.freeze({
 count:define({id:'trade-insights.master-history-holds',operation:'queryOne',parameters:{recordId:'text'},columns:{count:'safe_integer'}}),
 reference:define({id:'trade-insights.master-history-hold-reference',operation:'queryOne',parameters:{recordId:'text',historyId:'text',revision:'safe_integer'},columns:{count:'safe_integer'}}),
});
module.exports={T,CASH,SOURCES,HISTORY_HOLDS};
