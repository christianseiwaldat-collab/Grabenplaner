'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('../../../lib/vps-storage-contract');
const R = require('../../../lib/persistence/postgresql/operations/runtime');
const S = require('./storage-worker');
const retention = require('../../../lib/persistence/postgresql/operations/import-retention');
const lifecycle = require('./lifecycle-status');
const APP = '/opt/grabenplaner/app';
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 3) throw new Error('VPS_STORAGE_ROOT_REQUIRED');
  const request = C.validateRequest(JSON.parse(process.argv[2]));
  if (request.action !== 'retire-imports') throw new Error('VPS_STORAGE_REQUEST_INVALID');
  for (const fd of [3, 9]) if (fs.realpathSync('/proc/self/fd/' + fd) !== '/run/grabenplaner/maintenance.lock') throw new Error('VPS_STORAGE_LEASE_REQUIRED');
  if (fs.realpathSync('/proc/self/fd/4') !== '/run/grabenplaner/update-backup-owner.json') throw new Error('VPS_STORAGE_LEASE_REQUIRED');
  const config = R.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  const prior = S.publicStatus(config);
  if (!prior.imports?.canRetire || prior.imports.planSha256 !== request.planSha256) throw new Error('VPS_STORAGE_IMPORT_PLAN_CHANGED');
  const resultFile = config.workDirectory + '/' + request.requestId + '.lifecycle-backup.json';
  const log = fs.openSync(config.workDirectory + '/' + request.requestId + '.storage-import-private.log', 'wx', 0o600);
  const startedAt = new Date().toISOString(), state = { requestId: request.requestId, action: request.action, phase: 'preparing', startedAt };
  let stopped = false, interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  const run = (binary, args, output = log) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', output, log, 3, 4, 'ignore', 'ignore', 'ignore', 'ignore', 9] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('VPS_STORAGE_NATIVE_FAILED')));
  });
  const ready = async () => {
    const env = require('node:util').parseEnv(fs.readFileSync(config.environmentFile, 'utf8')), port = Number(env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VPS_STORAGE_CONFIGURATION_INVALID');
    const deadline = Date.now() + 180000;
    do { try { const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(5000) });
      if (response.status === 200) { const body = await response.json(); if (body.ready === true || body.ok === true || body.status === 'ok') return; }
    } catch {} await delay(1000); } while (Date.now() < deadline);
    throw new Error('VPS_STORAGE_READINESS_FAILED');
  };
  const publish = (phase, extra = {}) => S.operation(config, { ...state, phase, ...extra });
  try {
    if (fs.existsSync(resultFile)) throw new Error('VPS_STORAGE_REQUEST_REPLAY');
    await run('/usr/bin/systemctl', ['is-active', '--quiet', 'grabenplaner.service']);
    await lifecycle.publish(request.requestId, 'restart', 'preparing', resultFile);
    publish('preparing');
    process.stdout.write(JSON.stringify({ accepted: true, requestId: request.requestId, acceptedAt: startedAt }) + '\n');
    await delay(1000);
    stopped = true;
    await run('/usr/bin/bash', ['-Eeuo', 'pipefail', '-c', `source ${APP}/server-tools/linux/lib/common.sh; gp_stop_service grabenplaner.service 150`]);
    publish('backup');
    const output = fs.openSync(resultFile, 'wx', 0o600);
    try { await run('/usr/bin/bash', [APP + '/server-tools/linux/backup-grabenplaner.sh', '--env-file', config.environmentFile,
      '--app-dir', APP, '--data-dir', config.sourceFiles, '--backup-dir', config.backupDirectory, '--service', 'grabenplaner.service',
      '--node', '/usr/bin/node', '--service-user', 'grabenplaner', '--service-group', 'grabenplaner', '--lock-already-held'], output);
      fs.fsyncSync(output);
    } finally { fs.closeSync(output); }
    const backup = await lifecycle.verifyResult(resultFile, request.requestId, { completeContent: true });
    if (interrupted) throw new Error('VPS_STORAGE_INTERRUPTED');
    publish('retiring', { backupVerified: true });
    const proof = await S.withClients(config, async (core, sales, protection) => {
      if (!protection) throw new Error('VPS_STORAGE_IMPORT_KEY_INVALID');
      const before = await businessEvidence(sales);
      const result = await retention.retireImports({ core, sales, protection, expectedPlan: request.planSha256,
        progress: async value => { if (interrupted) throw new Error('VPS_STORAGE_INTERRUPTED'); publish('retiring', { backupVerified: true, progress: value }); } });
      publish('compacting', { backupVerified: true, progress: result });
      // Only redundant import storage is rewritten; business tables and their
      // relationships are never delete/compact targets of this operation.
      await sales.query("SET lock_timeout='3s'");
      await sales.query("SET statement_timeout='20min'");
      await sales.query("SET maintenance_work_mem='64MB'");
      for (const table of ['data_import_changes', 'data_import_rows', 'data_import_row_payload_refs', 'data_import_change_payload_refs', 'data_import_payload_blocks', 'data_import_events']) {
        if (interrupted) throw new Error('VPS_STORAGE_INTERRUPTED');
        await sales.query('VACUUM (FULL, ANALYZE) integration.' + table);
      }
      await core.query("SET lock_timeout='3s'");await core.query("SET statement_timeout='20min'");await core.query("SET maintenance_work_mem='64MB'");
      await core.query('VACUUM (FULL, ANALYZE) gp.data_import_sources');
      const after = await businessEvidence(sales);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('VPS_STORAGE_BUSINESS_VERIFICATION_FAILED');
      if (Number((await sales.query('SELECT count(*) AS count FROM pg_index WHERE NOT indisvalid OR NOT indisready')).rows[0].count) !== 0) throw new Error('VPS_STORAGE_INDEX_VERIFICATION_FAILED');
      return { result, businessEvidence: after, businessCountsUnchanged: true, backup };
    }, { readOnly: false });
    S.writePrivate(config, request.requestId + '.storage-import-proof.json', proof);
    publish('starting', { backupVerified: true });
    await run('/usr/bin/systemctl', ['start', 'grabenplaner.service']); await ready(); stopped = false;
    await lifecycle.publish(request.requestId, 'restart', 'completed', resultFile);
    await S.inspect(config);
    publish('complete', { backupVerified: true, result: proof.result, finishedAt: new Date().toISOString() });
  } catch (error) {
    let recoveryFailed = false;
    if (stopped) { try { await run('/usr/bin/systemctl', ['start', 'grabenplaner.service']); await ready(); } catch { recoveryFailed = true; } }
    await lifecycle.publish(request.requestId, 'restart', 'failed', resultFile).catch(() => {});
    publish('failed', { code: S.safeCode(error), recoveryFailed, finishedAt: new Date().toISOString() });
    throw error;
  } finally { process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); fs.closeSync(log); }
}
async function businessEvidence(client) {
  const tables = ['integration.data_import_links', 'integration.import_master_records', 'integration.import_master_segments', 'integration.import_master_relations', 'integration.import_master_bindings',
    'integration.import_history_records', 'integration.import_history_versions', 'integration.import_history_segments', 'integration.import_history_references'];
  const counts = {};
  for (const table of tables) counts[table] = (await client.query('SELECT count(*)::text AS count,bit_xor(hashtextextended(t::text,0))::text AS contentFingerprint FROM ' + table + ' t')).rows[0];
  const schemaSha256 = await require('../../../lib/persistence/postgresql/core/fingerprint').schemaFingerprint(client,
    require('../../../lib/persistence/postgresql/sales/layout').SCHEMAS);
  return { counts, schemaSha256 };
}
if (require.main === module) main().catch(error => { process.stderr.write(S.safeCode(error) + '\n'); process.exitCode = 1; });
module.exports = { businessEvidence };
