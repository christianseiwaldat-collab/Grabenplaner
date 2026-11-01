'use strict';
const H = require('../../tradefoto-history-profiles');
// One source-membership rule for every stock reader. Missing rows in a published
// snapshot are absent, even when an older version still exists in history.
function stockSnapshotSelection({ sourceInstance = '$sourceInstance' } = {}) {
  const legacy = H.profilesFor('trade', 'ARTIKEL_FILIALEN').filter(profile => !H.usesSnapshotMembership(profile));
  if (legacy.length !== 1) throw new Error('Stock legacy profile requires qualification');
  return `SELECT m.record_id AS id,m.revision FROM import_history_snapshots h
    JOIN import_history_snapshot_members m ON m.run_id=h.run_id
    JOIN import_history_records r ON r.id=m.record_id
    JOIN import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
    WHERE h.scope_id=$scopeId AND h.source_instance=${sourceInstance} AND h.run_id=$snapshot AND h.status='published'
      AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
      AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
    UNION ALL
    SELECT r.id,r.revision FROM import_history_records r
    JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE r.scope_id=$scopeId AND r.source_instance=${sourceInstance} AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      AND r.profile_hash='${legacy[0].fingerprint}' AND (v.run_id=$snapshot OR v.file_sha256=$snapshot)
      AND NOT EXISTS (SELECT 1 FROM import_history_snapshots h WHERE h.scope_id=$scopeId
        AND h.source_instance=${sourceInstance} AND (h.run_id=$snapshot OR h.file_sha256=$snapshot))`;
}
function historySnapshotPage() {
  return `SELECT candidate.id,candidate.revision FROM (
    SELECT chosen.id,chosen.revision FROM (${stockSnapshotSelection()}) chosen
      WHERE $source='trade' AND $sourceTable='ARTIKEL_FILIALEN'
    UNION ALL
    SELECT r.id,r.revision FROM import_history_records r
      JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
      WHERE r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source=$source AND r.source_table=$sourceTable
        AND NOT (r.source='trade' AND r.source_table='ARTIKEL_FILIALEN')
        AND (CAST($snapshot AS TEXT) IS NULL OR v.file_sha256=$snapshot)
    ) candidate WHERE candidate.id>$after ORDER BY candidate.id LIMIT $limit`;
}
module.exports = { stockSnapshotSelection, historySnapshotPage };
