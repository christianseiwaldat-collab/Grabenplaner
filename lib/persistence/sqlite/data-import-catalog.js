"use strict";
const { DATA_IMPORT_STATEMENTS: S, DATA_IMPORT_COLUMNS: C } = require("../statements/data-import");
const snake = name => name.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase());
const selection = columns => Object.keys(columns).map(name => `${snake(name)} AS "${name}"`).join(", ");
const insert = (table, columns) => `INSERT INTO ${table} (${Object.keys(columns).map(snake).join(", ")}) VALUES (${Object.keys(columns).map(name => "$" + name).join(", ")})`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_DATA_IMPORT_CATALOG = Object.freeze([
  entry(S.getRun, `SELECT ${selection(C.RUN)} FROM data_import_runs WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId`),
  entry(S.listRuns, `SELECT ${selection(C.RUN)} FROM data_import_runs WHERE scope_id=$scopeId AND owner_id=$ownerId AND (created_at<$beforeAt OR (created_at=$beforeAt AND id<$beforeId)) ORDER BY created_at DESC, id DESC LIMIT $limit`),
  entry(S.insertRun, insert("data_import_runs", C.RUN) + " ON CONFLICT (id) DO NOTHING"),
  entry(S.updateRun, "UPDATE data_import_runs SET revision=revision+1, status=$status, received_count=$receivedCount, updated_at=$updatedAt WHERE id=$id AND revision=$revision"),
  entry(S.insertRow, insert("data_import_rows", C.ROW)),
  entry(S.getRow, `SELECT ${selection(C.ROW)} FROM data_import_rows WHERE run_id=$runId AND row_number=$rowNumber`),
  entry(S.findIdentity, `SELECT ${selection(C.ROW)} FROM data_import_rows WHERE run_id=$runId AND identity_hash=$identityHash ORDER BY row_number LIMIT 1`),
  entry(S.conflictIdentity, "UPDATE data_import_rows SET state='conflict', issue='SOURCE_KEY_CONFLICT' WHERE run_id=$runId AND identity_hash=$identityHash"),
  entry(S.listRows, `SELECT ${selection(C.ROW)} FROM data_import_rows WHERE run_id=$runId AND row_number>$after ORDER BY row_number LIMIT $limit`),
  entry(S.pendingReview, `SELECT ${selection(C.ROW)} FROM data_import_rows WHERE run_id=$runId AND state='staged' ORDER BY row_number LIMIT $limit`),
  entry(S.pendingApply, `SELECT ${selection(C.ROW)} FROM data_import_rows WHERE run_id=$runId AND state IN ('create','update','refresh') ORDER BY row_number LIMIT $limit`),
  entry(S.updateRow, "UPDATE data_import_rows SET state=$state, issue=$issue, payload=$payload WHERE run_id=$runId AND row_number=$rowNumber"),
  entry(S.counts, "SELECT state, COUNT(*) AS count FROM data_import_rows WHERE run_id=$runId GROUP BY state"),
  entry(S.getLink, `SELECT ${selection(C.LINK)} FROM data_import_links WHERE id=$id`),
  entry(S.insertLink, insert("data_import_links", C.LINK)),
  entry(S.updateLink, "UPDATE data_import_links SET revision=revision+1, target_id=$targetId, last_run_id=$lastRunId, payload=$payload WHERE id=$id AND revision=$revision"),
  entry(S.deleteLink, "DELETE FROM data_import_links WHERE id=$id AND revision=$revision"),
  entry(S.insertChange, insert("data_import_changes", C.CHANGE)),
  entry(S.pendingUndo, `SELECT ${selection(C.CHANGE)} FROM data_import_changes WHERE run_id=$runId AND reverted_at IS NULL ORDER BY row_number DESC LIMIT $limit`),
  entry(S.undoPage, `SELECT ${selection(C.CHANGE)} FROM data_import_changes WHERE run_id=$runId AND row_number<$beforeRow AND reverted_at IS NULL ORDER BY row_number DESC LIMIT $limit`),
  entry(S.revertChange, "UPDATE data_import_changes SET reverted_at=$revertedAt WHERE run_id=$runId AND row_number=$rowNumber AND reverted_at IS NULL"),
  entry(S.insertEvent, insert("data_import_events", C.EVENT)),
  entry(S.listEvents, `SELECT ${selection(C.EVENT)} FROM data_import_events WHERE run_id=$runId AND revision>$after ORDER BY revision LIMIT $limit`),
  entry(S.purgeRows, "UPDATE data_import_rows SET payload='' WHERE run_id=$runId"),
  entry(S.purgeChanges, "UPDATE data_import_changes SET payload='' WHERE run_id=$runId"),
]);
module.exports = { SQLITE_DATA_IMPORT_CATALOG };
