'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Deliberately opt-in. This test starts its OWN empty cluster on a private Unix
// socket, never reads GP_*_URL/PGHOST endpoints, and never uses productive data.
// It qualifies native selective dump/restore, not real Access parsing, full app
// recovery, live-server recovery or the complete production schema.
test('native isolated PostgreSQL preserves owned rows and FKs while excluding only reviewed cash data', {
  skip: process.env.GP_DEPLOY_OWNED_NATIVE_TEST !== '1', timeout: 300000,
}, async t => {
  assert.equal(process.platform, 'linux', 'native qualification requires Linux');
  assert.ok(process.getuid() > 0, 'initdb must run as a non-root fixture user');
  const { Client, Pool } = require('pg');
  const { createPairedSnapshot } = require('../lib/persistence/postgresql/operations/paired-backup');
  const { verifyPairBundle } = require('../lib/persistence/postgresql/operations/paired-bundle');
  const { captureCheckpoint, verifyCheckpoint } = require('../lib/persistence/postgresql/operations/paired-checkpoint');
  const { excludedTableDataArguments } = require('../lib/persistence/postgresql/operations/deploy-data-policy');
  const { salesPlan } = require('../lib/persistence/postgresql/operations/owned-recovery');
  const { planCashRecovery } = require('../lib/persistence/postgresql/operations/cash-rehydration');
  const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
  const { cashSnapshotMetadataContext, CASH_SNAPSHOT_FORMAT } = require('../lib/persistence/repositories/cash-snapshots');
  const { createDataImportProtection } = require('../lib/data-import-protection');
  const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
  const { createImportSourceArchive } = require('../lib/data-import-source-archive');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-owned-native-')); fs.chmodSync(root, 0o700);
  const data = path.join(root, 'data'), socket = path.join(root, 'socket'), backups = path.join(root, 'backups');
  for (const directory of [socket, backups]) fs.mkdirSync(directory, { mode: 0o700 });
  assert.ok(Buffer.byteLength(socket) < 90, 'fixture socket path must fit PostgreSQL Unix sockets');
  const BIN = '/usr/lib/postgresql/18/bin', clients = [], pools = [];
  let startupAttempted = false, toolNumber = 0;
  const protection = createDataImportProtection({ encryptionKey: crypto.randomBytes(32), indexKey: crypto.randomBytes(32), keyId: 'synthetic-native' });
  function tool(name, args, { permitFailure = false } = {}) {
    assert.ok(['initdb', 'pg_ctl', 'pg_dump', 'pg_dumpall', 'pg_restore'].includes(name));
    const binary = BIN + '/' + name, stat = fs.lstatSync(binary);
    assert.ok(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022)); assert.equal(fs.realpathSync(binary), binary);
    const out = fs.openSync(path.join(root, 'tool-' + (++toolNumber) + '.out'), 'wx', 0o600), err = fs.openSync(path.join(root, 'tool-' + toolNumber + '.err'), 'wx', 0o600);
    let result;
    try {
      result = spawnSync(binary, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGHOST: socket, PGPORT: '55484', PGUSER: 'gp_native_admin', PGDATABASE: 'postgres', PGPASSWORD: '', PGCONNECT_TIMEOUT: '3' },
        stdio: ['ignore', out, err], timeout: 60000 });
    } finally { fs.closeSync(out); fs.closeSync(err); }
    if (!permitFailure && (result.error || result.status !== 0)) throw Object.assign(new Error('GP_OWNED_NATIVE_TOOL_FAILED'), { code: 'GP_OWNED_NATIVE_TOOL_FAILED' });
    return result;
  }
  async function connect(database) {
    const client = new Client({ host: socket, port: 55484, user: 'gp_native_admin', password: '', database, ssl: false,
      connectionTimeoutMillis: 3000, statement_timeout: 15000, query_timeout: 20000, application_name: 'synthetic-deploy-owned-native' });
    clients.push(client); await client.connect(); return client;
  }
  t.after(async () => {
    // Retain the workspace if shutdown cannot be proved; never delete files
    // belonging to a possibly live cluster. All roots are locally created here.
    try {
      await Promise.allSettled(pools.map(pool => pool.end()));
      await Promise.allSettled(clients.map(client => client.end()));
      if (startupAttempted) {
        const status = tool('pg_ctl', ['-D', data, 'status'], { permitFailure: true });
        if (status.status === 0 || fs.existsSync(path.join(data, 'postmaster.pid'))) tool('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
        assert.equal(tool('pg_ctl', ['-D', data, 'status'], { permitFailure: true }).status, 3, 'fixture cluster must be stopped before cleanup');
        assert.equal(fs.existsSync(path.join(data, 'postmaster.pid')), false);
      }
      assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('gp-owned-native-')); assert.equal(fs.lstatSync(root).uid, process.getuid());
      fs.rmSync(root, { recursive: true });
    } finally { protection.destroy(); }
  });
  tool('initdb', ['-D', data, '-U', 'gp_native_admin', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C.UTF-8']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses=''\nport=55484\nunix_socket_directories='${socket}'\nshared_buffers='32MB'\nmax_connections=12\n`);
  startupAttempted = true; tool('pg_ctl', ['-D', data, '-l', path.join(root, 'postgresql.log'), '-w', '-t', '30', 'start']);
  const admin = await connect('postgres');
  const binding = (await admin.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('listen_addresses') AS listen,current_setting('data_directory') AS data")).rows[0];
  assert.deepEqual(binding, { socket, listen: '', data });
  for (const domain of ['core', 'sales']) {
    await admin.query('CREATE ROLE gp_native_' + domain + '_owner');
    await admin.query('CREATE DATABASE native_' + domain + ' OWNER gp_native_' + domain + '_owner');
    await admin.query('CREATE DATABASE restored_' + domain + ' OWNER gp_native_' + domain + '_owner');
  }
  const core = await connect('native_core'), sales = await connect('native_sales');
  await core.query('SET ROLE gp_native_core_owner; CREATE SCHEMA gp AUTHORIZATION gp_native_core_owner; CREATE TABLE gp.native_core_settings(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,payload bytea NOT NULL)');
  await core.query('INSERT INTO gp.native_core_settings(payload) VALUES($1)', [Buffer.from([0, 255, 17, 13, 10, 65])]);
  await core.query('RESET ROLE');
  await sales.query(`SET ROLE gp_native_sales_owner;
    CREATE SCHEMA gp AUTHORIZATION gp_native_sales_owner; CREATE SCHEMA kassa AUTHORIZATION gp_native_sales_owner;
    CREATE SCHEMA trade AUTHORIZATION gp_native_sales_owner; CREATE SCHEMA integration AUTHORIZATION gp_native_sales_owner; CREATE SCHEMA reporting AUTHORIZATION gp_native_sales_owner;
    CREATE TABLE trade.sales_article_own_images(id text PRIMARY KEY,payload bytea NOT NULL);
    CREATE TABLE reporting.native_profiles(id text PRIMARY KEY,payload text NOT NULL);
    CREATE TABLE integration.native_history(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,profile_id text NOT NULL REFERENCES reporting.native_profiles(id),payload text NOT NULL);
    CREATE TABLE kassa.cash_snapshot_datasets(slot bigint PRIMARY KEY,id text NOT NULL UNIQUE,scope_id text NOT NULL,owner_id text NOT NULL,revision bigint NOT NULL,created_at text NOT NULL,payload text NOT NULL);
    CREATE TABLE kassa.cash_snapshot_inventory(dataset_slot bigint NOT NULL REFERENCES kassa.cash_snapshot_datasets(slot),table_index integer NOT NULL,row_count bigint NOT NULL,generation bigint NOT NULL,PRIMARY KEY(dataset_slot,table_index))`);
  await sales.query('INSERT INTO trade.sales_article_own_images VALUES($1,$2)', ['native-image', Buffer.from([0, 3, 255, 127, 65, 10])]);
  await sales.query('INSERT INTO reporting.native_profiles VALUES($1,$2)', ['native-profile', 'synthetic own profile; commas, Unicode ä; no source row']);
  await sales.query('INSERT INTO integration.native_history(profile_id,payload) VALUES($1,$2)', ['native-profile', 'synthetic own history and undo evidence']);
  const sourceBuffer = Buffer.alloc(4096); sourceBuffer.write('Standard ACE DB', 4); sourceBuffer[0x14] = 3;
  const fileSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex'), actor = { scopeId: 'synthetic-native', ownerId: 'fixture-owner' };
  const sourceId = protection.digest(['source', actor, 'cash', fileSha256]);
  const row = { slot: 1, id: sourceId, ...actor, revision: 7, createdAt: '2026-11-16T12:00:00.000Z' };
  const metadata = { format: CASH_SNAPSHOT_FORMAT, scope: 'full', fileSha256, bytes: sourceBuffer.length, status: 'ready', complete: true,
    tables: TABLES.map(table => ({ name: table.name, profileHash: table.profile.fingerprint, expectedRows: 1, declaredRows: 1, receivedRows: 1,
      verifiedRows: 1, complete: true, verified: true, verifiedGeneration: 1, sourceHash: 'a'.repeat(64), verifiedHash: 'a'.repeat(64) })) };
  await sales.query('INSERT INTO kassa.cash_snapshot_datasets VALUES($1,$2,$3,$4,$5,$6,$7)', [row.slot, row.id, row.scopeId, row.ownerId, row.revision, row.createdAt, protection.seal(metadata, cashSnapshotMetadataContext(row))]);
  for (let index = 0; index < 7; index++) {
    const parent = index === 4 ? 0 : index === 6 ? 1 : null;
    await sales.query(`CREATE TABLE kassa.cash_snapshot_${index}(dataset_slot bigint NOT NULL REFERENCES kassa.cash_snapshot_datasets(slot),source_row bigint NOT NULL,payload text NOT NULL,parent_row bigint,
      PRIMARY KEY(dataset_slot,source_row)${parent === null ? '' : ',FOREIGN KEY(dataset_slot,parent_row) REFERENCES kassa.cash_snapshot_' + parent + '(dataset_slot,source_row)'})`);
    await sales.query('INSERT INTO kassa.cash_snapshot_' + index + '(dataset_slot,source_row,payload,parent_row) VALUES(1,1,$1,$2)', ['synthetic omitted cash payload ' + index, parent === null ? null : 1]);
    await sales.query('INSERT INTO kassa.cash_snapshot_inventory VALUES(1,$1,1,1)', [index]);
  }
  await sales.query('RESET ROLE');
  const privateRoot = path.join(root, 'private'); fs.mkdirSync(privateRoot, { mode: 0o700 });
  const archive = createImportSourceArchive({ directory: path.join(privateRoot, 'import-sources'), vault: createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: crypto.randomBytes(32) } }) });
  const source = { id: sourceId, kind: 'cash', fileSha256, bytes: sourceBuffer.length, fileName: 'synthetic-cash.accdb', revision: 7, complete: true, status: 'ready', storage: CASH_SNAPSHOT_FORMAT };
  await archive.stage({ source, buffer: sourceBuffer }); await archive.promote({ source, publication: { sourceId } }); sourceBuffer.fill(0);
  const sourceArchive = await archive.verify(), fullSizes = {};
  for (const [domain, client] of [['core', core], ['sales', sales]]) fullSizes[domain] = Number((await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes);
  const originalCore = (await core.query("SELECT id::text,encode(payload,'hex') AS payload FROM gp.native_core_settings ORDER BY id")).rows;
  const ownQueries = ["SELECT id,encode(payload,'hex') AS payload FROM trade.sales_article_own_images ORDER BY id", 'SELECT * FROM reporting.native_profiles ORDER BY id', 'SELECT id::text,profile_id,payload FROM integration.native_history ORDER BY id'];
  const originalOwned = []; for (const sql of ownQueries) originalOwned.push((await sales.query(sql)).rows);
  const domains = ['core', 'sales'].map(domain => {
    const pool = new Pool({ host: socket, port: 55484, user: 'gp_native_admin', password: '', database: 'native_' + domain, ssl: false, max: 1, connectionTimeoutMillis: 3000 }); pools.push(pool);
    return { domain, database: 'native_' + domain, ownerRole: 'gp_native_' + domain + '_owner', pool };
  });
  let recovery;
  const options = { backupDirectory: backups, domains, scope: 'deploy-owned', withQuiescedWrites: work => work({ active: true, pendingMutations: 0 }),
    async readCheckpoint({ domain, client }) {
      if (domain === 'sales') recovery = { scope: 'deploy-owned', fullRecovery: false, requiresCashRehydration: true, requiresAccessRehydration:true,archiveStorage:'server-reference-v1',salesPlan: await salesPlan(client),
        sourceArchive, cashPlan: await planCashRecovery(client, { protection, archiveProof: sourceArchive }), rehydrationDatabaseBytes: fullSizes };
      return { restore: await captureCheckpoint(client, domain, { excludedTables: domain === 'sales' ? recovery.salesPlan.excludedTables : [] }) };
    },
    async runDump({ domain, database, snapshotId, targetFile }) {
      tool('pg_dump', ['--format=custom', '--compress=gzip:1', '--snapshot=' + snapshotId, '--role=gp_native_' + domain + '_owner', '--dbname=' + database, '--file=' + targetFile,
        ...(domain === 'sales' ? excludedTableDataArguments(recovery.salesPlan) : [])]);
    },
    async captureRecoveryFiles({ directory }) {
      fs.mkdirSync(path.join(directory,'private'),{mode:0o700});
      await archive.referenceSnapshot({directory:path.join(directory,'private','import-sources')});
      recovery.accessPlan=require('./fixtures/empty-access-projection').emptyAccessProjection(directory,sourceArchive.generationSha256);
      fs.writeFileSync(path.join(directory, 'configuration.env'), 'SYNTHETIC_NATIVE_RECOVERY=1\n', { mode: 0o600 });
      const roles = tool('pg_dumpall', ['--roles-only', '--no-role-passwords', '--file=' + path.join(directory, 'roles.sql')]); assert.equal(roles.status, 0);
    }, recoveryContract: async () => recovery };
  const sealed = await createPairedSnapshot(options), verified = await verifyPairBundle(sealed.bundle, sealed.commitMarker, { scope: 'deploy-owned' });
  assert.equal(sealed.providerId, 'postgresql-deploy-owned'); assert.equal(verified.manifest.recovery.fullRecovery, false);
  await assert.rejects(verifyPairBundle(sealed.bundle, sealed.commitMarker), /PG_PAIR_MARKER/);
  for (const domain of ['core', 'sales']) tool('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname=restored_' + domain, path.join(sealed.bundle, domain + '.dump')]);
  const restoredCore = await connect('restored_core'), restoredSales = await connect('restored_sales');
  assert.deepEqual((await restoredCore.query("SELECT id::text,encode(payload,'hex') AS payload FROM gp.native_core_settings ORDER BY id")).rows, originalCore);
  for (const [index, sql] of ownQueries.entries()) assert.deepEqual((await restoredSales.query(sql)).rows, originalOwned[index]);
  for (let index = 0; index < 7; index++) assert.equal((await restoredSales.query('SELECT COUNT(*)::text AS count FROM kassa.cash_snapshot_' + index)).rows[0].count, '0');
  for (const [domain, client] of [['core', restoredCore], ['sales', restoredSales]]) {
    await client.query('BEGIN READ ONLY');
    try { await verifyCheckpoint(client, domain, verified.manifest.checkpoint.domains[domain].restore); } finally { await client.query('ROLLBACK'); }
  }
  assert.equal((await restoredSales.query("SELECT COUNT(*)::integer AS count FROM pg_constraint WHERE contype='f' AND connamespace='kassa'::regnamespace AND NOT convalidated")).rows[0].count, 0);
  await assert.rejects(restoredSales.query("INSERT INTO kassa.cash_snapshot_4 VALUES(1,1,'synthetic invalid parent',999)"), error => error.code === '23503');
  const dump = path.join(sealed.bundle, 'sales.dump'), bytes = fs.readFileSync(dump); fs.appendFileSync(dump, 'synthetic corruption');
  await assert.rejects(verifyPairBundle(sealed.bundle, sealed.commitMarker, { scope: 'deploy-owned' }), /PG_PAIR_COMPONENT_HASH/); fs.writeFileSync(dump, bytes);
  const badDump = path.join(root, 'corrupt.dump'); fs.writeFileSync(badDump, bytes.subarray(0, 16), { mode: 0o600 });
  await admin.query('CREATE DATABASE rejected_sales OWNER gp_native_sales_owner');
  const rejection = tool('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname=rejected_sales', badDump], { permitFailure: true });
  assert.notEqual(rejection.status, 0);
  const rejected = await connect('rejected_sales'); assert.equal((await rejected.query("SELECT to_regclass('trade.sales_article_own_images') AS relation")).rows[0].relation, null);
  await assert.rejects(createPairedSnapshot({ ...options, async runDump(input) {
    if (input.domain === 'core') return options.runDump(input);
    tool('pg_dump', ['--format=custom', '--strict-names', '--table=fixture_relation_that_does_not_exist', '--dbname=' + input.database, '--file=' + input.targetFile]);
  } }), error => error.code === 'GP_OWNED_NATIVE_TOOL_FAILED');
  assert.equal(fs.readdirSync(backups).filter(name => name.endsWith('.complete.json')).length, 1, 'failed native dump must publish no completed point');
});
