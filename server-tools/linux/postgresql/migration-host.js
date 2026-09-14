"use strict";

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const staging = require('../../../lib/persistence/postgresql/transfer/staging');
const APP = '/opt/grabenplaner/app';
const ROOT = '/var/lib/grabenplaner-postgresql';
const ENV = '/etc/grabenplaner/grabenplaner.env';
const ANCHOR = '/var/lib/grabenplaner/data/postgresql-pair.json';
const DB_UNIT = 'grabenplaner-postgresql.service';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const managed = require('./managed-contract');
const templates = managed.templates;

function assertFile(file, { owner = 0, privateFile = true } = {}) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== owner || (info.mode & (privateFile ? 0o077 : 0o022))
      || fs.realpathSync(file) !== file) throw new Error('PG_MIGRATION_FILE');
}
function write(file, value, { gid = 0, mode = 0o600, replace = false } = {}) {
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent || !fs.statSync(parent).isDirectory()) throw new Error('PG_MIGRATION_PARENT');
  if (fs.existsSync(file)) { assertFile(file, { privateFile: false }); if (!replace) throw new Error('PG_MIGRATION_FILE_EXISTS'); }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', mode);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fs.fchownSync(fd, 0, gid); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const dir = fs.openSync(parent, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

async function main() {
  const [action, packageSha256] = process.argv.slice(2);
  if (process.platform !== 'linux' || process.getuid() !== 0 || !['prepare', 'execute'].includes(action)
      || !/^[a-f0-9]{64}$/.test(packageSha256 || '') || process.argv.length !== 4
      || fs.realpathSync('/proc/self/fd/9') !== '/run/grabenplaner/maintenance.lock') throw new Error('PG_MIGRATION_ROOT_LEASE');
  execFileSync('/usr/bin/flock', ['--nonblock', '9'], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9] });
  assertFile(APP + '/grabenplaner-server-manifest.json', { privateFile: false });
  if (sha(APP + '/grabenplaner-server-manifest.json') !== packageSha256) throw new Error('PG_MIGRATION_PACKAGE_CHANGED');
  // Installed dependencies are intentionally absent from the package manifest.
  // Verify every packaged byte without treating node_modules as a new package.
  const manifest = JSON.parse(fs.readFileSync(APP + '/grabenplaner-server-manifest.json', 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length < 100) throw new Error('PG_MIGRATION_PACKAGE_MANIFEST');
  for (const item of manifest.files) {
    if (!item.path || item.path.includes('\\') || path.posix.isAbsolute(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('PG_MIGRATION_PACKAGE_PATH');
    const file = APP + '/' + item.path; assertFile(file, { privateFile: false });
    if (sha(file) !== item.sha256 || fs.statSync(file).size !== item.bytes) throw new Error('PG_MIGRATION_PACKAGE_BYTES');
  }
  execFileSync('/usr/bin/node', [APP + '/server-tools/linux/lib/verify-package.js', '--runtime-contract', APP], { stdio: 'ignore' });
  assertFile(ENV);
  const directoryAccess = require('./configuration-access');
  const previousDirectory = directoryAccess.inspect();
  if (previousDirectory.gid !== 0 || previousDirectory.mode !== 0o700) throw new Error('PG_CONFIGURATION_PREDECESSOR');
  const environment = require('node:util').parseEnv(fs.readFileSync(ENV, 'utf8'));
  if ((environment.DB_PROVIDER || 'sqlite') !== 'sqlite' || environment.DB_PATH !== '/var/lib/grabenplaner/data/dienstplan.db'
      || environment.GRABENPLANER_DATA_DIR !== '/var/lib/grabenplaner' || environment.GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG
      || environment.DATABASE_URL || environment.GRABENPLANER_DEPLOYMENT_KIND !== 'production') throw new Error('PG_MIGRATION_SOURCE_RUNTIME');
  if (fs.existsSync(ANCHOR) || fs.existsSync('/etc/grabenplaner/postgresql-operations.json')) throw new Error('PG_MIGRATION_ALREADY_ACTIVATED');
  const capacity = fs.statfsSync('/var/lib');
  if (capacity.bavail * capacity.bsize < (action === 'prepare' ? 16 : 12) * 1024 ** 3) throw new Error('PG_MIGRATION_DISK_RESERVE');
  let log;
  async function run(binary, args, { output = log, lease = true } = {}) {
    await new Promise((resolve, reject) => {
      const stdio = ['ignore', output ?? 'ignore', log ?? 'ignore'];
      if (lease) stdio.push('ignore', action === 'execute' ? 4 : 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9);
      const child = spawn(binary, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('PG_MIGRATION_NATIVE_FAILED')));
    });
  }
  const shell = command => run('/usr/bin/bash', ['-Eeuo', 'pipefail', '-c', `source ${APP}/server-tools/linux/lib/common.sh; ${command}`]);
  const startApp = () => run('/usr/bin/systemctl', ['start', 'grabenplaner.service']);
  const ready = async () => {
    const port = Number(environment.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PG_MIGRATION_PORT');
    const deadline = Date.now() + 480000;
    do {
      try { const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(5000) });
        const body = await response.json(); if (response.status === 200 && (body.ready === true || body.ok === true || body.status === 'ok')) return; } catch {}
      await delay(1000);
    } while (Date.now() < deadline);
    throw new Error('PG_MIGRATION_READINESS');
  };
  if (action === 'prepare') {
    if (fs.existsSync(ROOT) || fs.existsSync('/etc/systemd/system/' + DB_UNIT)
        || fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(line => line.startsWith('grabenplaner-db:'))) throw new Error('PG_MIGRATION_EXISTING_TARGET');
    await new Promise((resolve, reject) => { const socket = require('node:net').connect(55486, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); reject(new Error('PG_MIGRATION_PORT_OCCUPIED')); });
      socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error)); });
    fs.mkdirSync(ROOT, { mode: 0o755 });
    for (const name of ['operations', 'migration']) fs.mkdirSync(ROOT + '/' + name, { mode: 0o700 });
    if (fs.existsSync('/var/backups/grabenplaner-postgresql')) throw new Error('PG_MIGRATION_BACKUP_TARGET_EXISTS');
    fs.mkdirSync('/var/backups/grabenplaner-postgresql', { mode: 0o700 });
    log = fs.openSync(ROOT + '/prepare-private.log', 'wx', 0o600);
    await run('/usr/sbin/useradd', ['--system', '--user-group', '--home-dir', ROOT + '/data', '--no-create-home', '--shell', '/usr/sbin/nologin', 'grabenplaner-db']);
    const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':')).find(row => row[0] === 'grabenplaner-db');
    fs.mkdirSync(ROOT + '/data', { mode: 0o700 }); fs.chownSync(ROOT + '/data', Number(account[2]), Number(account[3]));
    const configuration = { format: staging.FORMAT, host: '127.0.0.1', port: 55486,
      accounts: Object.fromEntries(staging.ACCOUNTS.map(name => [name, crypto.randomBytes(32).toString('hex')])) };
    const password = ROOT + '/data/bootstrap-password';
    fs.writeFileSync(password, configuration.accounts.gp_migration_admin + '\n', { flag: 'wx', mode: 0o600 }); fs.chownSync(password, Number(account[2]), Number(account[3]));
    await run('/usr/sbin/runuser', ['-u', 'grabenplaner-db', '--', '/usr/lib/postgresql/18/bin/initdb', '-D', ROOT + '/data/cluster',
      '-U', 'gp_migration_admin', '--pwfile=' + password, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C.UTF-8']);
    fs.unlinkSync(password);
    // The service uses data/cluster, while data remains a private service-owned parent.
    const template = fs.readFileSync(APP + '/server-tools/linux/postgresql/grabenplaner-postgresql.service.in', 'utf8');
    write('/etc/systemd/system/' + DB_UNIT, template, { mode: 0o644 });
    fs.appendFileSync(ROOT + '/data/cluster/postgresql.conf', "\nlisten_addresses='127.0.0.1'\nport=55486\nunix_socket_directories=''\nmax_connections=32\nmax_locks_per_transaction=256\nshared_buffers='128MB'\nwork_mem='4MB'\nmaintenance_work_mem='64MB'\nmax_wal_size='256MB'\nmin_wal_size='80MB'\nstatement_timeout='30s'\nlock_timeout='3s'\nidle_in_transaction_session_timeout='60s'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length_on_error=0\npassword_encryption='scram-sha-256'\n");
    await run('/usr/bin/systemctl', ['daemon-reload']); await run('/usr/bin/systemctl', ['start', DB_UNIT]);
    for (let n = 0; ; n++) {
      const admin = new Client(staging.connection(configuration));
      try { await admin.connect(); configuration.clusterId = (await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id; break; }
      catch (error) { if (n > 20) throw error; await delay(500); }
      finally { await admin.end(); }
    }
    write(ROOT + '/staging-config.json', configuration);
    await staging.bootstrapPair(configuration);
    write(ROOT + '/prepared.json', { format: staging.FORMAT, packageSha256, clusterId: configuration.clusterId,
      createdAt: new Date().toISOString(), productActivation: false });
    fs.closeSync(log); process.stdout.write(JSON.stringify({ prepared: true, clusterId: configuration.clusterId, productActivation: false }) + '\n'); return;
  }
  assertFile(ROOT + '/prepared.json'); assertFile(ROOT + '/staging-config.json');
  const prepared = JSON.parse(fs.readFileSync(ROOT + '/prepared.json', 'utf8'));
  const configuration = staging.validateConfiguration(JSON.parse(fs.readFileSync(ROOT + '/staging-config.json', 'utf8')));
  if (prepared.packageSha256 !== packageSha256 || prepared.clusterId !== configuration.clusterId || prepared.format !== staging.FORMAT) throw new Error('PG_MIGRATION_PREPARED_BINDING');
  const runId = crypto.randomUUID(), directory = ROOT + '/migration/' + runId;
  fs.mkdirSync(directory, { mode: 0o700 }); write(directory + '/ownership-marker', staging.FORMAT + '\n');
  log = fs.openSync(directory + '/execution-private.log', 'wx', 0o600);
  let transfer, promotion, configurationDirectoryGroup;
  const changed = [];
  const install = (file, contents, options) => { write(file, contents, options); changed.push(file); };
  try {
    await require('../../../lib/persistence/postgresql/operations/cutover').performCutover({
      async preflight() {
        await run('/usr/bin/systemctl', ['is-active', '--quiet', 'grabenplaner.service']);
        const admin = new Client(staging.connection(configuration));
        try { await admin.connect(); await staging.assertCluster(admin, configuration, ['postgres', 'gp_migration_core', 'gp_migration_sales']); } finally { await admin.end(); }
        for (const target of Object.values(templates).filter(file => !file.endsWith('/' + DB_UNIT))) if (fs.existsSync(target)) throw new Error('PG_MIGRATION_UNIT_EXISTS');
        assertFile('/etc/grabenplaner/offsite/installed-contract.json');
        const offsite = JSON.parse(fs.readFileSync('/etc/grabenplaner/offsite/installed-contract.json', 'utf8'));
        if (![9,10].includes(offsite.moduleVersion)) throw new Error('PG_MIGRATION_OFFSITE_V9_REQUIRED');
        await run('/usr/bin/node', [APP + '/server-tools/linux/offsite/lib/offsite-contract.js', 'verify-installed-bound',
          '/opt/grabenplaner-offsite/module', '/etc/grabenplaner/offsite/installed-contract.json']);
      },
      stopApplication: () => shell('gp_stop_service grabenplaner.service 150'),
      async captureReturnPoint() {
        await run('/usr/bin/python3', [APP + '/server-tools/linux/postgresql/capture-final-source.py', runId]);
        write(directory + '/sqlite-return-point.json', { runId, createdAt: new Date().toISOString(),
          manifestSha256: sha(directory + '/input/source/manifest.json'), database: '/var/lib/grabenplaner/data/dienstplan.db', retained: true });
      },
      async transferAndVerify() {
        const url = domain => { const value = new URL(`postgresql://127.0.0.1:55486/gp_migration_${domain}`); value.username = `gp_${domain}_migrator`; value.password = configuration.accounts[value.username]; return value.href; };
        transfer = await require('../../../lib/persistence/postgresql/transfer/history').transferHistory({ sourceRoot: directory + '/input/source',
          coreUrl: url('core'), salesUrl: url('sales'), staging: configuration, outputPath: directory + '/transfer-verification.json',
          onProgress: value => fs.appendFileSync(directory + '/progress.jsonl', JSON.stringify(value) + '\n', { mode: 0o600 }) });
      },
      async promotePair() {
        const binding = { format: require('../../../lib/persistence/postgresql/runtime-binding').FORMAT,
          profile: require('../../../lib/persistence/postgresql/runtime-binding').PROFILE, clusterId: configuration.clusterId,
          environmentId: 'grabenplaner-pair-' + crypto.randomUUID() };
        promotion = await staging.promotePair(configuration, { transferProof: transfer, binding }); write(directory + '/promotion.json', promotion);
        const workRoot = directory + '/protection'; fs.mkdirSync(workRoot, { mode: 0o700 });
        const client = new Client(staging.connection(configuration, 'core', 'reader', true));
        try { await client.connect(); write(directory + '/protection.json', await require('../../../lib/persistence/postgresql/transfer/protection').verifyProtection(client, {
          sourceRoot: directory + '/input/source', workRoot })); } finally { await client.end(); }
      },
      async installConfiguration() {
        const documents = require('../../../lib/persistence/postgresql/transfer/activation').documents({ configuration, promotion, transfer, applicationSha256: packageSha256 });
        const gp = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':')).find(row => row[0] === 'grabenplaner');
        if (!gp || !/^\d+$/.test(gp[3])) throw new Error('PG_MIGRATION_APPLICATION_ACCOUNT');
        write(directory + '/configuration-directory-return-point.json', previousDirectory);
        configurationDirectoryGroup = Number(gp[3]);
        directoryAccess.grantApplicationRead(configurationDirectoryGroup);
        install('/etc/grabenplaner/postgresql-application.json', documents.application, { gid: Number(gp[3]), mode: 0o640 });
        install(ANCHOR, documents.anchor, { gid: Number(gp[3]), mode: 0o640 });
        install('/etc/grabenplaner/postgresql-operations.json', documents.operations);
        const replacement = { DB_PROVIDER: 'postgresql', DB_PATH: ANCHOR, GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG: '/etc/grabenplaner/postgresql-application.json', BACKUP_DIR: '/var/backups/grabenplaner-postgresql' };
        const lines = fs.readFileSync(ENV, 'utf8').split(/\r?\n/).filter(line => !Object.keys(replacement).some(name => line.startsWith(name + '=')));
        write(ENV, lines.join('\n') + '\n' + Object.entries(replacement).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { replace: true });
        if (!fs.existsSync('/etc/systemd/system/grabenplaner.service.d')) fs.mkdirSync('/etc/systemd/system/grabenplaner.service.d', { mode: 0o755 });
        for (const [source, target] of Object.entries(templates)) if (!target.endsWith('/' + DB_UNIT)) install(target, fs.readFileSync(APP + '/server-tools/linux/postgresql/' + source, 'utf8'), { mode: 0o644 });
        install(managed.FILE, { format: managed.FORMAT, units: managed.expected(APP), installedAt: new Date().toISOString() });
        managed.verifyInstalled(APP);
        await run('/usr/bin/systemctl', ['daemon-reload']);
      },
      async createFirstPairedBackup() {
        const runtime = require('../../../lib/persistence/postgresql/operations/runtime');
        const result = await runtime.createBackup(runtime.loadConfiguration('/etc/grabenplaner/postgresql-operations.json'));
        write(directory + '/first-paired-backup.json', result);
      },
      async publishAuthority() {
        write(ROOT + '/authority.json', { format: 'grabenplaner-postgresql-authority-v1', runId, binding: promotion.binding,
          packageSha256, sourceSha256: transfer.sourceSha256, authoritativeProvider: 'postgresql', publishedAt: new Date().toISOString() });
        await run('/usr/bin/systemctl', ['enable', DB_UNIT, 'grabenplaner-postgresql-control.socket']);
        await run('/usr/bin/systemctl', ['start', 'grabenplaner-postgresql-control.socket']);
      },
      startApplication: startApp,
      async verifyApplication() { await ready(); const R = require('../../../lib/persistence/postgresql/operations/runtime'); await R.inspectPair(R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json')); },
      async complete() { write(directory + '/completed.json', { completed: true, runId, binding: promotion.binding, checkedAt: new Date().toISOString(),
        fullProductAcceptancePending: true, authoritativeProvider: 'postgresql' }); },
      async restoreSqliteConfiguration() {
        const source = directory + '/input/source/configuration.env';
        if (fs.existsSync(source)) write(ENV, fs.readFileSync(source, 'utf8'), { replace: true });
        for (const file of [...changed].reverse()) { assertFile(file, { privateFile: false }); fs.unlinkSync(file); }
        if (configurationDirectoryGroup !== undefined) directoryAccess.restoreRootOnly(previousDirectory, configurationDirectoryGroup);
        await run('/usr/bin/systemctl', ['daemon-reload']);
      },
      verifySqliteReadiness: ready,
      async recordFailure(value) { write(directory + '/failed.json', { runId, authoritativeProvider: value.authoritativeProvider,
        recoveryRequired: value.recoveryRequired, code: /^PG_/.test(value.error.message) ? value.error.message : 'PG_MIGRATION_FAILED', checkedAt: new Date().toISOString() }); },
    });
    process.stdout.write(JSON.stringify({ migrated: true, runId, databaseCount: 2, fullProductAcceptancePending: true }) + '\n');
  } finally { fs.closeSync(log); }
}

if (require.main === module) main().catch(error => { process.stderr.write((/^PG_/.test(error.message) ? error.message : 'PG_MIGRATION_FAILED') + '\n'); process.exitCode = 1; });
module.exports = { templates, assertFile, write };
