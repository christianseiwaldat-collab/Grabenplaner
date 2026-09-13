'use strict';
// Personal action receipts belong to Core. A Sales mutation commits its receipt
// intent into the same append-only outbox as its audit, then delivers both in
// order. No transaction is allowed to write both databases.
const {definePersistenceStatement}=require('../../contract');
const {normalizePersonalActionReceiptInput}=require('../../../personal-action-log');
const PERSONAL_ACTION_EVENT='database-boundary.personal-action-v1';
const auditById=definePersistenceStatement({id:'application-boundary.audit-by-id',operation:'queryOne',parameters:{id:'safe_integer'},columns:{data:'json'}});
const CATALOG=Object.freeze([{statement:auditById,sql:'SELECT to_jsonb(o) AS data FROM integration.core_audit_outbox o WHERE id=$1',parameterOrder:['id'],returning:false}]);
function receiptIntent(parameters){
 const {id,actorKind,...input}=parameters;
 if(!/^[a-f0-9-]{36}$/.test(id||''))throw new Error('PG_PERSONAL_ACTION_ID');
 const normalized=normalizePersonalActionReceiptInput(input);
 if(actorKind!==normalized.actorKind||JSON.stringify(Object.keys(parameters).filter(k=>k!=='id').sort())!==JSON.stringify(Object.keys(normalized).sort()))throw new Error('PG_PERSONAL_ACTION_SHAPE');
 return {id,...normalized};
}
function readReceiptIntent(event){
 const value=receiptIntent(JSON.parse(event.detail));
 if(value.actorId!==event.actor||value.id!==event.entity_id||event.entity_type!=='personal_action_receipt')throw new Error('PG_PERSONAL_ACTION_BINDING');
 return value;
}
module.exports={PERSONAL_ACTION_EVENT,auditById,CATALOG,receiptIntent,readReceiptIntent};
