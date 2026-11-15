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
      const complete=reviewedRows===preparedRows,withinBudget=complete&&durationMs<=budgetMs;
      const fullPacket=preparedRows>=oldLimit;
      let ceiling=previous?.ceiling??maximumRows;
      let probeFailures=previous?.probeFailures||0;
      let recoveryPackets=withinBudget&&fullPacket&&durationMs<=budgetMs*0.95
        ?Math.min(256,(previous?.recoveryPackets||0)+1):0;
      // A full fast packet proves that the previous slow-cost regime ended.
      // A small final page is not evidence for increasing the next full page.
      if(withinBudget&&fullPacket&&durationMs<=budgetMs*0.65) {
        ceiling=maximumRows;probeFailures=0;recoveryPackets=0;
      }
      if(!withinBudget&&previous?.probeFrom!==undefined) {
        ceiling=Math.min(ceiling,previous.probeFrom);
        probeFailures=Math.min(4,probeFailures+1);recoveryPackets=0;
      }
      if(withinBudget&&fullPacket&&previous?.recoveryProbe)probeFailures=0;
      // Fixed overhead can remain above 65% after a transient slowdown. Reopen
      // only one bounded step after sustained full packets with real headroom.
      // Repeated unsuccessful probes become rarer instead of oscillating.
      const recoveryWait=Math.min(256,32*2**Math.max(0,probeFailures-1));
      let recoveryProbe=false;
      if(ceiling<maximumRows&&oldLimit>=ceiling&&recoveryPackets>=recoveryWait) {
        ceiling=Math.min(maximumRows,Math.ceil(oldLimit*1.25));recoveryProbe=true;
      }
      let limit=Math.min(maximumRows,ceiling,target,Math.max(1,Math.ceil(oldLimit*1.5)),
        complete?maximumRows:reviewedRows);
      let stablePackets=withinBudget&&fullPacket?(previous?.stablePackets||0)+1:0;
      if(withinBudget) {
        // Authentication and prefetch have a fixed cost. Dividing that cost by
        // fewer rows must not shrink a successful packet all the way to one.
        limit=Math.min(ceiling,Math.max(limit,oldLimit));
        // Probe recovery gradually when fixed overhead prevents the ordinary
        // per-row estimate from growing. A failed probe remembers the previous
        // safe size; later retries require a separate stable recovery window.
        if(stablePackets>=4&&durationMs<=budgetMs*0.95)
          limit=Math.min(maximumRows,ceiling,Math.max(limit,Math.ceil(oldLimit*1.25)));
      }
      const probeFrom=limit>oldLimit?oldLimit:undefined;
      if(probeFrom!==undefined){stablePackets=0;recoveryPackets=0;}
      if(!entries.has(key)&&entries.size>=256)entries.delete(entries.keys().next().value);
      entries.set(key,{limit,rowMs,ceiling,stablePackets,probeFailures,recoveryPackets,
        ...(probeFrom===undefined?{}:{probeFrom}),...(recoveryProbe&&probeFrom!==undefined?{recoveryProbe:true}:{})});
    },
  });
}
module.exports={createReviewBatchPolicy};
