'use strict';
const C = require('./data-import-contract');
const Q = require('./persistence/repositories/import-reader-cache');
const batches = new Map(require('./persistence/statements/sales-article-workspace').readerBatches.map(entry => [entry.source,entry.batch]));
// Each packet and its authenticated consumers share the same transaction. No
// decrypted fields or role grants survive into another request/import revision.
async function prefetch(tx, statement, requests) {
  const batch = batches.get(statement);
  if (!batch) throw new Error('Unknown article read packet');
  const unique = [...new Map(requests.map(parameters => [C.canonical(parameters),parameters])).values()];
  Q.start(tx);
  for (let start=0;start<unique.length;start+=C.LIMITS.batch) {
    const part = unique.slice(start,start+C.LIMITS.batch), grouped = part.map(() => []);
    for (const {batchOrdinal,...row} of await tx.queryAll(batch,{requests:part})) {
      C.integer(batchOrdinal,1,part.length);grouped[batchOrdinal-1].push(row);
    }
    part.forEach((parameters,index) => {
      if (statement.operation==='queryOne' && grouped[index].length>1) C.fail('IMPORT_SOURCE_INTEGRITY');
      Q.put(tx,statement,parameters,statement.operation==='queryOne' ? grouped[index][0] || null : grouped[index]);
    });
  }
  return Promise.all(requests.map(parameters => Q.read(tx,statement,parameters)));
}
module.exports = {prefetch};
