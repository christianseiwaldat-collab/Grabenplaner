'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Module } = require('node:module');
const migration = require('../lib/persistence/postgresql/core/passkeys');
const catalog = require('../lib/persistence/postgresql/core/passkeys-catalog');
const { createPostgresqlPersistenceProvider } = require('../lib/persistence/postgresql/provider');
const { verifyPasskeysRepeat } = require('../test-support/postgresql-migration/verify-passkeys-repeat.cjs');

function subject(overrides = {}) {
  const filename = path.resolve(__dirname, '../lib/persistence/postgresql/core/passkeys.js');
  const instance = new Module(filename, module); instance.filename = filename; instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = instance.require.bind(instance);
  instance.require = name => overrides[name] || original(name);
  instance._compile(fs.readFileSync(filename, 'utf8'), filename); return instance.exports;
}
function fixture({ fault = '', present = false, environmentFails = false } = {}) {
  const calls = []; let tables = present, ledger = present ? { version: 1, plan_sha256: migration.digest, base_target_sha256: 'a'.repeat(64), target_sha256: 'b'.repeat(64) } : null;
  const old = { tables, ledger }; let fingerprints = 0;
  const client = { async query(sql, parameters) {
    calls.push(sql);
    if (sql === fault) throw new Error('SYNTHETIC_MIGRATION_FAILURE');
    if (sql.includes("to_regclass('gp.passkeys_migration_history')")) return { rows: [{ name: tables ? 'gp.passkeys_migration_history' : null }] };
    if (sql.startsWith('SELECT version,plan_sha256')) return { rows: ledger ? [ledger] : [] };
    if (sql.startsWith('CREATE TABLE gp.passkeys_migration_history')) tables = true;
    if (sql.startsWith('INSERT INTO gp.passkeys_migration_history')) ledger = { version: 1, plan_sha256: parameters[0], base_target_sha256: parameters[1], target_sha256: parameters[2] };
    if (sql === 'ROLLBACK') { tables = old.tables; ledger = old.ledger; }
    return { rows: [] };
  } };
  const current = subject({ './fingerprint': { schemaFingerprint: async () => ++fingerprints === 1 ? 'a'.repeat(64) : 'b'.repeat(64) },
    './environment': { verifyEnvironment: async (c, options) => { assert.equal(c, client); assert.equal(options.purpose, 'migrator'); if (environmentFails) throw Error('SYNTHETIC_ENVIRONMENT_DENIED'); } },
    '../boundary/migrate': { verifyCoreSchema: async (c, options) => { assert.equal(c, client); assert.equal(options.requireSessionSecurity, true); } },
  });
  return { calls, client, current, state: () => ({ tables, ledger }) };
}

test('passkeys use a separately qualified native catalog while all 1125 historical Core statements and boundary pins remain intact', async () => {
  assert.equal(require('../lib/persistence/postgresql/core/catalog').createCoreCatalog().entries.length, 1125);
  require('../lib/persistence/postgresql/boundary/catalog').assertBoundaryCatalog();
  const entries = catalog.assertPasskeysCatalog(); assert.equal(entries.length, 15);
  const provider = createPostgresqlPersistenceProvider({ catalog: entries, pool: { connect: async () => { throw Error('No database required for qualification'); }, end: async () => {} } });
  await provider.close();
  assert(migration.statements.every(sql => !/^(DROP|ALTER|UPDATE|DELETE)\b/u.test(sql)));
  assert(migration.statements.some(sql => /ON DELETE CASCADE/u.test(sql)));
  assert(migration.statements.some(sql => /GRANT SELECT ON gp.passkeys_migration_history/u.test(sql)));
  assert(!migration.statements.some(sql => /GRANT.*ON gp.passkey_credentials TO gp_core_reader/u.test(sql)));
});

test('qualification rejects missing/duplicate SQL pins and a changed additive schema before connecting', () => {
  const filename = path.resolve(__dirname, '../lib/persistence/postgresql/core/passkeys-catalog.js');
  const contract = require('../lib/persistence/postgresql/contracts/passkeys-catalog-v1.json');
  for (const change of [value => { value.schemaDigest = '0'.repeat(64); }, value => value.entries.pop(), value => value.entries.push(value.entries[0]),
    value => { value.entries[0].sha256 = '0'.repeat(64); }, value => { value.entries[0].id = value.entries[1].id; }]) {
    const pin = structuredClone(contract); change(pin);
    const instance = new Module(filename, module); instance.filename = filename; instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = instance.require.bind(instance); instance.require = name => name === '../contracts/passkeys-catalog-v1.json' ? pin : original(name);
    instance._compile(fs.readFileSync(filename, 'utf8'), filename);
    assert.throws(() => instance.exports.assertPasskeysCatalog(), /PG_PASSKEYS_CATALOG_CONTRACT/);
  }
});

test('migration is explicit, transactional, idempotent and never rewrites passwords or existing sessions', async () => {
  const f = fixture(); const result = await f.current.migrate(f.client);
  assert.equal(result.applied, true); assert.equal(result.legacyDataChanged, false);
  assert(f.calls[0].startsWith('SELECT pg_advisory_lock(')); assert(f.calls[1].startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE'));
  assert.equal(f.calls.at(-2), 'COMMIT'); assert(f.calls.at(-1).startsWith('SELECT pg_advisory_unlock('));
  assert.equal(f.state().ledger.plan_sha256, migration.digest);
  const replay = fixture({ present: true });
  assert.deepEqual(await verifyPasskeysRepeat(replay.client, replay.current), { applied: false, digest: migration.digest });
  assert(!replay.calls.some(sql => sql.startsWith('CREATE ')));
  for (const sql of f.calls) assert(!/^(UPDATE|DELETE FROM|ALTER TABLE) gp\.(portal_users|portal_organization_accounts|portal_sessions|portal_organization_sessions)/u.test(sql));
});
test('CI repeat verification consumes the real migration result object and rejects a changed operation or digest', async () => {
  for (const result of [false, { applied: true, digest: migration.digest }, { applied: false, digest: '0'.repeat(64) }]) {
    await assert.rejects(verifyPasskeysRepeat({}, { digest: migration.digest, migrate: async () => result }), /Passkey migration|Repeated Passkey migration/);
  }
});

test('a failed additive migration rolls back every table and its completion record, then releases the migration lock', async () => {
  const f = fixture({ fault: migration.statements[7] });
  await assert.rejects(f.current.migrate(f.client), /SYNTHETIC_MIGRATION_FAILURE/);
  assert.deepEqual(f.state(), { tables: false, ledger: null });
  assert.equal(f.calls.at(-2), 'ROLLBACK'); assert(f.calls.at(-1).startsWith('SELECT pg_advisory_unlock('));
  const denied = fixture({ environmentFails: true });
  await assert.rejects(denied.current.migrate(denied.client), /SYNTHETIC_ENVIRONMENT_DENIED/); assert.deepEqual(denied.calls, []);
});

test('old backups have optional passkey availability while a present malformed or wrongly anchored ledger fails closed', async () => {
  const absent = fixture(); assert.equal(await migration.target(absent.client, 'a'.repeat(64)), 'a'.repeat(64));
  await assert.rejects(migration.target(absent.client, 'a'.repeat(64), { required: true }), /PG_PASSKEYS_MIGRATION_REQUIRED/);
  const present = fixture({ present: true }); assert.equal(await migration.target(present.client, 'a'.repeat(64)), 'b'.repeat(64));
  await assert.rejects(migration.target(present.client, 'c'.repeat(64)), /PG_PASSKEYS_MIGRATION_CONTRACT/);
  const malformed = { query: async sql => sql.includes('to_regclass') ? { rows: [{ name: 'gp.passkeys_migration_history' }] } : { rows: [] } };
  await assert.rejects(migration.target(malformed, 'a'.repeat(64)), /PG_PASSKEYS_MIGRATION_CONTRACT/);
});
