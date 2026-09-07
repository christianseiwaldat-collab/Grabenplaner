"use strict";
const { DATA_IMPORT_RUNTIME_STATEMENTS: S, DATA_IMPORT_RUNTIME_COLUMNS: C } = require('../statements/data-import-runtime');
const snake = key => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const select = columns => Object.keys(columns).map(k => `${snake(k)} AS "${k}"`).join(', ');
const insert = (table, columns) => `INSERT INTO ${table} (${Object.keys(columns).map(snake).join(', ')}) VALUES (${Object.keys(columns).map(k => '$' + k).join(', ')}) ON CONFLICT (id) DO NOTHING`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_DATA_IMPORT_RUNTIME_CATALOG = Object.freeze([
  entry(S.key, `SELECT ${select(C.KEY)} FROM data_import_runtime_keys WHERE id=$id`),
  entry(S.insertKey, insert('data_import_runtime_keys', C.KEY)),
  entry(S.source, `SELECT ${select(C.SOURCE)} FROM data_import_sources WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId`),
  entry(S.sources, `SELECT ${select(C.SOURCE)} FROM data_import_sources WHERE scope_id=$scopeId AND owner_id=$ownerId AND (created_at<$beforeAt OR (created_at=$beforeAt AND id<$beforeId)) ORDER BY created_at DESC,id DESC LIMIT $limit`),
  entry(S.insertSource, insert('data_import_sources', C.SOURCE)),
  entry(S.updateSource, 'UPDATE data_import_sources SET revision=revision+1, updated_at=$updatedAt, payload=$payload WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId AND revision=$revision'),
]);
module.exports = { SQLITE_DATA_IMPORT_RUNTIME_CATALOG };
