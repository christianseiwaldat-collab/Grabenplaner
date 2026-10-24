'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const file = path.resolve(__dirname, '../server-tools/linux/lib/session-security-migrate.js');
const root = '/opt/grabenplaner/app';
const paths = ['server-tools/linux/lib/session-security-migrate.js', 'lib/persistence/postgresql/core/session-security.js',
  'lib/persistence/postgresql/core/catalog.js', 'lib/persistence/postgresql/boundary/migrate.js',
  'lib/persistence/schema-definitions/session-security.js', 'lib/persistence/catalogs/portal-access-catalog.js',
  'lib/persistence/catalogs/mobile-auth-catalog.js', 'lib/persistence/catalogs/organization-personnel-catalog.js',
  'lib/persistence/statements/portal-access.js', 'lib/persistence/statements/mobile-auth.js', 'lib/persistence/statements/organization-personnel.js'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function harness(scenario = 'success') {
  const events = [], manifest = Buffer.from(JSON.stringify({ appVersion: '0.92.90-beta', sourceCommit: 'synthetic',
    files: paths.map(relative => ({ path: relative, sha256: hash(Buffer.from(relative)) })) }));
  const config = { binding: { environmentId: 'synthetic' }, domains: [{ domain: 'core', database: 'fixture_core' }] };
  let inspected = 0;
  const runtime = {
    loadConfiguration(value) { assert.equal(value, '/etc/grabenplaner/postgresql-operations.json'); events.push('configuration'); return config; },
    async latestBackup(value, options) { assert.equal(value, config); assert.equal(options.maximumAgeHours, 1); events.push('backup');
      if (scenario === 'backup-failure') throw new Error('synthetic backup failure'); return { verified: true }; },
    async inspectPair(value) { assert.equal(value, config); events.push('inspect'); inspected++;
      return { core: { database: 'fixture_core', schemaSha256: inspected === 1 ? 'before' : 'after' },
        sales: { schemaSha256: scenario === 'domain-drift' && inspected === 2 ? 'changed' : 'sales' } }; },
    url(value, domain) { assert.equal(value, config); assert.equal(domain.database, 'fixture_core'); return 'synthetic'; },
  };
  const client = { async connect() { events.push('connect'); }, async query(sql) { assert.match(sql, /SET search_path=pg_catalog,gp;/); assert.doesNotMatch(sql, /SET LOCAL search_path/); assert.match(sql, /lock_timeout='5s'/); assert.match(sql, /statement_timeout='30s'/); events.push('bounded'); },
    async end() { events.push('end'); } };
  const context = { module: { exports: {} }, __dirname: root + '/server-tools/linux/lib',
    process: { platform: 'linux', getuid: () => 0 }, require(id) {
      if (id === 'node:fs') return {
        realpathSync: value => value === '/proc/self/fd/9' ? '/run/grabenplaner/maintenance.lock' : root,
        readFileSync: value => value.endsWith('grabenplaner-server-manifest.json') ? manifest
          : Buffer.from(scenario === 'source-drift' && value.endsWith('schema-definitions/session-security.js') ? 'changed source' : value.slice(root.length + 1)),
      };
      if (id === 'node:child_process') return { spawnSync: () => ({ status: scenario === 'bad-lease' ? 1 : 0 }) };
      if (id === './deploy-policy') return { applicationContract: () => { events.push('contract'); } };
      if (id === '../../../lib/persistence/postgresql/core/catalog') return { createCoreCatalog() {
        events.push('catalog'); if (scenario === 'catalog-drift') throw new Error('synthetic catalog drift');
      } };
      if (id === '../../../lib/persistence/postgresql/operations/runtime') return runtime;
      if (id === 'pg') return { Client: function (url) { assert.equal(url, 'synthetic'); return client; } };
      if (id === '../../../lib/persistence/postgresql/core/session-security') return { async migrate(c, options) {
        assert.equal(c, client); assert.equal(options.binding, config.binding); events.push('migrate');
        if (scenario === 'migration-failure') throw new Error('synthetic migration failure');
        return { applied: scenario !== 'already-applied', digest: 'synthetic-plan' };
      } };
      if (id === '../../../lib/persistence/postgresql/boundary/migrate') return { async verifyCoreSchema(c, options) {
        assert.equal(c, client); assert.equal(options.requireVocationalSchool, true); assert.equal(options.requireSessionSecurity, true); events.push('verify');
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

for (const scenario of ['success', 'already-applied']) {
  test(`installed session migration requires backup and verifies resulting schema: ${scenario}`, async () => {
    const h = harness(scenario), result = await h.run();
    assert.equal(result.verified, true); assert.equal(result.salesUnchanged, true);
    assert.equal(result.applied, scenario === 'success');
    assert.deepEqual(h.events, ['contract', 'catalog', 'configuration', 'backup', 'inspect', 'connect', 'bounded', 'migrate', 'verify', 'end', 'inspect']);
  });
}

for (const scenario of ['bad-lease', 'source-drift', 'catalog-drift', 'backup-failure']) {
  test(`installed session migration rejects preconditions before connection: ${scenario}`, async () => {
    const h = harness(scenario); await assert.rejects(h.run());
    assert.equal(h.events.includes('connect'), false);
    if (scenario !== 'backup-failure') assert.equal(h.events.includes('configuration'), false);
  });
}

for (const scenario of ['migration-failure', 'verification-failure', 'domain-drift']) {
  test(`installed session migration never returns a success receipt on ${scenario}`, async () => {
    const h = harness(scenario); await assert.rejects(h.run());
    assert.ok(h.events.includes('end'));
    if (scenario === 'migration-failure') assert.equal(h.events.includes('verify'), false);
  });
}
