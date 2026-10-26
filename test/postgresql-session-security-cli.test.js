'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const file = path.resolve(__dirname, '../server-tools/linux/lib/session-security-migrate.js');
const root = '/opt/grabenplaner/app';
const paths = ['server-tools/linux/lib/session-security-migrate.js', 'lib/persistence/postgresql/core/session-security.js',
  'server-tools/linux/lib/passkeys-release-policy.js',
  'lib/passkey-schema-policy.js',
  'lib/persistence/postgresql/core/catalog.js', 'lib/persistence/postgresql/boundary/migrate.js',
  'lib/persistence/schema-definitions/session-security.js', 'lib/persistence/catalogs/portal-access-catalog.js',
  'lib/persistence/catalogs/mobile-auth-catalog.js', 'lib/persistence/catalogs/organization-personnel-catalog.js',
  'lib/persistence/statements/portal-access.js', 'lib/persistence/statements/mobile-auth.js', 'lib/persistence/statements/organization-personnel.js',
  'lib/persistence/postgresql/core/passkeys.js', 'lib/persistence/postgresql/core/passkeys-catalog.js',
  'lib/persistence/postgresql/contracts/passkeys-catalog-v1.json', 'lib/persistence/statements/passkeys.js'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function harness(scenario = 'success', policy = 'compatible') {
  const events = [], manifest = Buffer.from(JSON.stringify({ appVersion: '0.92.90-beta', sourceCommit: 'synthetic',
    files: paths.map(relative => ({ path: relative, sha256: hash(Buffer.from(relative)) })) }));
  const config = { binding: { environmentId: 'synthetic' }, domains: [{ domain: 'core', database: 'fixture_core' }] };
  let inspected = 0;
  const runtime = {
    loadConfiguration(value) { assert.equal(value, '/etc/grabenplaner/postgresql-operations.json'); events.push('configuration'); return config; },
    async latestBackup(value, options) { assert.equal(value, config); assert.equal(options.maximumAgeHours, 1); events.push('backup');
      if (scenario === 'backup-failure') throw new Error('synthetic backup failure'); return { verified: true }; },
    async inspectPair(value) { assert.equal(value, config); events.push('inspect'); inspected++;
      return { core: { database: 'fixture_core', schemaSha256: scenario === 'core-drift' && inspected === 2 ? 'changed' : 'core' },
        sales: { schemaSha256: scenario === 'domain-drift' && inspected === 2 ? 'changed' : 'sales' } }; },
    url(value, domain) { assert.equal(value, config); assert.equal(domain.database, 'fixture_core'); return 'synthetic'; },
  };
  const client = { async connect() { events.push('connect'); }, async query(sql) { assert.match(sql, /SET search_path=pg_catalog,gp;/); assert.doesNotMatch(sql, /SET LOCAL search_path/); assert.match(sql, /lock_timeout='5s'/); assert.match(sql, /statement_timeout='30s'/); events.push('bounded'); },
    async end() { events.push('end'); } };
  const context = { module: { exports: {} }, __dirname: root + '/server-tools/linux/lib',
    process: { platform: 'linux', getuid: () => 0 }, require(id) {
      if (id === 'node:fs') return {
        realpathSync: value => value === '/proc/self/fd/9' ? '/run/grabenplaner/maintenance.lock' : root,
        readFileSync: value => value.endsWith('/package.json') ? JSON.stringify({ grabenplaner: policy === null ? {} : { passkeysSchemaPolicy: policy } })
          : value.endsWith('grabenplaner-server-manifest.json') ? manifest
          : Buffer.from((scenario === 'source-drift' && value.endsWith('schema-definitions/session-security.js'))
            || (scenario === 'passkeys-source-drift' && value.endsWith('contracts/passkeys-catalog-v1.json')) ? 'changed source' : value.slice(root.length + 1)),
      };
      if (id === 'node:child_process') return { spawnSync: () => ({ status: scenario === 'bad-lease' ? 1 : 0 }) };
      if (id === './deploy-policy') return { applicationContract: () => { events.push('contract'); } };
      if (id === './passkeys-release-policy') return require('../server-tools/linux/lib/passkeys-release-policy');
      if (id === '../../../lib/persistence/postgresql/core/catalog') return { createCoreCatalog() {
        events.push('catalog'); if (scenario === 'catalog-drift') throw new Error('synthetic catalog drift');
      } };
      if (id === '../../../lib/persistence/postgresql/core/passkeys-catalog') return { assertPasskeysCatalog() {
        events.push('passkeys-catalog'); if (scenario === 'passkeys-catalog-drift') throw new Error('synthetic passkeys catalog drift');
      } };
      if (id === '../../../lib/persistence/postgresql/operations/runtime') return runtime;
      if (id === 'pg') return { Client: function (url) { assert.equal(url, 'synthetic'); return client; } };
      if (id === '../../../lib/persistence/postgresql/core/session-security') return { async migrate(c, options) {
        assert.equal(c, client); assert.equal(options.binding, config.binding); events.push('migrate');
        if (scenario === 'migration-failure') throw new Error('synthetic migration failure');
        return { applied: scenario === 'unexpected-session-ddl', digest: 'synthetic-plan' };
      } };
      if (id === '../../../lib/persistence/postgresql/core/passkeys') return { digest: 'synthetic-passkeys-plan', async readLedger(c) {
        assert.equal(c, client); events.push('passkeys-ledger');
        if (scenario === 'passkeys-ledger-failure') throw new Error('synthetic passkeys ledger failure');
        return scenario === 'absent' ? null : { version: 1 };
      }, async migrate() {
        assert.fail('A normal update must never execute Passkey DDL');
      } };
      if (id === '../../../lib/persistence/postgresql/boundary/migrate') return { async verifyCoreSchema(c, options) {
        assert.equal(c, client); assert.equal(options.requireVocationalSchool, true); assert.equal(options.requireSessionSecurity, true);
        assert.equal(options.requirePasskeys, policy === 'required'); events.push('verify');
        if (scenario === 'absent' && options.requirePasskeys) throw new Error('PG_PASSKEYS_MIGRATION_REQUIRED');
        if (scenario === 'verification-failure') throw new Error('synthetic verification failure');
      } };
      return require(id);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { run: () => context.module.exports.main([hash(manifest), '--maintenance-lock-held']), events };
}

test('session migration CLI refuses uninstalled use without private configuration or database access', async () => {
  await assert.rejects(require('../server-tools/linux/lib/session-security-migrate').main([]), /PG_SESSION_SECURITY_MIGRATION_INSTALLED_SCOPE/);
});

for (const policy of ['compatible', 'required']) {
  test(`installed ${policy} update verifies an active Passkey schema without DDL`, async () => {
    const h = harness('success', policy), result = await h.run();
    assert.equal(result.verified, true); assert.equal(result.salesUnchanged, true);
    assert.equal(result.applied, false); assert.equal(result.schemaUnchanged, true);
    assert.equal(result.passkeysVerified, true); assert.equal(result.passkeys.applied, false); assert.equal(result.passkeys.deferred, false);
    assert.equal(result.passkeysSchemaPolicy, policy); assert.equal(result.passkeysState, 'present');
    assert.deepEqual(h.events, ['contract', 'catalog', 'passkeys-catalog', 'configuration', 'backup', 'inspect', 'connect', 'bounded', 'verify', 'migrate', 'passkeys-ledger', 'end', 'inspect']);
  });
}

test('compatible update preserves the old schema and truthfully reports deferred Passkeys', async () => {
  const h = harness('absent'), result = await h.run();
  assert.equal(result.passkeysVerified, false); assert.equal(result.passkeysState, 'absent');
  assert.equal(result.passkeys.deferred, true); assert.equal(result.passkeys.applied, false);
  assert.equal(result.schemaUnchanged, true); assert.equal(result.applied, false);
});
test('required update rejects the old schema before even an idempotent session migration', async () => {
  const h = harness('absent', 'required'); await assert.rejects(h.run(), /PG_PASSKEYS_MIGRATION_REQUIRED/);
  assert.equal(h.events.includes('migrate'), false); assert.ok(h.events.includes('end'));
});
test('missing or unknown source-bound release policy is rejected before private configuration', async () => {
  for (const policy of [null, 'allow', '']) {
    const h = harness('success', policy); await assert.rejects(h.run());
    assert.equal(h.events.includes('configuration'), false); assert.equal(h.events.includes('connect'), false);
  }
});

for (const scenario of ['bad-lease', 'source-drift', 'catalog-drift', 'passkeys-source-drift', 'passkeys-catalog-drift', 'backup-failure']) {
  test(`installed session migration rejects preconditions before connection: ${scenario}`, async () => {
    const h = harness(scenario); await assert.rejects(h.run());
    assert.equal(h.events.includes('connect'), false);
    if (scenario !== 'backup-failure') assert.equal(h.events.includes('configuration'), false);
  });
}

for (const scenario of ['migration-failure', 'passkeys-ledger-failure', 'verification-failure', 'domain-drift', 'core-drift', 'unexpected-session-ddl']) {
  test(`installed session migration never returns a success receipt on ${scenario}`, async () => {
    const h = harness(scenario); await assert.rejects(h.run());
    assert.ok(h.events.includes('end'));
    if (scenario === 'verification-failure') assert.equal(h.events.includes('migrate'), false);
  });
}
