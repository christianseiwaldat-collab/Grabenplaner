'use strict';
// Dedicated fresh synthetic cluster bootstrap. Existing CI bootstrap contracts
// remain unchanged; this fixture begins with the real recovery bootstrap OID.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Client } = require('pg');
const { PROFILE, ENVIRONMENT_ID } = require('../lib/persistence/postgresql/core/environment');
const FORMAT = 'gp-deploy-owned-local-v1', ROOT = /^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/[a-f0-9-]{36}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function owned(name, file = false) {
  const stat = fs.lstatSync(name);
  if ((file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) || stat.isSymbolicLink() || fs.realpathSync(name) !== name
    || stat.uid !== process.getuid() || stat.mode & 0o077 || file && (stat.size < 1 || stat.size > 65536)) fail('GP_OWNED_BOOTSTRAP_PATH');
}
async function bootstrap({ root, environmentFile, clusterMarker, dataDirectory }) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !ROOT.test(root || '')
    || Object.values(os.networkInterfaces()).flat().some(item => !item.internal)) fail('GP_OWNED_BOOTSTRAP_ISOLATION');
  owned(root);
  if (path.dirname(environmentFile || '') !== root || fs.existsSync(environmentFile) || path.dirname(clusterMarker || '') !== root
    || !dataDirectory?.startsWith(root + '/')) fail('GP_OWNED_BOOTSTRAP_BOUNDARY');
  owned(clusterMarker, true); owned(dataDirectory);
  const marker = JSON.parse(fs.readFileSync(clusterMarker, 'utf8'));
  if (marker.format !== FORMAT || marker.host !== '127.0.0.1' || marker.port !== 55482 || marker.database !== 'grabenplaner_test'
    || marker.bootstrapRole !== 'gp_migration_admin' || !/^[0-9]+$/.test(marker.clusterId || '')) fail('GP_OWNED_BOOTSTRAP_MARKER');
  const connection = new URL(process.env.TEST_POSTGRESQL_URL || '');
  if (connection.protocol !== 'postgresql:' || connection.hostname !== '127.0.0.1' || connection.port !== '55482'
    || connection.pathname !== '/grabenplaner_test' || decodeURIComponent(connection.username) !== 'gp_migration_admin' || connection.search || connection.hash) fail('GP_OWNED_BOOTSTRAP_ENDPOINT');
  const client = new Client({ connectionString: connection.href, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const environment = { TEST_POSTGRESQL_BIN: '/usr/lib/postgresql/18/bin', GP_CI_POSTGRESQL_FIXTURE: 'deploy-owned-local-v1', GP_PG_LOCAL_FIXTURE_MARKER: clusterMarker, GP_PG_MIGRATION_LIVE: '1' };
  await client.connect();
  try {
    const state = (await client.query("SELECT system_identifier::text AS id,current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,current_setting('port') AS port,current_user AS role,(SELECT oid::integer FROM pg_roles WHERE rolname=current_user) AS oid FROM pg_control_system()")).rows[0];
    if (state.id !== marker.clusterId || state.data !== dataDirectory || state.listen !== '127.0.0.1' || state.port !== '55482' || state.role !== marker.bootstrapRole || state.oid !== 10) fail('GP_OWNED_BOOTSTRAP_CLUSTER');
    const users = (await client.query('SELECT rolname FROM pg_roles ORDER BY rolname')).rows.map(row => row.rolname).filter(name => !name.startsWith('pg_'));
    const databases = (await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(row => row.datname);
    if (users.join(',') !== 'gp_migration_admin' || databases.join(',') !== 'grabenplaner_test,postgres') fail('GP_OWNED_BOOTSTRAP_NOT_FRESH');
    if ((await client.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n !== 0
      || (await client.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'")).rows[0].n !== 0) fail('GP_OWNED_BOOTSTRAP_NOT_EMPTY');
    // All identity/freshness guards precede mutations. Match the existing CI
    // owner/account limits and default grants, using the proper bootstrap role.
    connection.password = crypto.randomBytes(32).toString('hex');
    await client.query((await client.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['ALTER ROLE %I PASSWORD %L', 'gp_migration_admin', connection.password])).rows[0].sql);
    environment.TEST_POSTGRESQL_URL = connection.href; environment.GP_MIGRATION_ADMIN_URL = connection.href;
    await client.query('REVOKE CONNECT ON DATABASE postgres,template1,grabenplaner_test FROM PUBLIC');
    for (const domain of ['core', 'sales']) {
      const owner = 'gp_' + domain + '_owner', database = 'gp_migration_' + domain;
      await client.query('CREATE ROLE ' + owner + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
      for (const purpose of ['migrator', 'app', 'reader']) {
        const role = 'gp_' + domain + '_' + purpose, password = crypto.randomBytes(32).toString('hex'), limit = purpose === 'reader' ? 8 : purpose === 'app' ? domain === 'core' ? 8 : 7 : 5;
        await client.query((await client.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ' + limit, role, password])).rows[0].sql);
        await client.query('ALTER ROLE ' + role + " SET search_path TO pg_catalog; ALTER ROLE " + role + " SET lock_timeout TO '2s'");
        const url = new URL(connection); url.pathname = '/' + database; url.username = role; url.password = password; environment[role.toUpperCase() + '_URL'] = url.href;
      }
      await client.query('GRANT ' + owner + ' TO gp_' + domain + '_migrator'); await client.query('CREATE DATABASE ' + database + ' OWNER ' + owner);
      await client.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC; GRANT CONNECT ON DATABASE ' + database + ' TO gp_' + domain + '_migrator,gp_' + domain + '_app,gp_' + domain + '_reader');
      const setupUrl = new URL(connection); setupUrl.pathname = '/' + database; const setup = new Client({ connectionString: setupUrl.href, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
      await setup.connect();
      try {
        await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA gp AUTHORIZATION ' + owner + '; GRANT USAGE ON SCHEMA gp TO gp_' + domain + '_app,gp_' + domain + '_reader');
        await setup.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + owner + ' IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_' + domain + '_app');
        await setup.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + owner + ' IN SCHEMA gp GRANT SELECT ON TABLES TO gp_' + domain + '_reader');
        await setup.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + owner + ' IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_' + domain + '_app');
        await setup.query('ALTER DEFAULT PRIVILEGES FOR ROLE ' + owner + ' IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
        await setup.query('BEGIN; SET LOCAL ROLE ' + owner);
        await setup.query('CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)');
        await setup.query('INSERT INTO gp.environment_contract VALUES($1,$2,$3)', [ENVIRONMENT_ID, domain, PROFILE]);
        await setup.query('REVOKE ALL ON gp.environment_contract FROM gp_' + domain + '_app,gp_' + domain + '_reader; GRANT SELECT ON gp.environment_contract TO gp_' + domain + '_app,gp_' + domain + '_reader; COMMIT');
      } finally { await setup.end(); }
    }
  } finally { await client.end(); }
  async function migrate(domain, work) {
    const connection = new Client({ connectionString: environment['GP_' + domain.toUpperCase() + '_MIGRATOR_URL'], connectionTimeoutMillis: 5000, statement_timeout: 30000 }); await connection.connect();
    try { return await work(connection); } finally { await connection.end(); }
  }
  const operations = [];
  operations.push(await migrate('core', c => require('../lib/persistence/postgresql/core/migrate').migrateCoreDevelopment(c)));
  for (const stage of [5, 6]) operations.push(await migrate('sales', c => require('../lib/persistence/postgresql/sales/migrate').migrateSalesDevelopment(c, stage)));
  operations.push(await migrate('core', c => require('../lib/persistence/postgresql/boundary/migrate').migrateBoundaryCore(c)));
  for (const stage of [7, 8]) operations.push(await migrate('sales', c => require('../lib/persistence/postgresql/sales/migrate').migrateSalesDevelopment(c, stage)));
  for (const name of ['trade-annotations', 'personnel-learning-runs', 'xoffi-snapshots', 'vocational-school', 'session-security', 'passkeys']) operations.push(await migrate('core', c => require('../lib/persistence/postgresql/core/' + name).migrate(c)));
  operations.push(await migrate('sales', c => require('../lib/persistence/postgresql/sales/import-delete').migrate(c)));
  const descriptor = fs.openSync(environmentFile, 'wx', 0o600); try { fs.writeFileSync(descriptor, JSON.stringify(environment) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return { format: FORMAT, syntheticOnly: true, productionContact: false, bootstrapRole: 'gp_migration_admin', bootstrapOid: 10, clusterId: marker.clusterId, completeSchema: true, migrations: operations.length, environmentWritten: true };
}
if (require.main === module) {
  const options = {}, names = { '--root': 'root', '--environment-file': 'environmentFile', '--cluster-marker': 'clusterMarker', '--data-directory': 'dataDirectory' }, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) { if (!names[args[i]] || !args[i + 1] || Object.hasOwn(options, names[args[i]])) fail('GP_OWNED_BOOTSTRAP_ARGUMENTS'); options[names[args[i]]] = args[i + 1]; }
  bootstrap(options).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    try { if (process.platform === 'linux' && process.getuid() !== 0 && ROOT.test(options.root || '')) { owned(options.root); fs.writeFileSync(options.root + '/owned-bootstrap.failure.private.json', JSON.stringify({ code: error.code || null, message: String(error.message || ''), stack: String(error.stack || '') }) + '\n', { flag: 'wx', mode: 0o600 }); } } catch {}
    process.stderr.write(JSON.stringify({ failed: true, code: /^GP_|^PG_/.test(error.code || '') ? error.code : 'GP_OWNED_BOOTSTRAP_FAILED' }) + '\n'); process.exitCode = 1;
  });
}
module.exports = { bootstrap };
