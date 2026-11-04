'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const sourceFile = path.resolve(__dirname, '../server-tools/linux/lib/passkeys-schema-activate.js');
const APP = '/opt/grabenplaner/app', CONFIG = '/etc/grabenplaner/postgresql-operations.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const H = { core: 'a'.repeat(64), sales: 'b'.repeat(64), active: 'c'.repeat(64), backup: 'd'.repeat(64) };
const sources = ['server-tools/linux/lib/passkeys-schema-activate.js', 'server-tools/linux/lib/passkeys-release-policy.js',
  'lib/passkey-schema-policy.js',
  'lib/persistence/postgresql/core/passkeys.js', 'lib/persistence/postgresql/boundary/migrate.js',
  'lib/persistence/postgresql/operations/runtime.js', 'lib/persistence/postgresql/operations/paired-bundle.js',
  'lib/persistence/postgresql/operations/paired-checkpoint.js'];

// This harness proves CLI boundaries and ordering, not PostgreSQL transaction
// behavior or an available service rollback. Those use the real Linux fixture.
function harness(scenario = 'success', policy = 'compatible') {
  const events = [], files = new Map(), opened = new Map(), clients = [];
  let nextFd = 20, active = scenario === 'already-active', inspected = 0, completeScans = 0;
  const put = (file, value) => files.set(file, Buffer.from(value));
  const config = { backupDirectory: '/private/backup', environmentFile: '/etc/grabenplaner/grabenplaner.env',
    binding: { environmentId: 'synthetic' }, domains: [{ domain: 'core', database: 'grabenplaner_core' }, { domain: 'sales', database: 'grabenplaner_sales' }] };
  for (const relative of sources) put(APP + '/' + relative, relative);
  put(APP + '/package.json', JSON.stringify({ version: '0.92.94-beta', grabenplaner: { passkeysSchemaPolicy: policy } }));
  const manifest = JSON.stringify({ appVersion: '0.92.94-beta', sourceCommit: '1'.repeat(40),
    files: sources.map(relative => ({ path: relative, sha256: hash(files.get(APP + '/' + relative)) })) });
  put(APP + '/grabenplaner-server-manifest.json', manifest);
  put(CONFIG, JSON.stringify(config)); put(config.environmentFile, 'SYNTHETIC=fixture\n');
  put('/etc/grabenplaner/postgresql-application.json', '{}'); put('/var/lib/grabenplaner/data/postgresql-pair.json', '{}');
  const bundle = config.backupDirectory + '/11111111-1111-4111-8111-111111111111.pair';
  put(bundle + '/postgresql-operations.json', JSON.stringify(config));
  const pair = () => ({ core: { clusterId: '123', database: 'grabenplaner_core', environmentId: 'synthetic', schemaSha256: active ? H.active : H.core },
    sales: { clusterId: '123', database: 'grabenplaner_sales', environmentId: 'synthetic', schemaSha256: H.sales } });
  const before = pair(), points = Object.fromEntries(Object.entries(before).map(([domain, value]) => [domain,
    { ...value, restore: { schemaSha256: value.schemaSha256, tables: ['synthetic'], sequences: [] } }]));
  const backupFiles = [['configuration.env', config.environmentFile], ['postgresql-application.json', '/etc/grabenplaner/postgresql-application.json'],
    ['postgresql-pair.json', '/var/lib/grabenplaner/data/postgresql-pair.json']].map(([file, source]) => ({ file, sha256: hash(files.get(source)) }));
  const proof = { verified: true, verificationScope: 'complete-file-content', files: 6,
    manifest: { createdAt: '2026-10-26T22:00:00.000Z', files: backupFiles,
      checkpoint: { quiescence: 'application-and-files-drained;both-databases-share-locked', domains: points } } };
  const stat = file => {
    if (file.startsWith('/sys/fs/cgroup')) {
      if (scenario === 'removed-empty-cgroup' && file === '/sys/fs/cgroup/system.slice/grabenplaner.service') throw Object.assign(new Error('removed cgroup'), { code: 'ENOENT' });
      return { uid: 0, isDirectory: () => true, isSymbolicLink: () => scenario === 'cgroup-symlink' };
    }
    const bytes = files.get(file); assert.ok(bytes, 'unexpected protected file ' + file);
    return { dev: 1, ino: file.length, size: bytes.length, mtimeMs: 0, ctimeMs: 0, mode: scenario === 'writable-config' && file === CONFIG ? 0o666 : 0o600,
      uid: scenario === 'non-root-config' && file === CONFIG ? 1000 : 0, nlink: 1, isFile: () => true, isSymbolicLink: () => scenario === 'source-symlink' && file.endsWith('/passkeys.js') };
  };
  const runtime = {
    loadConfiguration(file) { assert.equal(file, CONFIG); events.push('configuration'); return config; },
    async inspectPair(value) { assert.equal(value, config); inspected++; events.push('inspect');
      const result = pair(); if (scenario === 'after-sales-drift' && inspected > 1) result.sales.schemaSha256 = 'e'.repeat(64); return result; },
    async latestBackup(value, options) { assert.equal(value, config); assert.equal(options.short, true); assert.equal(options.maximumAgeHours, 1);
      events.push('backup-short'); if (scenario === 'backup-unavailable') throw new Error('PG_OPERATIONS_BACKUP_MISSING');
      return { manifestSha256: scenario === 'backup-pin-drift' ? 'e'.repeat(64) : H.backup, createdAt: proof.manifest.createdAt }; },
    url(value, domain) { assert.equal(value, config); return { domain: domain.domain }; },
  };
  class Client {
    constructor(options) { this.domain = options.domain; this.id = clients.length; clients.push(this); }
    async connect() { events.push('connect-' + this.domain); }
    async query(sql) { events.push(sql.startsWith('SELECT pg_advisory') ? sql : 'query-' + this.domain);
      if (sql.includes('pg_stat_activity')) return { rows: [{ n: scenario === 'other-client' ? 1 : 0 }] }; return { rows: [] }; }
    async end() { events.push('end-' + this.domain); this.ended = true; }
  }
  const context = { Buffer, module: { exports: {} }, __dirname: APP + '/server-tools/linux/lib',
    process: { platform: 'linux', getuid: () => 0 }, require(id) {
      if (id === 'node:path') return path.posix;
      if (id === 'node:fs') return {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
        lstatSync: stat, statSync: file => file.endsWith('.complete.json') ? { mtimeMs: 1 } : stat(file),
        realpathSync: file => file === '/proc/self/fd/9' ? (scenario === 'wrong-lease-path' ? '/wrong' : '/run/grabenplaner/maintenance.lock') : file,
        openSync: file => { const fd = nextFd++; opened.set(fd, file); return fd; },
        fstatSync: fd => stat(opened.get(fd)), closeSync: fd => opened.delete(fd),
        readFileSync(file, encoding) { if (typeof file === 'number') file = opened.get(file);
          const bytes = file.endsWith('/cgroup.procs') ? Buffer.from(scenario === 'remaining-cgroup-process'
            || scenario === 'remaining-descendant-process' && file.includes('/nested/') ? '123\n' : '') : files.get(file);
          assert.ok(bytes, 'unexpected file ' + file); return encoding ? bytes.toString(encoding) : bytes; },
        readdirSync: directory => {
          if (directory.startsWith('/sys/fs/cgroup')) return scenario === 'remaining-descendant-process' && directory.endsWith('/grabenplaner.service')
            ? [{ name: 'nested', isSymbolicLink: () => false, isDirectory: () => true }] : [];
          assert.equal(directory, config.backupDirectory); return ['11111111-1111-4111-8111-111111111111.pair.complete.json'];
        },
      };
      if (id === 'node:child_process') return { spawnSync(command) {
        if (command.endsWith('/flock')) return { status: scenario === 'bad-lease' ? 1 : 0 };
        assert.equal(command, '/usr/bin/systemctl');
        return { status: 0, stdout: `ActiveState=${scenario === 'running-service' ? 'active' : 'inactive'}\nSubState=dead\nMainPID=0\nControlPID=0\nControlGroup=/system.slice/grabenplaner.service\n` };
      } };
      if (id === './deploy-policy') return { applicationContract() { events.push('contract'); if (scenario === 'source-contract-drift') throw new Error('DEPLOY_CONTRACT_CHANGED'); },
        postgresqlPairIdentity(value) { return { databaseIdentitySha256: hash(JSON.stringify(value)) }; } };
      if (id === './passkeys-release-policy') return require('../server-tools/linux/lib/passkeys-release-policy');
      if (id.endsWith('/operations/runtime')) return runtime;
      if (id.endsWith('/operations/backup-budget')) return require('../lib/persistence/postgresql/operations/backup-budget');
      if (id === 'pg') return { Client };
      if (id.endsWith('/core/environment')) return { async verifyEnvironment(client, options) {
        assert.equal(options.domain, client.domain); assert.equal(options.purpose, 'migrator'); events.push('environment-' + client.domain);
        if (scenario === 'wrong-role') throw new Error('Isolated environment verification failed');
      } };
      if (id.endsWith('/boundary/migrate')) return { async verifyCoreSchema(client, options) {
        events.push('verify-schema'); if (scenario === 'schema-drift') throw new Error('Core development schema contract mismatch');
        if (options.requirePasskeys) assert.equal(active, true);
      } };
      if (id.endsWith('/core/passkeys')) return { digest: 'f'.repeat(64), async readLedger() { return active ? { version: 1 } : null; },
        async migrate() { events.push('passkeys-migrate');
          if (scenario === 'transaction-failure') throw new Error('PG_SYNTHETIC_TRANSACTION_FAILURE');
          const applied = !active; active = true;
          if (scenario === 'configuration-changed-after-commit') put(config.environmentFile, 'SYNTHETIC=changed\n');
          return { applied, digest: 'f'.repeat(64), ...(applied ? { target: H.active } : {}), legacyDataChanged: false };
        } };
      if (id.endsWith('/operations/paired-checkpoint')) return { async verifyCheckpoint(client, domain, expected) {
        assert.equal(typeof client.query, 'function'); await client.query('SELECT synthetic_checkpoint_verification');
        assert.equal(expected, points[domain].restore); events.push('checkpoint-' + domain);
        if (scenario === 'checkpoint-drift') throw new Error('PG_PAIR_RESTORE_CHECKPOINT_MISMATCH');
      } };
      if (id.endsWith('/operations/paired-bundle')) return { async verifyPairBundle(directory, marker, options) {
        assert.equal(directory, bundle); assert.equal(marker, bundle + '.complete.json');
        assert.equal(options.verifyContent, true); assert.equal(options.expectedSha256, H.backup); completeScans++; events.push('backup-complete');
        if (scenario === 'backup-content-drift') throw new Error('PG_PAIR_COMPONENT_HASH');
        if (scenario === 'backup-wrong-pair') proof.manifest.checkpoint.domains.core.database = 'other_core';
        if (scenario === 'backup-wrong-configuration') proof.manifest.files[0].sha256 = 'e'.repeat(64);
        return proof;
      } };
      return require(id);
    } };
  if (scenario === 'source-drift') put(APP + '/lib/persistence/postgresql/core/passkeys.js', 'changed');
  vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), context, { filename: sourceFile });
  const manifestHash = hash(manifest), configurationHash = hash(JSON.stringify([CONFIG, config.environmentFile,
    '/etc/grabenplaner/postgresql-application.json', '/var/lib/grabenplaner/data/postgresql-pair.json'].map(file => [file, hash(files.get(file))])));
  const args = action => action === 'activate' ? [action, manifestHash, configurationHash, H.backup, hash(JSON.stringify(before)), '--maintenance-lock-held']
    : [action, manifestHash, '--maintenance-lock-held'];
  return { events, clients, get active() { return active; }, get completeScans() { return completeScans; },
    args, run: action => context.module.exports.main(args(action)), runArgs: values => context.module.exports.main(values) };
}

test('activation CLI refuses uninstalled invocation before configuration or SQL', async () => {
  await assert.rejects(require('../server-tools/linux/lib/passkeys-schema-activate').main([]), /PG_PASSKEYS_ACTIVATION_INSTALLED_SCOPE/);
});
test('readonly inspect works without backup and never requests schema mutation', async () => {
  const h = harness('backup-unavailable'), result = await h.run('inspect');
  assert.equal(result.passkeysState, 'absent'); assert.equal(h.events.includes('backup-short'), false);
  assert.equal(h.events.includes('passkeys-migrate'), false); assert.ok(h.clients.every(client => client.ended));
});
test('pre-stop guard pins source and protected configuration while app is running, without SQL or backup', async () => {
  const h = harness('running-service'), result = await h.run('guard');
  assert.equal(result.passkeysSchemaPolicy, 'compatible'); assert.match(result.configurationSha256, /^[a-f0-9]{64}$/);
  assert.equal(h.clients.length, 0); assert.equal(h.events.includes('inspect'), false); assert.equal(h.events.includes('backup-short'), false);
  assert.equal(h.events.includes('configuration'), true);
});
test('pre-stop guard rejects changed source, unsafe configuration and missing lease before SQL', async () => {
  for (const scenario of ['source-drift', 'non-root-config', 'writable-config', 'bad-lease']) {
    const h = harness(scenario); await assert.rejects(h.run('guard')); assert.equal(h.clients.length, 0);
  }
});
test('readonly binding pins latest backup without complete content scan or DDL', async () => {
  const h = harness(), result = await h.run('binding'); assert.equal(result.backupManifestSha256, H.backup);
  assert.equal(result.passkeysState, 'absent'); assert.equal(h.completeScans, 0); assert.equal(h.events.includes('passkeys-migrate'), false);
});
for (const scenario of ['success', 'already-active', 'removed-empty-cgroup']) test(`explicit activation bound to source/config/pair/complete backup: ${scenario}`, async () => {
  const h = harness(scenario), result = await h.run('activate');
  assert.equal(result.verified, true); assert.equal(result.schemaCommitted, scenario !== 'already-active'); assert.equal(result.passkeysVerified, true);
  assert.equal(result.sameInstalledApplication, true); assert.equal(result.salesUnchanged, true); assert.equal(result.restartRequired, true);
  assert.equal(result.backupManifestSha256, H.backup); assert.equal(h.completeScans, 1);
  assert.ok(h.events.indexOf('checkpoint-core') < h.events.indexOf('checkpoint-sales'));
  assert.ok(h.events.indexOf('checkpoint-sales') < h.events.indexOf('passkeys-migrate'));
  assert.equal(h.events.filter(value => value === 'SELECT pg_advisory_lock(9261207)').length, 2);
  assert.equal(h.events.filter(value => value === 'SELECT pg_advisory_unlock(9261207)').length, 2);
  assert.ok(h.clients.every(client => client.ended));
});
for (const scenario of ['wrong-lease-path', 'bad-lease', 'running-service', 'remaining-cgroup-process', 'remaining-descendant-process', 'cgroup-symlink', 'source-contract-drift',
  'source-drift', 'source-symlink', 'non-root-config', 'writable-config']) test(`activation refuses boundary drift before private configuration: ${scenario}`, async () => {
  const h = harness(scenario); await assert.rejects(h.run('activate'));
  assert.equal(h.events.includes('configuration'), false); assert.equal(h.clients.length, 0);
});
test('required release cannot be used as the compatibility schema activator', async () => {
  const h = harness('success', 'required'); await assert.rejects(h.run('activate'), /PG_PASSKEYS_ACTIVATION_POLICY/);
  assert.equal(h.events.includes('configuration'), false);
});
test('each prepared activation pin is required and wrong pins cannot reach DDL', async () => {
  for (const index of [1, 2, 3, 4]) {
    const h = harness(), args = h.args('activate'); args[index] = 'e'.repeat(64);
    await assert.rejects(h.runArgs(args)); assert.equal(h.events.includes('passkeys-migrate'), false);
    assert.ok(h.clients.every(client => client.ended));
  }
});
for (const scenario of ['backup-unavailable', 'backup-pin-drift', 'backup-content-drift', 'backup-wrong-pair', 'backup-wrong-configuration',
  'other-client', 'wrong-role', 'checkpoint-drift', 'schema-drift']) test(`activation refuses before DDL: ${scenario}`, async () => {
  const h = harness(scenario); await assert.rejects(h.run('activate')); assert.equal(h.events.includes('passkeys-migrate'), false);
  assert.ok(h.clients.every(client => client.ended));
});
test('transaction error never becomes success and closes both owned clients', async () => {
  const h = harness('transaction-failure'); await assert.rejects(h.run('activate'), /PG_SYNTHETIC_TRANSACTION_FAILURE/);
  assert.equal(h.active, false); assert.ok(h.clients.every(client => client.ended));
});
test('post-commit configuration drift refuses success while retaining active-schema state', async () => {
  const h = harness('configuration-changed-after-commit'); await assert.rejects(h.run('activate'), /PG_PASSKEYS_ACTIVATION_DOMAIN_DRIFT/);
  assert.equal(h.active, true); assert.ok(h.clients.every(client => client.ended));
});
test('post-commit Sales drift refuses a success receipt', async () => {
  const h = harness('after-sales-drift'); await assert.rejects(h.run('activate'), /PG_PASSKEYS_ACTIVATION_DOMAIN_DRIFT/);
  assert.equal(h.active, true);
});

test('actual migration verifies its ledger inside the transaction; every precommit fault rolls back', async () => {
  const { Module } = require('node:module'), migrationFile = path.resolve(__dirname, '../lib/persistence/postgresql/core/passkeys.js');
  for (const fault of ['', 'ddl', 'ledger', 'verify']) {
    const events = [], instance = new Module(migrationFile, module);
    instance.filename = migrationFile; instance.paths = Module._nodeModulePaths(path.dirname(migrationFile));
    const original = instance.require.bind(instance);
    let state = { ddl: 0, table: false, row: null }, snapshot;
    const client = { async query(sql, values) {
      events.push(sql);
      if (sql.startsWith('BEGIN ')) snapshot = structuredClone(state);
      if (sql === 'ROLLBACK') state = snapshot;
      if (sql.includes("to_regclass('gp.passkeys_migration_history')")) return { rows: [{ name: state.table ? 'gp.passkeys_migration_history' : null }] };
      if (sql === 'SELECT version,plan_sha256,base_target_sha256,target_sha256 FROM gp.passkeys_migration_history') return { rows: state.row ? [state.row] : [] };
      if (sql.startsWith('CREATE ')) {
        state.ddl++; if (sql.startsWith('CREATE TABLE gp.passkeys_migration_history')) state.table = true;
        if (fault === 'ddl') throw new Error('SYNTHETIC_DDL_FAILURE');
      }
      if (sql.startsWith('INSERT INTO gp.passkeys_migration_history')) {
        if (fault === 'ledger') throw new Error('SYNTHETIC_LEDGER_FAILURE');
        state.row = { version: 1, plan_sha256: values[0], base_target_sha256: values[1], target_sha256: values[2] };
      }
      return { rows: [] };
    } };
    instance.require = id => id === './environment' ? { verifyEnvironment: async () => events.push('environment') }
      : id === './passkeys-catalog' ? { assertPasskeysCatalog: () => events.push('catalog') }
        : id === './fingerprint' ? { schemaFingerprint: async () => state.ddl ? H.active : H.core }
          : id === '../boundary/migrate' ? { verifyCoreSchema: async (value, options) => {
            assert.equal(value, client); assert.equal(options.requireSessionSecurity, true);
            if (options.requirePasskeys) {
              events.push('post-ddl-verify'); assert.ok(state.row); assert.equal(state.row.target_sha256, H.active);
              if (fault === 'verify') throw new Error('SYNTHETIC_POST_DDL_VERIFY_FAILURE');
            }
          } } : original(id);
    instance._compile(fs.readFileSync(migrationFile, 'utf8'), migrationFile);
    if (fault) {
      await assert.rejects(instance.exports.migrate(client), /SYNTHETIC_/);
      assert.deepEqual(state, { ddl: 0, table: false, row: null });
      assert.equal(events.includes('COMMIT'), false); assert.ok(events.includes('ROLLBACK'));
    } else {
      const result = await instance.exports.migrate(client); assert.equal(result.applied, true);
      assert.ok(events.indexOf('post-ddl-verify') > events.findIndex(sql => sql.startsWith('INSERT INTO gp.passkeys_migration_history')));
      assert.ok(events.indexOf('post-ddl-verify') < events.indexOf('COMMIT'));
      const ddl = state.ddl; assert.equal((await instance.exports.migrate(client)).applied, false); assert.equal(state.ddl, ddl);
    }
  }
});
