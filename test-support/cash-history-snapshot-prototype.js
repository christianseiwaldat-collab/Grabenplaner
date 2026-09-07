'use strict';
// Isolated storage experiment, deliberately not loaded by server.js or import routes.
// One encrypted value array per source row; schema/provenance once per dataset.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const definitions = require('../lib/tradefoto-full-import-source').definitions('cash');
const tables = definitions.map((def, i) => ({ ...def, sqlName: 'cash_' + i }));
const tableMap = new Map(tables.map(table => [table.name, table]));
const parentNames = { Umsatz_Kasse_Details: 'Umsatz_KASSE', KassenJournal_Details: 'KassenJournal' };
const indexFields = { location_key: ['Filialid', 'Filiale', 'FilialId'], seller_key: ['VerkäuferID', 'Verkäuferid'],
  customer_key: ['KUND_NR'], article_key: ['EAN'] };
const names = ['source_row', 'source_key', 'business_date', 'date_state', 'parent_row', ...Object.keys(indexFields)];
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function metadata(row) { return names.map(name => Buffer.isBuffer(row[name]) || row[name] instanceof Uint8Array ? Buffer.from(row[name]).toString('hex') : row[name]); }
function context(manifestHash, table, row) { return ['cash-snapshot-storage-experiment-v1', manifestHash, table.profile.fingerprint, metadata(row)]; }
function valuesFor(table, normalized) { return table.columns.map(column => normalized.source[column.name]); }
function protectedIndex(protection, domain, value) {
  return value == null || value === '' || value === '0' ? null : Buffer.from(protection.digest(['cash-source-reference', domain, String(value)]), 'hex');
}
function schema(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=524288;');
  db.exec('CREATE TABLE snapshot_meta (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  for (const table of tables) {
    const parent = tableMap.get(parentNames[table.name]);
    db.exec(`CREATE TABLE ${table.sqlName} (
      source_row INTEGER PRIMARY KEY CHECK(source_row>0), source_key BLOB NOT NULL UNIQUE CHECK(length(source_key)=32),
      business_date TEXT, date_state TEXT NOT NULL CHECK(date_state IN ('within','older','unknown','future')),
      parent_row INTEGER ${parent ? `REFERENCES ${parent.sqlName}(source_row)` : 'CHECK(parent_row IS NULL)'},
      location_key BLOB, seller_key BLOB, customer_key BLOB, article_key BLOB, payload TEXT NOT NULL)`);
    db.exec(`CREATE INDEX ${table.sqlName}_date ON ${table.sqlName}(business_date,source_row)`);
    if (parent) db.exec(`CREATE INDEX ${table.sqlName}_parent ON ${table.sqlName}(parent_row,source_row)`);
    for (const [column, candidates] of Object.entries(indexFields)) {
      if (candidates.some(name => table.columns.some(field => field.name === name))) {
        db.exec(`CREATE INDEX ${table.sqlName}_${column} ON ${table.sqlName}(${column},business_date,source_row)`);
      }
    }
  }
}
function openCashSnapshotPrototype({ file, protection, manifest, readOnly = false }) {
  assert.equal(manifest.purpose, 'isolated-storage-experiment');
  const manifestHash = sha(C.canonical(manifest));
  if (!readOnly) assert.ok(!fs.existsSync(file), 'EXPERIMENT_FILE_EXISTS');
  const db = new DatabaseSync(file, { readOnly });
  let sealed = readOnly, pendingWrites = null;
  const expected = new Map(), counts = new Map(), inserts = new Map();
  try {
  if (!readOnly) {
    schema(db);
    db.prepare('INSERT INTO snapshot_meta VALUES (?,?)').run('manifest', protection.seal(manifest, ['cash-snapshot-manifest', manifestHash]));
    for (const table of tables) {
      const tableMeta = { name: table.name, columns: table.columns, profileHash: table.profile.fingerprint };
      db.prepare('INSERT INTO snapshot_meta VALUES (?,?)').run(table.name, protection.seal(tableMeta, ['cash-snapshot-schema', manifestHash, table.name]));
      inserts.set(table.name, db.prepare(`INSERT INTO ${table.sqlName}(${names.join(',')},payload) VALUES (${[...names, 'payload'].map(() => '?').join(',')})`));
      expected.set(table.name, crypto.createHash('sha256')); counts.set(table.name, 0);
    }
  } else {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    assert.deepEqual(protection.open(db.prepare('SELECT payload FROM snapshot_meta WHERE id=?').get('manifest').payload,
      ['cash-snapshot-manifest', manifestHash]), manifest, 'SNAPSHOT_MANIFEST_MISMATCH');
    for (const table of tables) assert.deepEqual(protection.open(db.prepare('SELECT payload FROM snapshot_meta WHERE id=?').get(table.name).payload,
      ['cash-snapshot-schema', manifestHash, table.name]), { name: table.name, columns: table.columns, profileHash: table.profile.fingerprint });
  }
  } catch (error) { db.close(); throw error; }
  function decode(table, row) {
    const values = protection.open(row.payload, context(manifestHash, table, row));
    assert.equal(values.length, table.columns.length, 'SNAPSHOT_FIELD_COUNT');
    return values;
  }
  return {
    database: db, manifestHash,
    transaction(operation) {
      assert.ok(!sealed, 'SNAPSHOT_IMMUTABLE'); assert.equal(pendingWrites, null); db.exec('BEGIN IMMEDIATE'); pendingWrites = [];
      try {
        operation(); db.exec('COMMIT');
        for (const { tableName, sourceRow, values } of pendingWrites) {
          expected.get(tableName).update(C.canonical([sourceRow, values]) + '\n'); counts.set(tableName, counts.get(tableName) + 1);
        }
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { pendingWrites = null; }
    },
    append(tableName, sourceRow, normalized, { businessDate = null, dateState = 'unknown', parentRow = null } = {}) {
      assert.ok(!sealed, 'SNAPSHOT_IMMUTABLE'); assert.ok(pendingWrites, 'TRANSACTION_REQUIRED'); const table = tableMap.get(tableName); assert.ok(table);
      const row = { source_row: sourceRow, source_key: Buffer.from(protection.digest(['cash-source-key', tableName, normalized.key]), 'hex'),
        business_date: businessDate, date_state: dateState, parent_row: parentRow };
      for (const [column, candidates] of Object.entries(indexFields)) {
        const field = candidates.find(name => Object.hasOwn(normalized.source, name));
        row[column] = protectedIndex(protection, column, field ? normalized.source[field] : null);
      }
      const values = valuesFor(table, normalized), payload = protection.seal(values, context(manifestHash, table, row));
      inserts.get(tableName).run(...names.map(name => row[name]), payload);
      pendingWrites.push({ tableName, sourceRow, values });
    },
    finish() {
      assert.ok(!sealed, 'SNAPSHOT_IMMUTABLE'); sealed = true;
      const proof = Object.fromEntries(tables.map(table => [table.name, { rows: counts.get(table.name), sha256: expected.get(table.name).digest('hex') }]));
      db.prepare('INSERT INTO snapshot_meta VALUES (?,?)').run('verified-selection', protection.seal(proof, ['cash-snapshot-selection', manifestHash]));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      return proof;
    },
    verify(proof) {
      assert.ok(sealed, 'SNAPSHOT_UNFINISHED');
      const authenticated = protection.open(db.prepare('SELECT payload FROM snapshot_meta WHERE id=?').get('verified-selection').payload,
        ['cash-snapshot-selection', manifestHash]);
      assert.deepEqual(authenticated, proof, 'SNAPSHOT_SELECTION_PROOF');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'SNAPSHOT_RELATIONS');
      assert.ok(db.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok'), 'SNAPSHOT_INTEGRITY');
      let total = 0;
      for (const table of tables) {
        const hash = crypto.createHash('sha256'); let rows = 0;
        for (const row of db.prepare(`SELECT * FROM ${table.sqlName} ORDER BY source_row`).iterate()) {
          hash.update(C.canonical([row.source_row, decode(table, row)]) + '\n'); rows++;
        }
        assert.equal(rows, proof[table.name].rows, 'SNAPSHOT_COUNT_CHANGED');
        assert.equal(hash.digest('hex'), proof[table.name].sha256, 'SNAPSHOT_VALUES_CHANGED'); total += rows;
      }
      return { rows: total, everyStoredValueReadAndCompared: true, authenticatedCiphertext: true, foreignKeys: true, integrity: true };
    },
    readForVerification(tableName, rowNumber) {
      const table = tableMap.get(tableName); assert.ok(table);
      const row = db.prepare(`SELECT * FROM ${table.sqlName} WHERE source_row=?`).get(rowNumber);
      if (!row) return null; const values = decode(table, row);
      return Object.fromEntries(table.columns.map((column, index) => [column.name, values[index]]));
    },
    footprint() {
      return db.prepare('SELECT name, sum(pgsize) AS bytes, sum(payload) AS payloadBytes, sum(unused) AS unusedBytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
    },
    close() { db.close(); },
  };
}
module.exports = { openCashSnapshotPrototype, tables, tableMap, parentNames };
