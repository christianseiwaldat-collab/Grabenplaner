"use strict";

const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Client } = require("pg");
const staging = require("../../lib/persistence/postgresql/transfer/staging");
const ROOT = "/home/gpadmin/grabenplaner-pg-migration-20260912/activation-12";
const BIN = "/usr/lib/postgresql/18/bin/";

async function native(name, args) {
  if (!['initdb', 'pg_ctl'].includes(name)) throw new Error('PG_ACTIVATION_TOOL');
  const descriptor = fs.openSync(ROOT + '/native-private.log', 'a', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(BIN + name, args, { stdio: ['ignore', descriptor, descriptor], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('PG_ACTIVATION_NATIVE_' + name)));
    });
  } finally { fs.closeSync(descriptor); }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0 || fs.realpathSync(ROOT) !== ROOT
      || fs.statSync(ROOT).uid !== process.getuid() || (fs.statSync(ROOT).mode & 0o077)
      || fs.readFileSync(ROOT + '/ownership-marker', 'utf8').trim() !== staging.FORMAT
      || Object.values(os.networkInterfaces()).flat().some(address => !address.internal)) throw new Error('PG_ACTIVATION_REHEARSAL_SCOPE');
  const step = process.argv[2];
  if (!['prepare', 'transfer', 'promote', 'http', 'export', 'protection'].includes(step)) throw new Error('PG_ACTIVATION_STEP');
  const configFile = ROOT + '/staging-config.json';
  let config, running = false;
  const started = performance.now();
  try {
    if (step === 'prepare') {
      if (fs.existsSync(ROOT + '/data') || fs.existsSync(configFile)) throw new Error('PG_ACTIVATION_EXISTING_TARGET');
      const capacity = fs.statfsSync(ROOT);
      if (capacity.bavail * capacity.bsize < 16 * 1024 ** 3) throw new Error('PG_ACTIVATION_DISK_RESERVE');
      config = { format: staging.FORMAT, host: '127.0.0.1', port: 55486,
        accounts: Object.fromEntries(staging.ACCOUNTS.map(name => [name, crypto.randomBytes(32).toString('hex')])) };
      const passwordFile = ROOT + '/bootstrap-password';
      fs.writeFileSync(passwordFile, config.accounts.gp_migration_admin + '\n', { flag: 'wx', mode: 0o600 });
      await native('initdb', ['-D', ROOT + '/data', '-U', 'gp_migration_admin', '--pwfile=' + passwordFile,
        '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C.UTF-8']);
      fs.unlinkSync(passwordFile);
      fs.appendFileSync(ROOT + '/data/postgresql.conf', `
listen_addresses='127.0.0.1'
port=55486
unix_socket_directories=''
max_connections=32
max_locks_per_transaction=256
shared_buffers='128MB'
work_mem='4MB'
maintenance_work_mem='64MB'
max_wal_size='256MB'
min_wal_size='80MB'
statement_timeout='30s'
lock_timeout='3s'
idle_in_transaction_session_timeout='60s'
log_statement='none'
log_min_error_statement='panic'
log_parameter_max_length_on_error=0
password_encryption='scram-sha-256'
`);
      await native('pg_ctl', ['-D', ROOT + '/data', '-l', ROOT + '/postgresql.log', '-w', 'start']); running = true;
      const admin = new Client(staging.connection(config));
      try { await admin.connect(); config.clusterId = (await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id; }
      finally { await admin.end(); }
      fs.writeFileSync(configFile, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
    } else {
      config = staging.validateConfiguration(JSON.parse(fs.readFileSync(configFile, 'utf8')));
      if (fs.existsSync(ROOT + '/data/postmaster.pid')) throw new Error('PG_ACTIVATION_ALREADY_RUNNING');
      await native('pg_ctl', ['-D', ROOT + '/data', '-l', ROOT + '/postgresql.log', '-w', 'start']); running = true;
    }
    let result;
    if (step === 'prepare') result = await staging.bootstrapPair(config);
    if (step === 'transfer') {
      const url = domain => { const value = new URL(`postgresql://127.0.0.1:55486/gp_migration_${domain}`); value.username = `gp_${domain}_migrator`; value.password = config.accounts[value.username]; return value.href; };
      result = await require('../../lib/persistence/postgresql/transfer/history').transferHistory({
        sourceRoot: '/home/gpadmin/grabenplaner-pg-migration-20260912/historical-9/source',
        coreUrl: url('core'), salesUrl: url('sales'), staging: config,
        outputPath: ROOT + '/transfer-verification.json',
        onProgress: value => fs.appendFileSync(ROOT + '/transfer-progress.jsonl', JSON.stringify(value) + '\n', { mode: 0o600 }),
      });
      result = { verified: result.verified, sourceSha256: result.sourceSha256, contentSha256: result.contentSha256,
        tables: result.tables.length, rows: result.tables.reduce((total, table) => total + table.rows, 0) };
    }
    if (step === 'promote') {
      const transferProof = JSON.parse(fs.readFileSync(ROOT + '/transfer-verification.json', 'utf8'));
      const binding = { format: require('../../lib/persistence/postgresql/runtime-binding').FORMAT,
        profile: require('../../lib/persistence/postgresql/runtime-binding').PROFILE,
        clusterId: config.clusterId, environmentId: 'grabenplaner-pair-' + crypto.randomUUID() };
      result = await staging.promotePair(config, { transferProof, binding });
      const operations = { binding, recoveryAccounts: config.accounts,
        domains: ['core', 'sales'].map(domain => ({ domain, database: 'grabenplaner_' + domain, profile: binding.profile, environmentId: binding.environmentId })) };
      fs.writeFileSync(ROOT + '/operations-config.json', JSON.stringify(operations) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (step === 'protection') {
      const workRoot = ROOT + '/protection-' + crypto.randomUUID(); fs.mkdirSync(workRoot, { mode: 0o700 });
      const client = new Client(staging.connection(config, 'core', 'reader', true));
      try { await client.connect(); result = await require('../../lib/persistence/postgresql/transfer/protection').verifyProtection(client, {
        sourceRoot: '/home/gpadmin/grabenplaner-pg-migration-20260912/historical-9/source', workRoot }); } finally { await client.end(); }
    }
    if (['http', 'export'].includes(step)) {
      const operations = JSON.parse(fs.readFileSync(ROOT + '/operations-config.json', 'utf8'));
      result = await require('../../server-tools/linux/recovery/lib/postgresql-application-smoke').qualifyHttp({
        root: ROOT, config: operations, rehearsal: 'activation-12', connectionPort: 55486,
        ...(step === 'export' ? { extraScenario: async ({ request, endpoints, password }) => {
          const started = performance.now();
          const downloading = request('/api/backup/database-download', { method: 'POST', body: {
            currentPassword: password, confirmation: 'DATABASE_BACKUP_DOWNLOAD' }, stream: true })
            .then(value => ({ value }), error => ({ error }));
          // Keep the actual application and all four warmed reader workers open.
          for (let index = 0; index < 8; index++) await request(index % 2 ? '/api/sales/articles?query=Sony&limit=20' : '/api/locations');
          const downloaded = await downloading;
          if (downloaded.error) throw downloaded.error;
          const exported = downloaded.value;
          if (exported.bytes < 100000000 || !exported.contentType.includes('application/x-tar')) throw new Error('PG_ACTIVATION_HTTP_EXPORT');
          return { passed: true, provider: 'postgresql-pair', httpExport: exported, concurrentQueries: 8,
            milliseconds: Math.round(performance.now() - started), endpoints };
        } } : {}),
      });
    }
    const proof = { ...result, step, checkedAt: new Date().toISOString(), milliseconds: Math.round(performance.now() - started),
      isolated: true, productActivation: false };
    fs.writeFileSync(ROOT + '/' + step + '-proof.json', JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(proof) + '\n');
  } finally { if (running) await native('pg_ctl', ['-D', ROOT + '/data', '-m', 'fast', '-w', 'stop']); }
}

main().catch(error => {
  fs.writeFileSync(ROOT + '/failure-private.json', JSON.stringify({ message: error.message, code: error.code, stack: error.stack }) + '\n', { mode: 0o600 });
  process.stderr.write(JSON.stringify({ failed: true, code: error.code || null, error: /^PG_|^MIGRATION_/.test(error.message) ? error.message : 'Isolated activation rehearsal failed' }) + '\n');
  process.exitCode = 1;
});
