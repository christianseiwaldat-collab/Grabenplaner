'use strict';
const C = require('../../data-import-contract');
const H = require('../../tradefoto-history-profiles');
const { SOURCES } = require('../statements/trade-insights');
async function latestHistorySource(tx, { scopeId, sourceInstance, source = 'trade', table, protection, limit = 100 }) {
  const groups = await Promise.all(H.profilesFor(source, table).map(profile => tx.queryAll(SOURCES,
    { scopeId, profileHash: profile.fingerprint, limit })));
  const found = groups.flat().filter(run => ['applied', 'purged'].includes(run.status) && run.manifest.sourceInstance === sourceInstance)
    .sort((a, b) => b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt) || b.createdAt.localeCompare(a.createdAt))[0];
  if (!found) return null;
  const profile = H.profileFor(source, table, found.profileHash);
  const expected = protection.digest(['run', C.VERSION, { scopeId: found.scopeId, ownerId: found.ownerId }, profile.fingerprint, found.manifest, found.attemptId]);
  if (found.id !== expected || !C.equal(found.profile, profile) || found.receivedCount !== found.manifest.expectedRows) C.fail('IMPORT_HISTORY_INTEGRITY');
  if (H.usesSnapshotMembership(profile)) await require('./import-history-snapshots').createHistorySnapshots({ protection }).publication(tx, found);
  return found;
}
function assertSnapshotVersion(value, run) {
  const profile = H.profileFor('trade', run.profile.sourceTable, run.profileHash);
  if (H.usesSnapshotMembership(profile)) {
    if (value.snapshot?.runId !== run.id || value.snapshot.fileSha256 !== run.manifest.fileSha256
      || value.snapshot.snapshotAt !== run.manifest.snapshotAt) C.fail('IMPORT_HISTORY_INTEGRITY');
  } else if (value.provenance.fileSha256 !== run.manifest.fileSha256) C.fail('IMPORT_HISTORY_INTEGRITY');
}
module.exports = { latestHistorySource, assertSnapshotVersion };
