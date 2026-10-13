'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const C = require('../../../lib/vps-storage-contract');
const R = require('../../../lib/persistence/postgresql/operations/runtime');
const residuals = require('../../../lib/persistence/postgresql/operations/storage-residuals');
const retention = require('../../../lib/persistence/postgresql/operations/import-retention');
const APP = '/opt/grabenplaner/app';
const REPORT = 'vps-storage.json', POLICY = 'vps-storage-policy.json';
function readPrivate(config, name, fallback) {
  const file = path.join(config.workDirectory, name);
  if (!fs.existsSync(file)) return fallback;
  residuals.privateEntry(file);
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('VPS_STORAGE_STATE_SIZE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writePrivate(config, name, value) {
  const target = path.join(config.workDirectory, name), temporary = target + '.' + crypto.randomUUID() + '.tmp';
  if (fs.existsSync(target)) residuals.privateEntry(target);
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
}
const policy = config => C.validateSettings(readPrivate(config, POLICY, C.DEFAULTS));
const operation = (config, value) => writePrivate(config, REPORT, { ...readPrivate(config, REPORT, {}), operation: value });
function disk(directory) {
  const stat = fs.statfsSync(directory);
  return { totalBytes: stat.blocks * stat.bsize, usedBytes: (stat.blocks - stat.bfree) * stat.bsize,
    freeBytes: stat.bavail * stat.bsize, reservedBytes: (stat.bfree - stat.bavail) * stat.bsize };
}
function directoryBytes(directory) {
  const text = execFileSync('/usr/bin/du', ['-sx', '--block-size=1', '--', directory], { encoding: 'utf8', timeout: 30000, maxBuffer: 4096 });
  const value = Number(text.match(/^\d+/)?.[0]);
  if (!Number.isSafeInteger(value)) throw new Error('VPS_STORAGE_MEASUREMENT_FAILED'); return value;
}
async function withClients(config, work, { readOnly = true } = {}) {
  const { Client } = require('pg');
  const core = new Client({ ...R.url(config, config.domains[0]), application_name: 'gp-vps-storage', statement_timeout: 120000 });
  const sales = new Client({ ...R.url(config, config.domains[1]), application_name: 'gp-vps-storage', statement_timeout: 120000 });
  let protection;
  try {
    await core.connect(); await sales.connect();
    if (readOnly) { await core.query('BEGIN READ ONLY'); await sales.query('BEGIN READ ONLY'); }
    else { await core.query('SET ROLE gp_core_owner'); await sales.query('SET ROLE gp_sales_owner'); }
    const env = require('node:util').parseEnv(fs.readFileSync(config.environmentFile, 'utf8'));
    protection = await importProtection(core, env);
    return await work(core, sales, protection, env);
  } finally { protection?.destroy(); await Promise.allSettled([core.end(), sales.end()]); }
}
async function importProtection(core, env) {
  const configuration = require('../recovery/lib/recovery-verify').encryptionConfiguration(new Map(Object.entries(env)));
  const vault = require('../../../lib/integration-secret-vault').createIntegrationSecretVault({ activeKeyId: configuration.integrationKeyId, keys: configuration.integrationKeys });
  const rows = (await core.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1'")).rows;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('VPS_STORAGE_IMPORT_KEY_INVALID');
  let protection;
  await vault.useSecret(rows[0].payload, { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' }, bytes => {
    if (bytes.length !== 64) throw new Error('VPS_STORAGE_IMPORT_KEY_INVALID');
    protection = require('../../../lib/data-import-protection').createDataImportProtection({ encryptionKey: bytes.subarray(0, 32), indexKey: bytes.subarray(32), keyId: 'data-import-v1', compression: true });
  });
  return protection;
}
async function inspect(config) {
  const settings = policy(config), backup = await residuals.inspectResiduals(config.backupDirectory, { ageDays: settings.orphanAgeDays });
  const metrics = await withClients(config, async (core, sales, protection) => {
    const databases = [];
    for (const [client, domain] of [[core, 'core'], [sales, 'sales']]) databases.push({ domain,
      bytes: Number((await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes) });
    const relations = (await sales.query(`SELECT n.nspname AS schema,c.relname AS name,
      pg_total_relation_size(c.oid)::text AS total_bytes,pg_indexes_size(c.oid)::text AS index_bytes,
      (pg_total_relation_size(c.oid)-pg_indexes_size(c.oid))::text AS data_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname IN ('gp','integration','trade','kassa','reporting')
      ORDER BY pg_total_relation_size(c.oid) DESC`)).rows.map(row => ({ schema: row.schema, name: row.name,
        totalBytes: Number(row.total_bytes), indexBytes: Number(row.index_bytes), dataBytes: Number(row.data_bytes) }));
    const imports = protection ? await retention.inspectImports(core, sales, protection) : { pairs: [], blocked: [], planSha256: C.digest([]), rows: 0, changes: 0 };
    return { databases, relations, imports: { pairs: imports.pairs, blocked: imports.blocked, planSha256: imports.planSha256, rows: imports.rows, changes: imports.changes } };
  });
  const latest = backup.complete[0];
  const recovery = latest ? require('../../../lib/persistence/postgresql/operations/restore-capacity').restoreCapacity(latest.manifest) : null;
  const capacity = disk(config.backupDirectory), temporaryBytes = latest ? latest.bytes * 2 : null;
  const restoreMarginBytes = recovery ? capacity.freeBytes - recovery.requiredBytes - temporaryBytes : null;
  const categories = [['postgresql', 'PostgreSQL-Daten', '/var/lib/grabenplaner-postgresql/data'],
    ['backups', 'Lokale Sicherungen', config.backupDirectory], ['application', 'GP-Programm', APP],
    ['files', 'Bilder und Dokumente', config.sourceFiles], ['logs', 'Systemprotokolle', '/var/log'],
    ['packages', 'Paketcache', '/var/cache/apt']].map(([id, label, directory]) => ({ id, label, bytes: directoryBytes(directory) }));
  categories.push({id:'other',label:'Betriebssystem und weitere Dateien',bytes:Math.max(0,capacity.usedBytes-categories.reduce((sum,item)=>sum+item.bytes,0))});
  const report = { format: C.FORMAT, checkedAt: new Date().toISOString(), settings, disk: capacity, categories,
    host: { system: os.type(), release: os.release(), architecture: os.arch(), cpuCount: os.cpus().length, uptimeSeconds: Math.floor(os.uptime()), memoryTotalBytes: os.totalmem(), memoryFreeBytes: os.freemem() },
    databases: metrics.databases, relations: metrics.relations.slice(0, 18), indexBytes: metrics.relations.reduce((sum, r) => sum + r.indexBytes, 0),
    identityLinkBytes: metrics.relations.find(r => r.name === 'data_import_links')?.totalBytes ?? null,
    backups: { keepCount: config.localBackupRetention?.keepCount ?? null, points: backup.complete.map(({ name, createdAt, bytes, verificationScope }) => ({ name, createdAt, bytes, verificationScope })),
      unknownCount: backup.unknown.length, candidates: backup.candidates.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt })),
      planSha256: backup.planSha256, canCleanup: backup.complete.length >= 2 && backup.candidates.length > 0 },
    recovery: { requiredBytes: recovery?.requiredBytes ?? null, temporaryBytes, restoreMarginBytes, basis: recovery?.basis ?? null,
      warning: restoreMarginBytes === null || restoreMarginBytes < settings.warningGiB * 1024 ** 3 },
    imports: { ...metrics.imports, pairs: metrics.imports.pairs.map(({ label, createdAt, successorCreatedAt, runs }) => ({ label, createdAt, successorCreatedAt, rows: runs.reduce((sum, r) => sum + r.rows, 0) })),
      canRetire: metrics.imports.pairs.length > 0 && metrics.imports.pairs.length <= 50, complete: metrics.imports.pairs.length <= 50 },
    operation: { phase: 'complete', finishedAt: new Date().toISOString() } };
  const privatePlan = { backup, imports: metrics.imports };
  writePrivate(config, 'vps-storage-plan.json', privatePlan);
  writePrivate(config, REPORT, report);
  return report;
}
function publicStatus(config) {
  const report = readPrivate(config, REPORT, { format: C.FORMAT, checkedAt: null, operation: null });
  return { ...report, settings: policy(config), available: true };
}
function safeCode(error) { return /^VPS_STORAGE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'VPS_STORAGE_OPERATION_FAILED'; }
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 3) throw new Error('VPS_STORAGE_ROOT_REQUIRED');
  const request = C.validateRequest(JSON.parse(process.argv[2])), config = R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  if (fs.realpathSync('/proc/self/fd/3') !== '/run/grabenplaner/maintenance.lock') throw new Error('VPS_STORAGE_LEASE_REQUIRED');
  const startedAt = new Date().toISOString();
  try {
    operation(config, { requestId: request.requestId, action: request.action, phase: 'running', startedAt });
    process.stdout.write(JSON.stringify({ accepted: true, acceptedAt: startedAt, requestId: request.requestId }) + '\n');
    let result = null;
    if (request.action === 'settings') writePrivate(config, POLICY, C.validateSettings(request.settings));
    else if (request.action === 'cleanup') {
      const current = readPrivate(config, REPORT, {});
      if (!current.backups?.canCleanup || current.backups.planSha256 !== request.planSha256) throw new Error('VPS_STORAGE_PLAN_CHANGED');
      result = await residuals.removeResiduals(config.backupDirectory, request.planSha256, { ageDays: policy(config).orphanAgeDays,
        validateBackup: proof => {
          if (proof.manifest.databases.some((d,index) => d.database !== config.domains[index].database)
              || proof.manifest.checkpoint?.domains?.core?.clusterId !== config.clusterId
              || proof.manifest.checkpoint?.domains?.sales?.clusterId !== config.clusterId) throw new Error('VPS_STORAGE_BACKUP_BINDING_INVALID');
        },
        record: proof => writePrivate(config, request.requestId + '.storage-cleanup-proof.json', proof) });
    } else if (request.action !== 'inspect') throw new Error('VPS_STORAGE_REQUEST_INVALID');
    await inspect(config);
    operation(config, { requestId: request.requestId, action: request.action, phase: 'complete', startedAt, finishedAt: new Date().toISOString(), result });
  } catch (error) {
    operation(config, { requestId: request.requestId, action: request.action, phase: 'failed', startedAt, finishedAt: new Date().toISOString(), code: safeCode(error) });
    throw error;
  }
}
async function serve(request, config) {
  C.validateRequest(request);
  const reply = value => process.stdout.write(JSON.stringify({ format: C.FORMAT, requestId: request.requestId, action: request.action, ...value }) + '\n');
  if (request.action === 'status') { reply({ accepted: true, report: publicStatus(config) }); return; }
  const lock = fs.lstatSync('/run/grabenplaner/maintenance.lock');
  if (!lock.isFile() || lock.uid !== 0 || lock.nlink !== 1 || (lock.mode & 0o777) !== 0o600 || fs.realpathSync('/run/grabenplaner/maintenance.lock') !== '/run/grabenplaner/maintenance.lock') throw new Error('VPS_STORAGE_LEASE_REQUIRED');
  const script = APP + '/server-tools/linux/postgresql/' + (request.action === 'retire-imports' ? 'storage-import-maintenance.sh' : 'storage-worker.js');
  const stat = fs.lstatSync(script);
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o022 || fs.realpathSync(script) !== script) throw new Error('VPS_STORAGE_SCRIPT_UNSAFE');
  const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '/run/grabenplaner/maintenance.lock',
    request.action === 'retire-imports' ? '/usr/bin/bash' : '/usr/bin/node', script, JSON.stringify(request)], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let answered = false, body = '', bytes = 0;
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > 4096) return child.kill('SIGTERM');
    body += chunk.toString('utf8'); if (answered || !body.includes('\n')) return;
    try { const value = JSON.parse(body.split('\n', 1)[0]);
      if (value.requestId !== request.requestId || value.accepted !== true) throw new Error();
      answered = true; reply({ accepted: true, acceptedAt: value.acceptedAt });
    } catch { child.kill('SIGTERM'); }
  });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => {
    if (!answered) reply({ accepted: false, code: code === 73 ? 'VPS_STORAGE_MAINTENANCE_BUSY' : 'VPS_STORAGE_OPERATION_FAILED' });
    if (request.action === 'retire-imports' && code !== 0) process.exitCode = 1;
    resolve();
  }); });
}
if (require.main === module) main().catch(error => { process.stderr.write(safeCode(error) + '\n'); process.exitCode = 1; });
module.exports = { readPrivate, writePrivate, operation, disk, policy, withClients, importProtection, inspect, publicStatus, serve, safeCode };
