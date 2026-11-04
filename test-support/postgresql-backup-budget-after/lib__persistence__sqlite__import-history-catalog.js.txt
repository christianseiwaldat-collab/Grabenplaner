"use strict";
const { IMPORT_HISTORY_STATEMENTS: S, IMPORT_HISTORY_COLUMNS: C } = require('../statements/import-history');
const snake = name => name.replace(/[A-Z]/gu, letter => '_' + letter.toLowerCase());
const select = (columns, prefix = '') => Object.keys(columns).map(name => `${prefix}${snake(name)} AS "${name}"`).join(', ');
const insert = (table, columns) => `INSERT INTO ${table} (${Object.keys(columns).map(snake).join(', ')}) VALUES (${Object.keys(columns).map(name => '$' + name).join(', ')})`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_IMPORT_HISTORY_CATALOG = Object.freeze([
  entry(S.epoch, `SELECT COALESCE((SELECT token FROM import_history_epochs WHERE scope_id=$scopeId),'initial') AS token,
    COALESCE((SELECT SUM(revision) FROM data_import_runs WHERE scope_id=$scopeId),0) AS "runRevision"`),
  entry(S.advanceEpoch, `INSERT INTO import_history_epochs(scope_id,token) VALUES($scopeId,$token)
    ON CONFLICT(scope_id) DO UPDATE SET token=$token`),
  entry(S.search, `SELECT ${select(C.RECORD, 'r.')}, v.business_date AS "businessDate" FROM import_history_records r
    JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source='cash' AND r.source_table=$sourceTable
    AND v.business_date BETWEEN $dateFrom AND $dateTo AND (v.business_date<$afterDate OR (v.business_date=$afterDate AND r.id<$afterId))
    AND (CAST($snapshot AS TEXT) IS NULL OR v.file_sha256=$snapshot)
    AND (($unassigned=FALSE AND EXISTS (SELECT 1 FROM import_history_references q WHERE q.record_id=r.id AND q.revision=r.revision AND q.role=$locationRole AND q.lookup_hash=$locationHash))
      OR ($unassigned=TRUE AND NOT EXISTS (SELECT 1 FROM import_history_references q WHERE q.record_id=r.id AND q.revision=r.revision AND q.role=$locationRole AND q.lookup_hash IS NOT NULL)))
    AND ($sellerMode='none' OR EXISTS (SELECT 1 FROM import_history_references q WHERE q.record_id=r.id AND q.revision=r.revision AND q.role=$sellerRole
      AND (($sellerMode='target' AND q.lookup_hash=$sellerHash) OR ($sellerMode='unassigned' AND q.lookup_hash IS NULL))))
    AND (CAST($customerHash AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM import_history_references q WHERE q.record_id=r.id AND q.revision=r.revision AND q.role='customer' AND q.lookup_hash=$customerHash))
    ORDER BY v.business_date DESC,r.id DESC LIMIT $limit`),
  entry(S.get, `SELECT ${select(C.RECORD)} FROM import_history_records WHERE id=$id AND scope_id=$scopeId`),
  entry(S.find, `SELECT ${select(C.RECORD)} FROM import_history_records WHERE identity_hash=$identityHash AND scope_id=$scopeId`),
  entry(S.insert, insert('import_history_records', C.RECORD)),
  entry(S.advance, 'UPDATE import_history_records SET revision=revision+1 WHERE id=$id AND scope_id=$scopeId AND revision=$expectedRevision'),
  entry(S.remove, 'DELETE FROM import_history_records WHERE id=$id AND scope_id=$scopeId AND revision=$expectedRevision'),
  entry(S.version, `SELECT ${select(C.VERSION)} FROM import_history_versions WHERE record_id=$recordId AND revision=$revision`),
  entry(S.insertVersion, insert('import_history_versions', C.VERSION)),
  entry(S.versions, `SELECT ${select(C.VERSION)} FROM import_history_versions WHERE record_id=$recordId ORDER BY revision`),
  entry(S.clearVersions, 'DELETE FROM import_history_versions WHERE record_id=$recordId'),
  entry(S.segments, `SELECT ${select(C.SEGMENT)} FROM import_history_segments WHERE record_id=$recordId AND revision=$revision ORDER BY data_class`),
  entry(S.insertSegment, insert('import_history_segments', C.SEGMENT)),
  entry(S.clearSegments, 'DELETE FROM import_history_segments WHERE record_id=$recordId'),
  entry(S.references, `SELECT ${select(C.REFERENCE)} FROM import_history_references WHERE record_id=$recordId AND revision=$revision ORDER BY role`),
  entry(S.insertReference, insert('import_history_references', C.REFERENCE)),
  entry(S.clearReferences, 'DELETE FROM import_history_references WHERE record_id=$recordId'),
  entry(S.dependencies, `SELECT (SELECT COUNT(*) FROM import_history_versions WHERE parent_id=$id)
    + (SELECT COUNT(*) FROM import_history_holds WHERE record_id=$id) AS count`),
  entry(S.children, `SELECT ${select(C.RECORD, 'r.')} FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE v.parent_id=$parentId AND r.scope_id=$scopeId AND r.id>$after ORDER BY r.id LIMIT $limit`),
  entry(S.list, `SELECT ${select(C.RECORD, 'r.')} FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
    WHERE r.scope_id=$scopeId AND r.source_instance=$sourceInstance AND r.source=$source AND r.source_table=$sourceTable AND r.id>$after
    AND ($snapshot IS NULL OR v.file_sha256=$snapshot) ORDER BY r.id LIMIT $limit`),
  entry(S.insertHold, insert('import_history_holds', { recordId: 'text', consumerId: 'text' })),
  entry(S.removeHold, 'DELETE FROM import_history_holds WHERE record_id=$recordId AND consumer_id=$consumerId'),
]);
module.exports = { SQLITE_IMPORT_HISTORY_CATALOG };
