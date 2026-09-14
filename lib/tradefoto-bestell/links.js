'use strict';
const C=require('../data-import-contract');
const key=value=>value===null||value===undefined?null:typeof value==='number'?(Number.isSafeInteger(value)?String(value):C.fail('IMPORT_IDENTIFIER_PRECISION')):typeof value==='string'?value:C.fail('IMPORT_IDENTIFIER_PRECISION');
const composite=values=>C.canonical(values.map(key));
// One explicit business alias. Preserve the original code alongside its target.
const BRANCH_ALIASES=Object.freeze({'00':'0'});
function branchReference(value,branches,{aliases=BRANCH_ALIASES}={}) {
  const sourceKey=key(value),targetKey=sourceKey===null?null:Object.hasOwn(aliases,sourceKey)?aliases[sourceKey]:sourceKey;
  const target=targetKey===null?null:branches.get(targetKey);
  return {sourceKey,targetKey,state:sourceKey===null||sourceKey===''?'missing':target?'linked':'unmapped',target:target||null,
    mapping:sourceKey!==targetKey?'explicit_alias':'exact'};
}
function reference(value,items,{zeroIsUnassigned=false}={}) {
  const sourceKey=key(value);if(sourceKey===null||sourceKey==='')return {sourceKey,state:'missing',target:null};
  if(zeroIsUnassigned&&sourceKey==='0')return {sourceKey,state:'unassigned',target:null};
  return {sourceKey,state:items.has(sourceKey)?'linked':'unmapped',target:items.get(sourceKey)||null};
}
function supplierReference(value,items) {
  const exact=reference(value,items);if(exact.state!=='unmapped')return {...exact,targetKey:exact.state==='linked'?exact.sourceKey:null,mapping:'exact'};
  // Match the observed case-insensitive ASCII comparison for ASCII supplier codes.
  // Unicode collation and ambiguous alternatives are deliberately not guessed.
  if(!/^[\x20-\x7e]+$/u.test(exact.sourceKey))return {...exact,targetKey:null,mapping:'unresolved'};
  const matches=[...items.keys()].filter(k=>/^[\x20-\x7e]+$/u.test(k)&&k.toLowerCase()===exact.sourceKey.toLowerCase());
  if(matches.length!==1)return {...exact,state:matches.length?'ambiguous':'unmapped',targetKey:null,mapping:'unresolved'};
  return {sourceKey:exact.sourceKey,targetKey:matches[0],state:'linked',target:items.get(matches[0]),mapping:'unique_ascii_case_insensitive'};
}
function pairedSources({cash,trade,bestell}) {
  for(const source of [cash,trade,bestell]) {C.sha(source.fileSha256);C.utc(source.snapshotAt);}
  const binding={version:1,cash:{fileSha256:cash.fileSha256,snapshotAt:cash.snapshotAt},trade:{fileSha256:trade.fileSha256,snapshotAt:trade.snapshotAt},bestell:{fileSha256:bestell.fileSha256,snapshotAt:bestell.snapshotAt}};
  return C.freeze({...binding,fingerprint:C.fingerprint(binding),sameExportTime:new Set([cash,trade,bestell].map(s=>s.snapshotAt)).size===1});
}
function invoiceCashRelation(invoice,lines) {
  const number=key(invoice.Rechnungsnr),matched=lines.filter(line=>key(line.RechnungsNr)===number);
  return {invoiceNumber:number,referencingCashLines:matched.length,referencingReceipts:new Set(matched.map(l=>composite([l.Bonnr,l.Filialid,l.Kassenid,l.Bondatum]))).size,
    state:matched.length?'referenced_by_cash':'no_cash_reference_found',revenueTreatment:'document_only',additionalRevenue:null,
    internalBranchInvoice:invoice.FilRe===true};
}
module.exports={key,composite,BRANCH_ALIASES,branchReference,reference,supplierReference,pairedSources,invoiceCashRelation};
