'use strict';

// Keep the packet inside the operation's time budget, including authentication
// and prefetch. Preparing 200 rows and then accepting only one wastes almost the
// whole packet on every checkpoint. Estimates are local to the runtime/profile;
// they never cache a plan or change a source/permission decision.
function createReviewBatchPolicy({maximumRows=200,budgetMs=750,initialRows=16}={}) {
  if(!Number.isSafeInteger(maximumRows)||maximumRows<1||maximumRows>200
    ||!Number.isFinite(budgetMs)||budgetMs<1
    ||!Number.isSafeInteger(initialRows)||initialRows<1)throw new TypeError('Invalid review batch policy');
  const entries=new Map();
  return Object.freeze({
    limit(key){return entries.get(key)?.limit||Math.min(initialRows,maximumRows);},
    observe(key,{preparedRows,reviewedRows,durationMs}){
      if(!Number.isSafeInteger(preparedRows)||preparedRows<1
        ||!Number.isSafeInteger(reviewedRows)||reviewedRows<1||reviewedRows>preparedRows
        ||!Number.isFinite(durationMs)||durationMs<=0)return;
      const previous=entries.get(key),cost=durationMs/reviewedRows;
      // React promptly to a slow packet, but grow conservatively after a fast
      // one. Leave room for encoding, transaction completion and ordinary GP use.
      const rowMs=previous?Math.max(cost,previous.rowMs*0.6+cost*0.4):cost;
      const target=Math.max(1,Math.floor(budgetMs*0.65/rowMs));
      const oldLimit=previous?.limit||Math.min(initialRows,maximumRows);
      const limit=Math.min(maximumRows,target,Math.max(1,Math.ceil(oldLimit*1.5)),
        reviewedRows<preparedRows?reviewedRows:maximumRows);
      if(!entries.has(key)&&entries.size>=256)entries.delete(entries.keys().next().value);
      entries.set(key,{limit,rowMs});
    },
  });
}
module.exports={createReviewBatchPolicy};
