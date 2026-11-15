'use strict';
const {normalizePersistenceValue,PersistenceError,PERSISTENCE_ERROR_CODES}=require('../contract');
const {SALES_ARTICLE_CATALOG_STATEMENTS:S}=require('../statements/sales-article-catalog');
const {INSERT_ARTICLE_PRICES}=require('../statements/sales-article-price-batches');
const PRICE_PACKET_ROWS=200;
function normalizedPrice(row){
 const fields=Object.keys(S.insertPriceSnapshot.parameters);
 if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==fields.length||fields.some(name=>!Object.hasOwn(row,name)))
  throw new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,{operation:'sales-article-price-batches'});
 return Object.fromEntries(fields.map(name=>[name,normalizePersistenceValue(row[name],S.insertPriceSnapshot.parameters[name],{invalidCode:PERSISTENCE_ERROR_CODES.STATEMENT_INVALID})]));
}
async function insertArticlePrices(operations,rows){
 // Apply exactly the scalar contract of the old single-row statement before
 // sending JSON to the typed packet. UUIDs and provenance are supplied by the
 // caller once; no price or source value is recomputed here.
 if(!Array.isArray(rows))throw new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,{operation:'sales-article-price-batches'});
 const normalized=rows.map(normalizedPrice);
 if(!operations.importBatchReads){
  for(const row of normalized)await operations.execute(S.insertPriceSnapshot,row);
  return;
 }
 for(let from=0;from<normalized.length;from+=PRICE_PACKET_ROWS){
  const packet=normalized.slice(from,from+PRICE_PACKET_ROWS),result=await operations.execute(INSERT_ARTICLE_PRICES,{rows:packet});
  if(result.rowsAffected!==packet.length)throw new PersistenceError(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION,{operation:'sales-article-price-batches'});
 }
}
module.exports={insertArticlePrices,PRICE_PACKET_ROWS};
