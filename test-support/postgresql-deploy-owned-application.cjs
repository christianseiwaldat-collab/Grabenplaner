'use strict';

// Explicit native qualification only. The caller prepares a NEW complete-schema
// synthetic cluster, enters PrivateNetwork=yes, and binds that cluster to 55484.
// This helper never creates a product binding, reads an installed product DB,
// opens an external endpoint, or claims the full Sales recovery smoke.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Client } = require('pg');
const { seedCoreFixture } = require('./postgresql-migration/sqlite-source');
const { qualifyHttp } = require('../server-tools/linux/recovery/lib/postgresql-application-smoke');
const ROOT_PATTERN = /^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/([a-f0-9-]{36})\/work\/application$/;
const FORMAT = 'gp-complete-schema-owned-application-smoke-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function ownedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || fs.realpathSync(directory) !== directory) fail('GP_OWNED_SMOKE_DIRECTORY');
}
function readPrivate(file, runRoot) {
  if (!path.isAbsolute(file) || !file.startsWith(runRoot + '/') || fs.realpathSync(file) !== file) fail('GP_OWNED_SMOKE_INPUT');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size < 1 || stat.size > 65536) fail('GP_OWNED_SMOKE_INPUT');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writePrivate(file, value) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

async function qualifyOwnedApplication({ root, environmentFile, clusterMarker, dataDirectory }) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !ROOT_PATTERN.test(root || '')
    || Object.values(os.networkInterfaces()).flat().some(address => !address.internal)) fail('GP_OWNED_SMOKE_ISOLATION');
  ownedDirectory(root);
  const runRoot = path.dirname(path.dirname(root)); ownedDirectory(runRoot);
  if (!dataDirectory || !dataDirectory.startsWith(runRoot + '/') || fs.realpathSync(dataDirectory) !== dataDirectory) fail('GP_OWNED_SMOKE_DATA_DIRECTORY');
  ownedDirectory(dataDirectory);
  const marker = readPrivate(clusterMarker, runRoot), environment = readPrivate(environmentFile, runRoot);
  if (marker.format !== 'gp-deploy-owned-local-v1' || marker.host !== '127.0.0.1' || marker.port !== 55482
    || marker.bootstrapRole !== 'gp_migration_admin' || marker.database !== 'grabenplaner_test' || !/^[0-9]+$/.test(marker.clusterId || '')) fail('GP_OWNED_SMOKE_MARKER');
  // The dedicated bootstrap marker retains its original port 55482 label.
  // Actual application endpoints and live server settings must all be 55484.
  const accounts = {}, urls = {};
  for (const domain of ['core', 'sales']) for (const purpose of ['migrator', 'app', 'reader']) {
    const role = 'gp_' + domain + '_' + purpose, url = new URL(environment[role.toUpperCase() + '_URL'] || '');
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55484' || url.pathname !== '/gp_migration_' + domain
      || decodeURIComponent(url.username) !== role || decodeURIComponent(url.password).length < 24 || url.search || url.hash) fail('GP_OWNED_SMOKE_ENDPOINT');
    accounts[role] = decodeURIComponent(url.password); urls[role] = url.href;
  }
  const adminUrl = new URL(environment.GP_MIGRATION_ADMIN_URL || environment.TEST_POSTGRESQL_URL || '');
  if (adminUrl.protocol !== 'postgresql:' || adminUrl.hostname !== '127.0.0.1' || adminUrl.port !== '55484'
    || decodeURIComponent(adminUrl.username) !== 'gp_migration_admin' || decodeURIComponent(adminUrl.password).length < 24 || adminUrl.pathname !== '/grabenplaner_test' || adminUrl.search || adminUrl.hash) fail('GP_OWNED_SMOKE_ADMIN_ENDPOINT');
  const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  await admin.connect();
  try {
    const state = (await admin.query("SELECT system_identifier::text AS cluster_id,current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,current_setting('port') AS port,(SELECT rolname FROM pg_authid WHERE oid=10) AS bootstrap FROM pg_control_system()")).rows[0];
    if (state.cluster_id !== marker.clusterId || state.data !== dataDirectory || state.listen !== '127.0.0.1' || state.port !== '55484' || state.bootstrap !== 'gp_migration_admin') fail('GP_OWNED_SMOKE_CLUSTER_IDENTITY');
    const databases = (await admin.query("SELECT datname FROM pg_database WHERE datname IN ('gp_migration_core','gp_migration_sales') ORDER BY datname")).rows.map(r => r.datname);
    if (databases.join(',') !== 'gp_migration_core,gp_migration_sales') fail('GP_OWNED_SMOKE_COMPLETE_PAIR');
    const others = (await admin.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].count;
    if (others !== 0) fail('GP_OWNED_SMOKE_FOREIGN_CLIENTS');
  } finally { await admin.end(); }
  const core = new Client({ connectionString: urls.gp_core_migrator, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const sales = new Client({ connectionString: urls.gp_sales_migrator, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  await core.connect(); await sales.connect();
  let pairSchema;
  try {
    await core.query('SET search_path=pg_catalog,gp');
    await sales.query('SET search_path=' + require('../lib/persistence/postgresql/sales/layout').SEARCH_PATH);
    const { verifyEnvironment } = require('../lib/persistence/postgresql/core/environment');
    await verifyEnvironment(core, { purpose: 'migrator' }); await verifyEnvironment(sales, { domain: 'sales', purpose: 'migrator' });
    await require('../lib/persistence/postgresql/boundary/migrate').verifyCoreSchema(core, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
    const { schemaFingerprint } = require('../lib/persistence/postgresql/core/fingerprint');
    const salesDigest = await schemaFingerprint(sales, require('../lib/persistence/postgresql/sales/layout').SCHEMAS);
    const ledger = (await sales.query('SELECT stage,target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows;
    if (ledger.length !== 1 || Number(ledger[0].stage) !== 8 || await require('../lib/persistence/postgresql/sales/import-delete').target(sales, ledger[0].target_sha256) !== salesDigest) fail('GP_OWNED_SMOKE_SALES_SCHEMA');
    pairSchema = { core: await schemaFingerprint(core), sales: salesDigest };
    const names = ['settings', 'cost_center_types', 'cost_centers', 'locations', 'positions', 'departments', 'employees', 'portal_users', 'portal_roles'];
    const occupied = (await core.query(names.map(name => 'SELECT EXISTS(SELECT 1 FROM gp."' + name + '") AS occupied').join(' UNION ALL '))).rows;
    if (occupied.some(row => row.occupied)) fail('GP_OWNED_SMOKE_REFUSES_BUSINESS_DATA');
    const sql = [];
    seedCoreFixture({ exec(statement) { if (!['BEGIN', 'COMMIT'].includes(statement)) fail('GP_OWNED_SMOKE_SEED_CONTROL'); }, prepare(statement) {
      return { run(...values) { let index = 0; sql.push({ sql: statement.replace(/^INSERT INTO /, 'INSERT INTO gp.').replace(/\?/g, () => '$' + (++index)), values }); } };
    } }, 1);
    await core.query('BEGIN'); await core.query('SET LOCAL ROLE gp_core_owner');
    for (const command of sql) await core.query(command.sql, command.values);
    await core.query("INSERT INTO gp.settings(key,value) VALUES('migration-test-owner',$1)", [FORMAT + ':' + ROOT_PATTERN.exec(root)[1]]);
    await core.query("INSERT INTO gp.portal_roles(id,name,permissions) VALUES('developer','Synthetic native qualification','[\"*\"]')");
    // The initial Ready check precedes creation of the randomized smoke-login
    // account. Reuse the existing native fixture's non-login bootstrap sentinel.
    await core.query("INSERT INTO gp.portal_users(employee_number,password_hash,role,active) VALUES('00001','synthetic-bootstrap-no-login','developer',1)");
    await core.query('COMMIT');
  } catch (error) { await core.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await core.end(); await sales.end(); }
  // Only fresh synthetic encryption material is used; it remains inside this
  // private run. No secret values or account URLs appear in the public receipt.
  const config = { recoveryAccounts: accounts, domains: ['core', 'sales'].map(domain => ({ domain, database: 'gp_migration_' + domain })) };
  writePrivate(root + '/ownership-marker', 'grabenplaner-postgresql-full-application-v1\n');
  writePrivate(root + '/operations-config.json', JSON.stringify(config) + '\n');
  const integrationKey = crypto.randomBytes(32).toString('base64');
  writePrivate(root + '/source-encryption.env', 'GRABENPLANER_AMU_KEY_ID=synthetic-owned-smoke\nGRABENPLANER_AMU_KEY=' + crypto.randomBytes(32).toString('base64')
    + '\nGRABENPLANER_INTEGRATION_KEY_ID=synthetic-owned-smoke\nGRABENPLANER_INTEGRATION_KEY=' + integrationKey
    + '\nGRABENPLANER_INTEGRATION_KEYS=' + JSON.stringify({ 'synthetic-owned-smoke': integrationKey }) + '\n');
  const sourceRoot = path.resolve(__dirname, '..'), startedAt = new Date().toISOString();
  const application = await qualifyHttp({ root, config, rehearsal: 'paired-restore', connectionPort: 55484, scenario: 'deploy-owned' });
  if (!application.passed || !application.ownedApplicationSmoke || application.fullApplicationSmoke !== false) fail('GP_OWNED_SMOKE_RESULT');
  const receipt = { format: FORMAT, syntheticOnly: true, productionContact: false, providerId: 'postgresql-deploy-owned', completeSchema: true,
    fullRecovery: false, fullSalesRecovery: false, root, clusterId: marker.clusterId, schemaSha256: pairSchema,
    source: { version: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'))).version,
      serverSha256: sha(fs.readFileSync(path.join(sourceRoot, 'server.js'))),
      smokeSha256: sha(fs.readFileSync(path.join(sourceRoot, 'server-tools/linux/recovery/lib/postgresql-application-smoke.js'))) },
    startedAt, completedAt: new Date().toISOString(), application };
  writePrivate(root + '/complete-schema-owned-smoke.json', JSON.stringify(receipt) + '\n');
  return receipt;
}

if (require.main === module) {
  const options = {}; const args = process.argv.slice(2);
  const names = { '--root': 'root', '--environment-file': 'environmentFile', '--cluster-marker': 'clusterMarker', '--data-directory': 'dataDirectory' };
  for (let i = 0; i < args.length; i += 2) { if (!names[args[i]] || !args[i + 1] || Object.hasOwn(options, names[args[i]])) fail('GP_OWNED_SMOKE_ARGUMENTS'); options[names[args[i]]] = args[i + 1]; }
  qualifyOwnedApplication(options).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    // Native fixture diagnostics remain private to the validated synthetic run.
    // The public process output never includes SQL, URLs, passwords or stacks.
    try {
      if (process.platform === 'linux' && process.getuid() !== 0 && ROOT_PATTERN.test(options.root || '')) {
        ownedDirectory(options.root);
        writePrivate(options.root + '/complete-schema-owned-smoke.failure.private.json', JSON.stringify({
          format: FORMAT + '-private-failure', failedAt: new Date().toISOString(),
          code: error.code || null, message: String(error.message || ''), stack: String(error.stack || ''),
        }) + '\n');
      }
    } catch { /* Preserve the original failure even if private logging fails. */ }
    process.stderr.write(JSON.stringify({ failed: true, code: /^GP_|^PG_/.test(error.code || '') ? error.code : 'GP_OWNED_APP_SMOKE_FAILED' }) + '\n'); process.exitCode = 1;
  });
}
module.exports = { qualifyOwnedApplication };
