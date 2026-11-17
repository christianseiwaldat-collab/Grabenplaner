'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Opt-in qualification: a real Jackcess-created ACCDB is read by the production
// Access parser twice, against the actual frozen PostgreSQL cash schema. All
// values are synthetic. The pinned fixture is unencrypted Access; the server
// archive is encrypted. This does not claim encrypted-Access or live-server QA.
test('native Access-to-PostgreSQL cash replay preserves source bytes, identities, publications and inventory', {
  skip: process.env.GP_CASH_REHYDRATION_NATIVE_TEST !== '1', timeout: 300000,
}, async t => {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
  const { Client, Pool } = require('pg');
  const C = require('../lib/data-import-contract');
  const { definitions, readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
  const { createSalesSchemaPlan } = require('../lib/persistence/postgresql/sales/schema');
  const { createSalesCatalog } = require('../lib/persistence/postgresql/sales/catalog');
  const { createPostgresqlPersistenceProvider } = require('../lib/persistence/postgresql/provider');
  const { createCashSnapshotStore, CASH_SNAPSHOT_FORMAT } = require('../lib/persistence/repositories/cash-snapshots');
  const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
  const { planCashRecovery, rehydrateCash } = require('../lib/persistence/postgresql/operations/cash-rehydration');
  const { salesPlan } = require('../lib/persistence/postgresql/operations/owned-recovery');
  const { excludedTableDataArguments } = require('../lib/persistence/postgresql/operations/deploy-data-policy');
  const { createDataImportProtection } = require('../lib/data-import-protection');
  const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
  const { createImportSourceArchive } = require('../lib/data-import-source-archive');
  const assetsRoot = process.env.GP_CASH_ACCESS_ASSETS_ROOT;
  assert.ok(assetsRoot && path.isAbsolute(assetsRoot), 'materialized pinned Java/Jackcess assets root is required');
  const assetProof = require('../lib/import-verifier-runtime-assets').inspectRuntimeAssets(assetsRoot);
  assert.equal(assetProof.descriptorSha256, require('../lib/data-import-af-verifier-policy').runtime.descriptorSha256);
  const asset = path.join(assetsRoot, assetProof.installPrefix), descriptor = JSON.parse(fs.readFileSync(path.join(asset, 'descriptor.json'), 'utf8'));
  const java = path.join(asset, 'jre/bin/java'), classpath = descriptor.jars.map(jar => path.join(asset, jar.path)).join(path.delimiter);
  const javac = process.env.GP_CASH_ACCESS_JAVAC || '/usr/bin/javac';
  assert.ok(path.isAbsolute(javac) && fs.statSync(javac).isFile(), 'an explicit Java 17-compatible fixture compiler is required');
  const root = fs.mkdtempSync('/tmp/gp-cash-access-native-'), socket = fs.mkdtempSync('/tmp/gp-pg-recovery-');
  fs.chmodSync(root, 0o700); fs.chmodSync(socket, 0o700);
  const data = path.join(root, 'data'), binaries = '/usr/lib/postgresql/18/bin', clients = [], providers = [];
  const protection = createDataImportProtection({ encryptionKey: crypto.randomBytes(32), indexKey: crypto.randomBytes(32), keyId: 'native-cash-replay', compression: true });
  const vault = createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: crypto.randomBytes(32) } });
  let startupAttempted = false, toolNumber = 0, qualified = false;
  const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  function command(binary, args, { permitFailure = false } = {}) {
    const log = path.join(root, 'tool-' + (++toolNumber)), out = fs.openSync(log + '.out', 'wx', 0o600), err = fs.openSync(log + '.err', 'wx', 0o600);
    let result;
    try { result = spawnSync(binary, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', PGHOST: socket, PGPORT: '55484', PGUSER: 'gp_cash_native_admin', PGDATABASE: 'postgres', PGPASSWORD: '', PGCONNECT_TIMEOUT: '3' },
      stdio: ['ignore', out, err], timeout: 60000 }); } finally { fs.closeSync(out); fs.closeSync(err); }
    if (!permitFailure && (result.error || result.status !== 0)) throw Object.assign(new Error('GP_CASH_NATIVE_TOOL_FAILED'), { code: 'GP_CASH_NATIVE_TOOL_FAILED', toolLog: log });
    return { ...result, output: fs.readFileSync(log + '.out', 'utf8') };
  }
  const pg = (name, args, options) => {
    assert.ok(['initdb', 'pg_ctl', 'pg_dump', 'pg_restore'].includes(name)); const binary = binaries + '/' + name, stat = fs.lstatSync(binary);
    assert.ok(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022)); assert.equal(fs.realpathSync(binary), binary); return command(binary, args, options);
  };
  const connection = database => ({ host: socket, port: 55484, user: 'gp_cash_native_admin', password: '', database, ssl: false, connectionTimeoutMillis: 3000, statement_timeout: 15000, query_timeout: 20000 });
  async function connect(database) { const client = new Client(connection(database)); clients.push(client); await client.connect(); return client; }
  function provider(database) {
    const pool = new Pool({ ...connection(database), max: 2 });
    const value = createPostgresqlPersistenceProvider({ pool, poolOwnership: 'provider', catalog: createSalesCatalog(5).entries,
      prepareClient: client => client.query('SET search_path=pg_catalog,gp,kassa,integration,trade,reporting') }); providers.push(value); return value;
  }
  t.after(async () => {
    try {
      await Promise.allSettled(providers.map(value => value.close())); await Promise.allSettled(clients.map(client => client.end()));
      if (startupAttempted) {
        if (pg('pg_ctl', ['-D', data, 'status'], { permitFailure: true }).status === 0 || fs.existsSync(path.join(data, 'postmaster.pid'))) pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
        assert.equal(pg('pg_ctl', ['-D', data, 'status'], { permitFailure: true }).status, 3); assert.equal(fs.existsSync(path.join(data, 'postmaster.pid')), false);
      }
      for (const [directory, prefix] of [[root, 'gp-cash-access-native-'], [socket, 'gp-pg-recovery-']]) {
        assert.equal(fs.realpathSync(directory), directory); assert.equal(path.dirname(directory), '/tmp'); assert.ok(path.basename(directory).startsWith(prefix)); assert.equal(fs.statSync(directory).uid, process.getuid());
        if (directory === root && (!qualified || process.env.GP_CASH_REHYDRATION_KEEP_FIXTURE === '1')) {
          t.diagnostic(JSON.stringify({ retainedSyntheticFixture: root, clusterStopped: true, qualified })); continue;
        }
        fs.rmSync(directory, { recursive: true });
      }
    } finally { protection.destroy(); }
  });
  const at = '2026-01-23T08:15:00', sourceRows = {
    KassenJournal: [{ Vorgang: 1001, Filiale: 18, Datum: at }],
    Umsatz_KASSE: [{ Bonnr: 1, Filialid: 18, Kassenid: 1, Bondatum: at, Bonzeit: at, VerkäuferID: 2, KUND_NR: 3, RechnungsBetrag: 12.3456, RechnungsNr: 'synthetic-1' }],
    EigeneKonten: [{ Ekontobeschreibung: 'Synthetic own account', EkontoNr: 1000 }],
    ExportRichtTabelle: [{ Richtid: 1, Idd: 1, Id: 1, FilialId: 18, KassenId: 1, Position: 1, EAN: '000042', Artikelbezeichnung: 'Synthetic export article', VK: '12.3456' }],
    KassenJournal_Details: [{ Vorgang: 1001, Filiale: 18, Beleg: 1, Datum: at, Konto: 1000, EinAuszahlung: 'E', Bezeichnung: 'Synthetic journal', Beschreibung: 'Unicode ÄÖÜ synthetic', Einzahlung: 12.3456, Auszahlung: 0, MwSt_Satz: 20 }],
    Tagesbericht: [{ ZBon: 1, KoBeschreibung: 'Synthetic nullable date', Bondatum: null, Filialid: 18, Kassenid: 1, Rechnungsnr: 1, KontoNr: 1000, Einnahmen: '12.3456', Ausgaben: '0.0000', Rang: 1 }],
    Umsatz_Kasse_Details: [{ RepID: '00000000-0000-0000-0000-000000000001', Bonnr: 1, Filialid: 18, Kassenid: 1, Bondatum: at, EAN: '000042', VKMenge: 1,
      Sollpreis: '12.3456', VK_Preis: '12.3456', MWST: 20, RohertragDM: 1.2345, Verkäuferid: 2, Sortiment: 130, Artikelbezeichnung: 'Synthetic article', UMarke: 'Synthetic' }],
  };
  const spec = path.join(root, 'fixture.json'), classes = path.join(root, 'classes'), sourceFile = path.join(root, 'synthetic-cash.accdb'); fs.mkdirSync(classes, { mode: 0o700 });
  fs.writeFileSync(spec, JSON.stringify({ tables: definitions('cash').map(table => ({ name: table.name, columns: table.columns.map(({ name, type }) => ({ name, type })), rows: sourceRows[table.name] })) }), { mode: 0o600 });
  command(javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', classpath, '-d', classes, path.resolve(__dirname, '../test-support/CashAccessRecoveryFixture.java')]);
  const generated = JSON.parse(command(java, ['-cp', classes + path.delimiter + classpath, 'CashAccessRecoveryFixture', spec, sourceFile]).output);
  assert.deepEqual(generated, { syntheticAccessFile: true, encryptedAccessFile: false, tables: 7, rows: 7 });
  fs.chmodSync(sourceFile, 0o600); const sourceBytes = fs.readFileSync(sourceFile), fileSha256 = checksum(sourceBytes);
  pg('initdb', ['-D', data, '-U', 'gp_cash_native_admin', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C.UTF-8']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses=''\nport=55484\nunix_socket_directories='${socket}'\nshared_buffers='32MB'\nmax_connections=16\n`);
  startupAttempted = true; pg('pg_ctl', ['-D', data, '-l', path.join(root, 'postgresql.log'), '-w', '-t', '30', 'start']);
  const admin = await connect('postgres');
  for (const role of ['gp_sales_owner', 'gp_sales_app', 'gp_sales_reader']) await admin.query('CREATE ROLE ' + role);
  for (const database of ['cash_original', 'cash_recovered', 'cash_negative']) await admin.query('CREATE DATABASE ' + database + ' OWNER gp_sales_owner');
  const original = await connect('cash_original'); await original.query('CREATE SCHEMA gp AUTHORIZATION gp_sales_owner; SET ROLE gp_sales_owner; SET search_path=pg_catalog,gp,kassa');
  const schema = createSalesSchemaPlan(5);
  for (const item of schema.statements) await original.query(item.sql);
  await original.query('RESET ROLE');
  const actor = { scopeId: 'synthetic-access', ownerId: 'fixture-owner' }, sourceId = protection.digest(['source', actor, 'cash', fileSha256]);
  const access = provider('cash_original'), store = createCashSnapshotStore({ access, protection, actor, clock: () => '2026-11-16T12:00:00.000Z' });
  // Both passes below invoke the production parser, without a readerFactory or
  // readSource override. Original Access bytes remain on disk and unchanged.
  await readTradeFotoFullSource({ buffer: sourceBytes, kind: 'cash', send: async message => {
    if (message.type === 'manifest') return store.begin(sourceId, message);
    if (message.type === 'table') return store.startTable(sourceId, message.name, message.expectedRows);
    if (message.type === 'rows') return store.append(sourceId, message.name, message.startRow, message.rows);
    if (message.type === 'table-complete') return store.finishTable(sourceId, message.name);
    if (message.type === 'complete') return store.seal(sourceId, message);
    assert.fail('Unexpected actual Access parser message');
  } });
  let summary; do { summary = await store.review(sourceId); } while (summary.status === 'reviewing'); assert.equal(summary.status, 'ready'); assert.equal(summary.verifiedRows, 7);
  const publicationId = protection.digest(['synthetic-cash-publication', sourceId]), reference = Buffer.from(protection.digest(['cash-compact-v1', 'source-reference', actor.scopeId, 'locationKey', '18']), 'hex');
  const publicationContext = ['cash-publication-v1', publicationId, actor.scopeId, sourceId, actor.ownerId, '2026-11-16T12:00:00.000Z'];
  await original.query('INSERT INTO kassa.cash_publications(id,scope_id,dataset_id,owner_id,created_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [publicationId, actor.scopeId, sourceId, actor.ownerId, '2026-11-16T12:00:00.000Z', protection.seal({ syntheticPublication: true, sourceId }, publicationContext)]);
  await original.query('INSERT INTO kassa.cash_publication_bindings VALUES($1,$2,$3,$4,0,$5)', [publicationId, 'FILIALEN', reference, 'synthetic-location-18',
    protection.seal({ syntheticBinding: true }, ['cash-publication-binding-v1', publicationId, 'FILIALEN', reference.toString('hex'), 'synthetic-location-18', false])]);
  await original.query('INSERT INTO kassa.cash_publication_state VALUES($1,1,$2)', [actor.scopeId, protection.seal({ active: publicationId, previous: null, events: [] }, ['cash-publication-state-v1', actor.scopeId, 1])]);
  const archiveDirectory = path.join(root, 'archive'), archive = createImportSourceArchive({ directory: archiveDirectory, vault });
  const source = { id: sourceId, kind: 'cash', fileSha256, bytes: sourceBytes.length, fileName: 'synthetic-cash.accdb', complete: true, status: 'ready', storage: CASH_SNAPSHOT_FORMAT, revision: summary.revision };
  await archive.stage({ source, buffer: sourceBytes }); await archive.promote({ source, publication: { sourceId } }); sourceBytes.fill(0);
  const archiveProof = await archive.verify(), plan = await planCashRecovery(original, { protection, archiveProof });
  const preservedTables = ['cash_snapshot_datasets', 'cash_snapshot_inventory', 'cash_publications', 'cash_publication_bindings', 'cash_publication_state', 'cash_binding_inventory'];
  async function preserved(client) {
    const rows = {}; for (const name of preservedTables) rows[name] = (await client.query('SELECT to_jsonb(r) AS value FROM kassa.' + name + ' r ORDER BY to_jsonb(r)::text')).rows; return rows;
  }
  async function decoded(catalogAccess) {
    const cash = createCashSnapshotStore({ access: catalogAccess, protection, actor });
    return catalogAccess.transaction(async tx => {
      const dataset = await cash.reader.load(tx, sourceId), values = [];
      for (const table of TABLES) {
        const records = await tx.queryAll(table.statements.page, { datasetSlot: dataset.row.slot, after: 0, limit: 200 });
        for (const record of records) {
          const { payload, ...metadata } = record;
          values.push({ table: table.name, metadata: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('hex') : value])), values: cash.reader.decode(dataset, table, record).values });
        }
      }
      return values;
    }, { isolation: 'serializable', readOnly: true });
  }
  const originalProof = await preserved(original), originalValues = await decoded(access); await access.close();
  const policy = await salesPlan(original), dump = path.join(root, 'cash-reduced.dump');
  pg('pg_dump', ['--format=custom', '--dbname=cash_original', '--role=gp_sales_owner', '--file=' + dump, ...excludedTableDataArguments(policy)]);
  for (const database of ['cash_recovered', 'cash_negative']) pg('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname=' + database, dump]);
  const recovered = await connect('cash_recovered'), negative = await connect('cash_negative');
  for (const table of TABLES) assert.equal((await recovered.query('SELECT COUNT(*)::text AS count FROM kassa.' + table.sqlName)).rows[0].count, '0');
  assert.deepEqual(await preserved(recovered), originalProof);
  const replay = await rehydrateCash(recovered, { protection, archive, plan, isolatedRecovery: true });
  assert.equal(replay.verified, true); assert.equal(replay.rowsRestored, 7); assert.deepEqual(await preserved(recovered), originalProof);
  const recoveredAccess = provider('cash_recovered'); assert.deepEqual(await decoded(recoveredAccess), originalValues);
  const nullDate = originalValues.find(row => row.table === 'Tagesbericht'); assert.equal(nullDate.metadata.businessDate, null);
  assert.ok(originalValues.filter(row => ['Umsatz_Kasse_Details', 'KassenJournal_Details'].includes(row.table)).every(row => row.metadata.parentRow === 1));
  assert.equal((await recovered.query("SELECT COUNT(*)::integer AS count FROM pg_constraint WHERE contype='f' AND connamespace='kassa'::regnamespace AND NOT convalidated")).rows[0].count, 0);
  const empty = createImportSourceArchive({ directory: path.join(root, 'absent-archive'), vault });
  await assert.rejects(rehydrateCash(negative, { protection, archive: empty, plan, isolatedRecovery: true }), error => ['PG_CASH_RECOVERY_ARCHIVE_REQUIRED','IMPORT_SOURCE_ARCHIVE_INVALID'].includes(error.code || error.message));
  const damagedDirectory = path.join(root, 'damaged-archive'); fs.cpSync(archiveDirectory, damagedDirectory, { recursive: true, errorOnExist: true, force: false });
  const damagedSource = path.join(damagedDirectory, archiveProof.kinds.find(slot => slot.kind === 'cash').current.file), damagedBytes = fs.readFileSync(damagedSource); damagedBytes[damagedBytes.length - 1] ^= 1; fs.writeFileSync(damagedSource, damagedBytes); damagedBytes.fill(0);
  const damaged = createImportSourceArchive({ directory: damagedDirectory, vault });
  await assert.rejects(rehydrateCash(negative, { protection, archive: damaged, plan, isolatedRecovery: true }), /IMPORT_SOURCE_ARCHIVE_INVALID/);
  assert.deepEqual(await preserved(negative), originalProof);
  for (const table of TABLES) assert.equal((await negative.query('SELECT COUNT(*)::text AS count FROM kassa.' + table.sqlName)).rows[0].count, '0');
  assert.equal(checksum(fs.readFileSync(sourceFile)), fileSha256, 'the original Access file must remain byte-for-byte unchanged');
  assert.deepEqual(await archive.verify(), archiveProof);
  qualified = true;
  t.diagnostic(JSON.stringify({ synthetic: true, actualAccessParser: true, injectedReader: false, encryptedAccess: false, encryptedServerArchive: true,
    sourceSha256: fileSha256, sourceBytes: source.bytes, postgresSchemaPlanSha256: schema.digest, restoredRows: replay.rowsRestored, preservedPublication: true,
    preservedDatasetIdentities: true, preservedInventoryGenerations: true, originalFileUnchanged: true, missingArchiveRejected: true, changedArchiveRejected: true }));
});
