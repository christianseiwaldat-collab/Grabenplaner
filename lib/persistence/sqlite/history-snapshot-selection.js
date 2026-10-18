'use strict';
const H = require('../../tradefoto-history-profiles');
// One source-membership rule for every stock reader. Missing rows in a published
// snapshot are absent, even when an older version still exists in history.
function stockSnapshotSelection({ sourceInstance = '$sourceInstance', candidate = null } = {}) {
  const legacy = H.profilesFor('trade', 'ARTIKEL_FILIALEN').filter(profile => !H.usesSnapshotMembership(profile));
  if (legacy.length !== 1) throw new Error('Stock legacy profile requires qualification');
  // A selective reader can prove membership for one indexed reference instead
  // of materializing the complete source before applying its article filter.
  if (candidate && !/^[a-z][a-z0-9_]*$/.test(candidate)) throw new Error('Stock candidate alias requires qualification');
  const publishedCandidate = candidate ? ` AND m.record_id=${candidate}.record_id AND m.revision=${candidate}.revision` : '';
  const legacyCandidate = candidate ? ` AND r.id=${candidate}.record_id AND r.revision=${candidate}.revision` : '';
  return `SELECT m.record_id AS id,m.revision FROM import_history_snapshots h
    JOIN import_history_snapshot_members m ON m.run_id=h.run_id
    JOIN import_history_records r ON r.id=m.record_id
    JOIN import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
    WHERE h.scope_id=$scopeId AND h.source_instance=${sourceInstance} AND h.run_id=$snapshot AND h.status='published'
      AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
      AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'${publishedCandidate}
    UNION ALL
    SELECT r.id,r.revision FROM import_history_records r
    JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE r.scope_id=$scopeId AND r.source_instance=${sourceInstance} AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
      AND r.profile_hash='${legacy[0].fingerprint}' AND (v.run_id=$snapshot OR v.file_sha256=$snapshot)${legacyCandidate}
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
// The caller has already joined the exact history version and restricted the
// record's scope, source instance, source and table. Its projection supplies
// record_id, revision, current_revision, profile_hash, run_id and file_sha256.
function stockCandidateMembership({ sourceInstance = '$sourceInstance', candidate = 'a' } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(candidate)) throw new Error('Stock candidate alias requires qualification');
  const legacy = H.profilesFor('trade', 'ARTIKEL_FILIALEN').filter(profile => !H.usesSnapshotMembership(profile));
  if (legacy.length !== 1) throw new Error('Stock legacy profile requires qualification');
  const a = candidate;
  return `(EXISTS (SELECT 1 FROM import_history_snapshots h
    JOIN import_history_snapshot_members m ON m.run_id=h.run_id
    WHERE h.scope_id=$scopeId AND h.source_instance=${sourceInstance} AND h.run_id=$snapshot AND h.status='published'
      AND h.profile_hash=${a}.profile_hash AND m.record_id=${a}.record_id AND m.revision=${a}.revision)
    OR (${a}.revision=${a}.current_revision AND ${a}.profile_hash='${legacy[0].fingerprint}'
      AND (${a}.run_id=$snapshot OR ${a}.file_sha256=$snapshot)
      AND NOT EXISTS (SELECT 1 FROM import_history_snapshots h WHERE h.scope_id=$scopeId
        AND h.source_instance=${sourceInstance} AND (h.run_id=$snapshot OR h.file_sha256=$snapshot))))`;
}
module.exports = { stockSnapshotSelection, historySnapshotPage, stockCandidateMembership };
