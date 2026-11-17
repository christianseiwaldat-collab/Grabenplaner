'use strict';
// Explicit complete-schema synthetic qualification. Root owns the namespace,
// fresh source cluster and two private recovery workspaces; no product access.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const R = require('../lib/persistence/postgresql/operations/runtime');
const { restorePair } = require('../lib/persistence/postgresql/operations/paired-restore');
const { recoveryVault } = require('../lib/persistence/postgresql/operations/owned-recovery');
const { createImportSourceArchive } = require('../lib/data-import-source-archive');
const { openTwoDatabaseDevelopmentApplication } = require('../lib/persistence/postgresql/boundary/application');
const fixtures = require('./postgresql-access-recovery-fixture.cjs');
const {contentProof}=require('./access-recovery-content-proof.cjs');
const { PROFILE, ENVIRONMENT_ID, verifyEnvironment } = require('../lib/persistence/postgresql/core/environment');
const FORMAT = 'gp-complete-schema-owned-pair-v2', SOURCE_FORMAT = 'gp-complete-schema-owned-application-smoke-v1';
const SOURCE = /^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/([a-f0-9-]{36})\/work\/application$/;
const RESTORE = /^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/([a-f0-9-]{36})\/work$/;
const FIXTURE = /^\/home\/gpcheck\/gp-deploy-owned-all-access-20261116\/generation-[0-9]{3}\/fixture-receipt\.json$/;
const FRESH_FIXTURE = /^\/home\/gpcheck\/gp-deploy-owned-complete-20261116\/generation-fresh-[0-9]{3}\/fixture-receipt\.json$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function directory(name) {
  const stat = fs.lstatSync(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(name) !== name || stat.uid !== process.getuid() || stat.mode & 0o077) fail('GP_OWNED_PAIR_DIRECTORY');
}
function readPrivate(name, root, json = true) {
  if (!path.isAbsolute(name) || !name.startsWith(root + '/') || fs.realpathSync(name) !== name) fail('GP_OWNED_PAIR_INPUT');
  const stat = fs.lstatSync(name);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size < 1 || stat.size > 65536) fail('GP_OWNED_PAIR_INPUT');
  const bytes = fs.readFileSync(name, 'utf8'); return json ? JSON.parse(bytes) : bytes;
}
function writePrivate(name, value) { const fd = fs.openSync(name, 'wx', 0o600); try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
const SMOKE_FORMAT = 'gp-owned-pair-http-child-v1';
async function qualifySmokeChild(root) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !SOURCE.test(root || '')
    || Object.values(os.networkInterfaces()).flat().some(item => !item.internal)) fail('GP_OWNED_PAIR_SMOKE_CHILD_ISOLATION');
  directory(root);
  if (readPrivate(root + '/ownership-marker', root, false) !== 'grabenplaner-postgresql-full-application-v1\n') fail('GP_OWNED_PAIR_SMOKE_CHILD_OWNER');
  const config = readPrivate(root + '/operations-config.json', root);
  // The child gets only the verified copied recovery configuration, fresh
  // private application root and fixed isolated rehearsal endpoint.
  if (config.format !== R.FORMAT || config.domains?.map(d => d.domain).join(',') !== 'core,sales'
    || !config.recoveryAccounts || Object.keys(config.recoveryAccounts).length !== 8) fail('GP_OWNED_PAIR_SMOKE_CHILD_CONFIG');
  readPrivate(root + '/source-encryption.env', root, false);
  const application = await require('../server-tools/linux/recovery/lib/postgresql-application-smoke').qualifyHttp({ root, config, rehearsal: 'paired-restore', connectionPort: 55484, scenario: 'deploy-owned' });
  if (!application.passed || !application.ownedApplicationSmoke || application.fullApplicationSmoke !== false) fail('GP_OWNED_PAIR_APPLICATION_RESULT');
  writePrivate(root + '/owned-smoke-child.result.json', JSON.stringify({ format: SMOKE_FORMAT, root, pid: process.pid, privateApplicationNetwork: true, application }) + '\n');
}
async function runSmokeChild(root) {
  directory(root);
  const output = fs.openSync(root + '/owned-smoke-child.stdout', 'wx', 0o600), error = fs.openSync(root + '/owned-smoke-child.stderr', 'wx', 0o600); let child;
  try { child = spawn(process.execPath, [__filename, '--smoke-child', root], { cwd: path.resolve(__dirname, '..'),
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', output, error] }); }
  finally { fs.closeSync(output); fs.closeSync(error); }
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(Object.assign(new Error('GP_OWNED_PAIR_SMOKE_CHILD_FAILED'), { code: 'GP_OWNED_PAIR_SMOKE_CHILD_FAILED', childExit: code, childSignal: signal })));
  });
  const proof = readPrivate(root + '/owned-smoke-child.result.json', root);
  if (proof.format !== SMOKE_FORMAT || proof.root !== root || proof.pid !== child.pid || proof.pid === process.pid || proof.privateApplicationNetwork !== true
    || !proof.application?.passed || proof.application?.ownedApplicationSmoke !== true || proof.application?.fullApplicationSmoke !== false) fail('GP_OWNED_PAIR_SMOKE_CHILD_PROOF');
  return { ...proof.application, freshProcess: true, smokeProcessPid: proof.pid };
}
const HEADER_TABLES = [
  ['core', 'gp', 'data_import_sources', ['id','scope_id','owner_id','created_at']],
  ['core','gp','import_master_holds'],['core','gp','trade_source_references'],['core','gp','trade_source_reference_versions'],
  ...[
  ['kassa', 'cash_snapshot_datasets'], ['kassa', 'cash_snapshot_inventory'], ['kassa', 'cash_publications'],
  ['kassa', 'cash_publication_bindings'], ['kassa', 'cash_publication_state'], ['kassa', 'cash_binding_inventory'],
  ['trade', 'sales_article_own_images'],
  ].map(table => ['sales', ...table]),
];
async function headerProof(clients,{fresh=false}={}) {
  const tables = [];
  for (const [domain, schema, table, keys] of HEADER_TABLES) {
    if(fresh&&['cash_snapshot_datasets','cash_snapshot_inventory','cash_publication_state'].includes(table))continue;
    const selection = keys ? keys.filter(key=>!fresh||table!=='data_import_sources'||key!=='created_at').map(key => 't."' + key + '"').join(',') : 't.*';
    const rows = (await clients[domain].query('SELECT to_jsonb(r) AS value FROM (SELECT ' + selection + ' FROM "' + schema + '"."' + table + '" t) r ORDER BY to_jsonb(r)::text')).rows;
    tables.push({ domain, schema, table, rows: rows.length, sha256: sha(JSON.stringify(rows)),...(fresh&&table!=='sales_article_own_images'&&!['import_master_holds','trade_source_references','trade_source_reference_versions'].includes(table)?{rowSha256s:rows.map(row=>sha(JSON.stringify(row))).sort()}: {}) });
  }
  return { tables, sha256: sha(JSON.stringify(tables)) };
}
async function seedUnappliedTrade({access,vault,fixture,isolatedRecovery=false}){
 if(isolatedRecovery!==true||process.platform!=='linux'||process.getuid()===0||access?.getCapabilities?.().providerId!=='postgresql'||Object.values(os.networkInterfaces()).flat().some(item=>!item.internal)
  ||fixture?.format!==fixtures.FORMAT||fixture.generation!=='fresh'||fixture.syntheticOnly!==true||!FRESH_FIXTURE.test(fixture.directory+'/fixture-receipt.json'))fail('GP_OWNED_PAIR_ISOLATION');
 const S=require('../lib/tradefoto-full-import-source'),file=fixture.files.find(file=>file.kind==='trade');
 if(!file||file.file!==fixture.directory+'/synthetic-trade.accdb')fail('GP_OWNED_PAIR_FRESH_INPUT');
 directory(fixture.directory);const info=fs.lstatSync(file.file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid()||info.mode&0o077||fs.realpathSync(file.file)!==file.file)fail('GP_OWNED_PAIR_FRESH_INPUT');
 const buffer=fs.readFileSync(file.file);
 if(sha(buffer)!==file.fileSha256||buffer.length!==file.bytes)fail('GP_OWNED_PAIR_FRESH_INPUT_CHANGED');
 const getSession=async()=>({employeeNumber:'00001',isEmployee:true,role:'developer',permissions:[...Object.values(require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS),...Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS),'sales:analytics:access','sales:analytics:company:read']});
 const runtime=require('../lib/persistence/repositories/data-import-runtime').createDataImportRuntime({access,vault,scopeId:'grabenplaner-main',allowApply:true,sharedPayloads:true,compactCash:true,syncArticleCatalog:true,
  clock:()=> '2026-11-16T12:00:01.000Z',readSource:options=>S.readTradeFotoFullSource({...options,send:options.onMessage})});
 try{
  let source=await runtime.upload(getSession,{buffer,kind:'trade',fileName:path.basename(file.file)}),steps=0;
  while(source.status==='reviewing'){if(++steps>1000)fail('GP_OWNED_PAIR_UNAPPLIED_REVIEW_LIMIT');source=await runtime.sourceOperation(getSession,source.id,'review',{expectedRevision:source.revision});}
  if(!source.complete||!['ready','needs_review'].includes(source.status)||source.tables.some(table=>!['ready','needs_review'].includes(table.run.status)||table.run.counts?.applied))fail('GP_OWNED_PAIR_UNAPPLIED_SOURCE');
  return {sourceId:source.id,status:source.status,fileSha256:source.fileSha256,tables:source.tables.length,rows:source.tables.reduce((n,table)=>n+table.run.receivedRows,0),applied:false};
 }finally{buffer.fill(0);await runtime.stop();}
}
function verifyOwnHeaders(actual,expected,{fresh=false}={}){
 if(!fresh)return equal(actual,expected,'GP_OWNED_PAIR_SOURCE_IDENTITIES_CHANGED');
 for(const table of expected.tables){
  const restored=actual.tables.find(row=>row.domain===table.domain&&row.schema===table.schema&&row.table===table.table);
  if(!restored)fail('GP_OWNED_PAIR_OWN_HEADERS_MISSING');
  if(table.rowSha256s){const hashes=new Set(restored.rowSha256s);if(table.rowSha256s.some(hash=>!hashes.has(hash)))fail('GP_OWNED_PAIR_OLD_AUDIT_CHANGED');}
  else equal(restored,table,'GP_OWNED_PAIR_OWN_IDENTITIES_CHANGED');
 }
}
async function expectedFreshContent(fixture,core,vault){
 const C=require('../lib/data-import-contract'),S=require('../lib/tradefoto-full-import-source'),M=require('../lib/tradefoto-master-profiles'),H=require('../lib/tradefoto-history-profiles');
 return require('../lib/persistence/postgresql/operations/owned-recovery').withProtection(core,vault,async protection=>{
  const sums={master:{rows:0,sum:0n,xor:0n},history:{rows:0,sum:0n,xor:0n}},mod=1n<<256n,scopeId='grabenplaner-main';
  for(const file of fixture.files.filter(file=>file.kind!=='cash')){
   const buffer=fs.readFileSync(file.file);try{
    if(sha(buffer)!==file.fileSha256||buffer.length!==file.bytes)fail('GP_OWNED_PAIR_FRESH_INPUT_CHANGED');
    const definitions=S.definitions(file.kind);
    await S.readTradeFotoFullSource({buffer,kind:file.kind,send:async event=>{
     if(event.type!=='rows')return;const def=definitions.find(def=>def.name===event.name);if(!def)fail('GP_OWNED_PAIR_FRESH_TABLE');
     for(const raw of event.rows){const record=C.normalizeDataImportRow(def.profile,raw),context={scopeId,sourceInstance:'tradefoto-'+file.kind};
      const identity=def.master?M.masterIdentity(protection,context,def.name,record.key):H.historyIdentity(protection,context,def.source,def.name,record.key);
      const value=def.master?[scopeId,context.sourceInstance,def.name,def.profile.fingerprint,identity,record.data]:[scopeId,context.sourceInstance,def.source,def.name,def.profile.fingerprint,identity,record.data];
      const target=sums[def.master?'master':'history'],hash=BigInt('0x'+sha(C.canonical(value)));target.rows++;target.sum=(target.sum+hash)%mod;target.xor^=hash;
     }
    }});
   }finally{buffer.fill(0);}
  }
  return Object.fromEntries(Object.entries(sums).map(([name,s])=>[name,{rows:s.rows,sumSha256:s.sum.toString(16).padStart(64,'0'),xorSha256:s.xor.toString(16).padStart(64,'0')}]));
 });
}
async function historyAnchorProof(sales,anchor){
 const tables=[];
 for(const table of ['import_history_versions','import_history_segments','import_history_references']){
  const rows=(await sales.query('SELECT to_jsonb(t) AS value FROM integration.'+table+' t WHERE record_id=$1 AND revision=$2 ORDER BY to_jsonb(t)::text',[anchor.recordId,anchor.sourceRevision])).rows;
  tables.push({table,rows:rows.length,sha256:sha(JSON.stringify(rows))});
 }
 const holds=(await sales.query('SELECT record_id,consumer_id FROM integration.import_history_holds WHERE record_id=$1 ORDER BY consumer_id',[anchor.recordId])).rows;
 return {tables,holds};
}
function equal(actual, expected, code) { if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code); }
function applicationUrls(config, port) {
  return Object.fromEntries(config.domains.map(domain => {
    const url = new URL('postgresql://127.0.0.1:' + port + '/' + domain.database); const role = 'gp_' + domain.domain + '_app';
    url.username = role; url.password = config.recoveryAccounts[role]; return [domain.domain + 'Url', url.href];
  }));
}
async function qualifyPair({ sourceAppRoot, environmentFile, clusterMarker, dataDirectory, restoreWork, rehydrateWork, fixtureReceipt,freshFixtureReceipt }) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !SOURCE.test(sourceAppRoot || '') || !RESTORE.test(restoreWork || '') || !RESTORE.test(rehydrateWork || '')
    || new Set([SOURCE.exec(sourceAppRoot)?.[1], RESTORE.exec(restoreWork)?.[1], RESTORE.exec(rehydrateWork)?.[1]]).size !== 3
    || !FIXTURE.test(fixtureReceipt || '') || Object.values(os.networkInterfaces()).flat().some(item => !item.internal)) fail('GP_OWNED_PAIR_ISOLATION');
  const fresh=freshFixtureReceipt!==undefined;
  if(fresh&&!FRESH_FIXTURE.test(freshFixtureReceipt))fail('GP_OWNED_PAIR_FRESH_FIXTURE_PATH');
  const runRoot = path.dirname(path.dirname(sourceAppRoot)); directory(sourceAppRoot); directory(runRoot); directory(restoreWork); directory(rehydrateWork); directory(path.dirname(fixtureReceipt));
  if (fs.readdirSync(restoreWork).length || fs.readdirSync(rehydrateWork).length || !dataDirectory?.startsWith(runRoot + '/') || fs.realpathSync(dataDirectory) !== dataDirectory) fail('GP_OWNED_PAIR_NEW_WORKSPACE');
  const fixture = readPrivate(fixtureReceipt, path.dirname(fixtureReceipt));
  if (fixture.directory !== path.dirname(fixtureReceipt) || fixture.format !== fixtures.FORMAT || fixture.syntheticOnly !== true || fixture.actualAccessParser !== true || fixture.injectedReader !== false) fail('GP_OWNED_PAIR_ACCESS_FIXTURE');
  let freshFixture,freshSourceDirectory;
  if(fresh){
   directory(path.dirname(freshFixtureReceipt));freshFixture=readPrivate(freshFixtureReceipt,path.dirname(freshFixtureReceipt));
   if(freshFixture.directory!==path.dirname(freshFixtureReceipt)||freshFixture.format!==fixtures.FORMAT||freshFixture.generation!=='fresh'||freshFixture.syntheticOnly!==true||freshFixture.actualAccessParser!==true||freshFixture.injectedReader!==false||freshFixture.files?.length!==6)fail('GP_OWNED_PAIR_FRESH_FIXTURE');
   freshSourceDirectory=runRoot+'/fresh-access';fs.mkdirSync(freshSourceDirectory,{mode:0o700});
   for(const entry of require('../lib/data-import-source-catalog').SOURCE_CATALOG.filter(entry=>entry.available)){
    const file=freshFixture.files.find(file=>file.kind===entry.kind),old=fixture.files.find(file=>file.kind===entry.kind);
    if(!file||!old||!file.file.startsWith(freshFixture.directory+'/')||file.fileSha256===old.fileSha256)fail('GP_OWNED_PAIR_FRESH_GENERATION_REQUIRED');
    const info=fs.lstatSync(file.file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid()||info.mode&0o077||fs.realpathSync(file.file)!==file.file)fail('GP_OWNED_PAIR_FRESH_INPUT');
    const buffer=fs.readFileSync(file.file);try{if(buffer.length!==file.bytes||sha(buffer)!==file.fileSha256)fail('GP_OWNED_PAIR_FRESH_INPUT_CHANGED');writePrivate(freshSourceDirectory+'/'+entry.fileName,buffer);}finally{buffer.fill(0);}
   }
  }
  directory(dataDirectory);
  const environment = readPrivate(environmentFile, runRoot), marker = readPrivate(clusterMarker, runRoot);
  const prior = readPrivate(sourceAppRoot + '/complete-schema-owned-smoke.json', runRoot);
  if (marker.format !== 'gp-deploy-owned-local-v1' || marker.host !== '127.0.0.1' || marker.port !== 55482 || marker.bootstrapRole !== 'gp_migration_admin'
    || marker.database !== 'grabenplaner_test' || !/^[0-9]+$/.test(marker.clusterId || '') || prior.format !== SOURCE_FORMAT
    || prior.clusterId !== marker.clusterId || prior.root !== sourceAppRoot || prior.syntheticOnly !== true || prior.productionContact !== false
    || prior.completeSchema !== true || prior.application?.ownedApplicationSmoke !== true || prior.application?.fullApplicationSmoke !== false) fail('GP_OWNED_PAIR_SOURCE_PROOF');
  const accounts = {}, urls = {};
  for (const domain of ['core', 'sales']) for (const purpose of ['app', 'reader', 'migrator']) {
    const role = 'gp_' + domain + '_' + purpose, url = new URL(environment[role.toUpperCase() + '_URL'] || '');
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55482' || url.pathname !== '/gp_migration_' + domain
      || decodeURIComponent(url.username) !== role || decodeURIComponent(url.password).length < 24 || url.search || url.hash) fail('GP_OWNED_PAIR_ENDPOINT');
    accounts[role] = decodeURIComponent(url.password); urls[role] = url.href;
  }
  const sourceAdmin = new URL(environment.GP_MIGRATION_ADMIN_URL || environment.TEST_POSTGRESQL_URL || '');
  if (sourceAdmin.protocol !== 'postgresql:' || sourceAdmin.hostname !== '127.0.0.1' || sourceAdmin.port !== '55482' || sourceAdmin.pathname !== '/grabenplaner_test'
    || decodeURIComponent(sourceAdmin.username) !== 'gp_migration_admin' || decodeURIComponent(sourceAdmin.password).length < 24 || sourceAdmin.search || sourceAdmin.hash) fail('GP_OWNED_PAIR_ADMIN_ENDPOINT');
  sourceAdmin.pathname = '/postgres';
  const admin = new Client({ connectionString: sourceAdmin.href, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const core = new Client({ connectionString: urls.gp_core_migrator, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const encryptionFile = sourceAppRoot + '/source-encryption.env', encryption = require('node:util').parseEnv(readPrivate(encryptionFile, runRoot, false));
  const vault = recoveryVault(encryption), keyContext = { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' };
  let archiveProof, seeded, ownedContent, ownedMasterAnchor,ownedHistoryAnchor,ownedHistoryProof,unappliedSource,sourceHeaders, sourceBusinessContent,freshBusinessContent,pureArticleId, coreConnected = false, adminConnected = false, application;
  const progress = (phase, details = {}) => fs.appendFileSync(runRoot + '/pair-restore-progress.jsonl', JSON.stringify({ phase, ...details, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  try {
    await admin.connect(); adminConnected = true;
    const state = (await admin.query("SELECT system_identifier::text AS id,current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,current_setting('port') AS port,(SELECT rolname FROM pg_authid WHERE oid=10) AS bootstrap FROM pg_control_system()")).rows[0];
    if (state.id !== marker.clusterId || state.data !== dataDirectory || state.listen !== '127.0.0.1' || state.port !== '55482' || state.bootstrap !== 'gp_migration_admin') fail('GP_OWNED_PAIR_CLUSTER_IDENTITY');
    if ((await admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n !== 0) fail('GP_OWNED_PAIR_ACTIVE_CLIENTS');
    await core.connect(); coreConnected = true; await verifyEnvironment(core, { purpose: 'migrator' });
    const ownership = (await core.query("SELECT value FROM gp.settings WHERE key='migration-test-owner'")).rows;
    if (ownership.length !== 1 || ownership[0].value !== SOURCE_FORMAT + ':' + SOURCE.exec(sourceAppRoot)[1]) fail('GP_OWNED_PAIR_BUSINESS_OWNER');
    if ((await admin.query("SELECT rolname FROM pg_roles WHERE rolname='gp_operations_monitor'")).rows.length) fail('GP_OWNED_PAIR_ROLES_ALREADY_EXIST');
    const databases = (await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows.map(row => row.datname);
    if (databases.join(',') !== 'gp_migration_core,gp_migration_sales,grabenplaner_test,postgres') fail('GP_OWNED_PAIR_DATABASE_SET');
    // The dedicated fixture was initialized as gp_migration_admin OID 10 before
    // schemas/grants were created. No grantor renaming or ledger patch is used.
    accounts.gp_migration_admin = decodeURIComponent(sourceAdmin.password); accounts.gp_operations_monitor = crypto.randomBytes(36).toString('base64url');
    await admin.query((await admin.query('SELECT format($1::text,$2::text,$3::text) AS sql', ['CREATE ROLE %I LOGIN PASSWORD %L', 'gp_operations_monitor', accounts.gp_operations_monitor])).rows[0].sql);
    await admin.query('GRANT pg_monitor TO gp_operations_monitor'); await admin.query('DROP DATABASE grabenplaner_test');
    await core.query('BEGIN'); await core.query('SET LOCAL ROLE gp_core_owner');
    let keys = (await core.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1' FOR UPDATE")).rows;
    if (!keys.length) {
      const bytes = crypto.randomBytes(64); try { await core.query('INSERT INTO gp.data_import_runtime_keys(id,payload,created_at) VALUES($1,$2,$3)', ['data-import-v1', vault.seal(bytes, keyContext), new Date().toISOString()]); } finally { bytes.fill(0); }
      keys = (await core.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1'")).rows;
    }
    if (keys.length !== 1) fail('GP_OWNED_PAIR_IMPORT_KEY');
    await vault.useSecret(keys[0].payload, keyContext, bytes => { if (bytes.length !== 64) fail('GP_OWNED_PAIR_IMPORT_KEY'); });
    await core.query('COMMIT');
    const runtime = sourceAppRoot + '/runtime'; directory(runtime); directory(runtime + '/private');
    const archive = createImportSourceArchive({ directory: runtime + '/private/import-sources', vault });
    const beforeArchive = await archive.verify(); if (beforeArchive.available || beforeArchive.candidates.length) fail('GP_OWNED_PAIR_SOURCE_ARCHIVE_OCCUPIED');
    // The source identity/ownership guards above precede ordinary application
    // writes. Close privileged preparation clients before opening app pools.
    await core.end(); coreConnected = false; await admin.end(); adminConnected = false;
    application = await openTwoDatabaseDevelopmentApplication({ coreUrl: urls.gp_core_app, salesUrl: urls.gp_sales_app, stage: 8, autoDeliver: false, authorize: () => true });
    seeded = await fixtures.seedAccessRecoveryFixture({ access: application.provider, vault, archive, fixture, isolatedRecovery: true,
      onProgress: event => progress('seed-access', event) });
    archiveProof = seeded.archiveProof;
    if (seeded.sources.length !== 6 || seeded.sources.some(source => source.kind !== 'cash' && source.status !== 'applied') || archiveProof.kinds.some(slot => !slot.current)
      ||seeded.legacyCashHistory?.actualAccessParser!==true||seeded.legacyCashHistory?.tables!==7||seeded.legacyCashHistory?.rows!==7) fail('GP_OWNED_PAIR_ACCESS_SEED');
    ownedContent = await fixtures.seedOwnArticleContent({ access: application.provider, isolatedRecovery: true });
    ownedMasterAnchor=await fixtures.seedOwnMasterAnchor({access:application.provider,isolatedRecovery:true});
    if(fresh){
     const H=require('../lib/persistence/statements/import-history').IMPORT_HISTORY_STATEMENTS;
     const records=await application.provider.queryAll(H.list,{scopeId:'grabenplaner-main',sourceInstance:'tradefoto-trade',source:'trade',sourceTable:'ARTIKEL_FILIALEN',after:'',limit:3,snapshot:null});
     if(records.length!==2)fail('GP_OWNED_PAIR_STOCK_ANCHOR');
     await application.provider.transaction(tx=>tx.execute(H.insertHold,{recordId:records[0].id,consumerId:'gp.synthetic-owned-stock-reference'}),{isolation:'serializable'});
     ownedHistoryAnchor={recordId:records[0].id,sourceRevision:records[0].revision,consumerId:'gp.synthetic-owned-stock-reference'};
     pureArticleId=(await require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(application.provider).getByArticleNumber('000043')).productId;
     // This is the real large-copy failure case: a second authenticated Trade
     // generation was parsed/reviewed but never applied. Its source rows and
     // proposed links must not make a supposedly compact point retain bulk.
     unappliedSource=await seedUnappliedTrade({access:application.provider,vault,fixture:freshFixture,isolatedRecovery:true});
    }
    await application.close(); application = null;
    const readers = Object.fromEntries(['core', 'sales'].map(domain => [domain, new Client({ connectionString: urls['gp_' + domain + '_reader'], connectionTimeoutMillis: 5000 })]));
    try { await Promise.all(Object.values(readers).map(reader => reader.connect())); sourceHeaders = await headerProof(readers,{fresh});sourceBusinessContent=await contentProof({...readers,vault});if(fresh){freshBusinessContent=await expectedFreshContent(freshFixture,readers.core,vault);ownedHistoryProof=await historyAnchorProof(readers.sales,ownedHistoryAnchor);} }
    finally { await Promise.all(Object.values(readers).map(reader => reader.end())); }
    for (const table of ['data_import_sources', 'cash_publications', 'cash_publication_bindings','sales_article_own_images']) {
      if (!sourceHeaders.tables.find(t => t.table === table)?.rows) fail('GP_OWNED_PAIR_EMPTY_SOURCE_METADATA');
    }
    progress('seed-complete', { sources: seeded.sources.length, headersSha256: sourceHeaders.sha256 });
  } finally { await application?.close(); if (coreConnected) { await core.query('ROLLBACK').catch(() => {}); await core.end(); } if (adminConnected) await admin.end(); }
  // No preparatory application/domain connections survive the drained guard.
  const backupDirectory = runRoot + '/pair-backups', workDirectory = runRoot + '/pair-operations';
  for (const name of [backupDirectory, workDirectory]) { fs.mkdirSync(name, { mode: 0o700 }); directory(name); }
  const config = { format: R.FORMAT, mode: 'qualification', host: '127.0.0.1', port: 55482, clusterId: marker.clusterId,
    sourceFiles: sourceAppRoot + '/runtime', environmentFile: encryptionFile, backupDirectory, workDirectory,
    domains: ['core', 'sales'].map(domain => ({ domain, database: 'gp_migration_' + domain, role: 'gp_' + domain + '_migrator', password: accounts['gp_' + domain + '_migrator'], environmentId: ENVIRONMENT_ID, profile: PROFILE })),
    administrator: { role: 'gp_migration_admin', password: accounts.gp_migration_admin }, monitor: { role: 'gp_operations_monitor', password: accounts.gp_operations_monitor }, recoveryAccounts: accounts };
  const startedAt = new Date().toISOString(), backup = await R.createBackup(config, { scope: 'deploy-owned',basis:fresh?'fresh-source-rebuild':'exact-archive' });
  if (!backup.ok || backup.providerId !== 'postgresql-deploy-owned' || backup.fullRecovery !== false) fail('GP_OWNED_PAIR_BACKUP_RESULT');
  const manifest = JSON.parse(fs.readFileSync(backup.bundle + '/manifest.json', 'utf8')), replayPlan=manifest.recovery?.sourceReplayPlan;
  if(!fresh&&(manifest.recovery?.accessPlan?.format!=='grabenplaner-access-owned-state-v3'||!replayPlan
    || ['trade','bestell','weum','inventur','lieferantenrechnungen'].some(kind=>!replayPlan.sources.some(s=>s.kind===kind&&s.strategy==='normal-import'))
    || !manifest.recovery.cashPlan.datasets.length)) fail('GP_OWNED_PAIR_ACCESS_OMISSION');
  if(fresh&&(manifest.recovery?.accessPlan?.format!=='grabenplaner-access-owned-state-v4'||manifest.recovery.basis!=='fresh-source-rebuild'||manifest.recovery.sourceArchive!==undefined||manifest.recovery.freshSourcePlan?.kinds.length!==6))fail('GP_OWNED_PAIR_FRESH_OMISSION');
  if(fresh&&manifest.recovery.accessPlan.stats.omittedUnappliedAccessRuns!==unappliedSource.tables)fail('GP_OWNED_PAIR_UNAPPLIED_SOURCE_RETAINED');
  for(const table of ['data_import_rows','data_import_changes','data_import_row_payload_refs','data_import_change_payload_refs','data_import_payload_blocks',...(fresh?[]:['import_history_records','import_history_versions','import_history_segments','import_history_references'])]){
   if(!manifest.recovery.accessPlan.tables.some(t=>t.table===table&&t.rows===0))fail('GP_OWNED_PAIR_DERIVED_ROWS_RETAINED');
  }
  if(fresh){if(fs.existsSync(backup.bundle+'/private/import-sources')||manifest.files.some(file=>file.file.startsWith('private/import-sources/')))fail('GP_OWNED_PAIR_SOURCE_VALUES_IN_BUNDLE');}
  else{const archiveFiles = fs.readdirSync(backup.bundle + '/private/import-sources');
   if (archiveFiles.length !== 1 || archiveFiles[0] !== 'index.source-archive' || manifest.files.some(file => /^private\/import-sources\/.+\.source$/.test(file.file))) fail('GP_OWNED_PAIR_SOURCE_VALUES_IN_BUNDLE');}
  async function restore(rehydrate, workRoot) {
    const result = await restorePair({ bundle: backup.bundle, commitMarker: backup.commitMarker, workRoot, scope: 'deploy-owned', privateApplicationNetwork: true, rehydrate,
      ...(rehydrate ? fresh?{freshSourceDirectory}:{ sourceArchiveDirectory: sourceAppRoot + '/runtime/private/import-sources' } : {}),
      onProgress: phase => progress(phase, { rehydrate }),
      async onOwnedRestored({ config: restored, connect, workRoot, bundle, rehydrated }) {
      if (rehydrated !== rehydrate) fail('GP_OWNED_PAIR_RESTORE_MODE');
      const schemaUpgrades = await require('../server-tools/linux/recovery/lib/postgresql-recovery-worker').prepareRestoredSchema({ config: restored, connect });
      const readers = Object.fromEntries(['core', 'sales'].map(domain => [domain, connect(restored.domains.find(d => d.domain === domain).database, 'gp_' + domain + '_reader')])); let restoredHeaders,restoredBusinessContent;
      try { await Promise.all(Object.values(readers).map(reader => reader.connect())); restoredHeaders = await headerProof(readers,{fresh});if(rehydrated)restoredBusinessContent=await contentProof({...readers,vault});if(fresh){equal(await historyAnchorProof(readers.sales,ownedHistoryAnchor),ownedHistoryProof,'GP_OWNED_PAIR_OLD_HELD_VERSION_CHANGED');
       const anchor=(await readers.sales.query('SELECT revision::text AS revision FROM trade.import_master_records WHERE id=$1',[ownedMasterAnchor.recordId])).rows;
       if(anchor.length!==1||Number(anchor[0].revision)!==ownedMasterAnchor.sourceRevision+(rehydrated?1:0))fail('GP_OWNED_PAIR_MASTER_ID_OR_HEAD_CHANGED');
      } }
      finally { await Promise.all(Object.values(readers).map(reader => reader.end())); }
      verifyOwnHeaders(restoredHeaders,sourceHeaders,{fresh});
      if(rehydrated){
       if(fresh){for(const kind of ['master','history'])equal(restoredBusinessContent[kind],freshBusinessContent[kind],'GP_OWNED_PAIR_FRESH_BUSINESS_CONTENT_CHANGED');
        const stock=restoredBusinessContent.latestPublishedSnapshots.find(row=>row.sourceInstance==='tradefoto-trade');if(stock?.fileSha256!==freshFixture.files.find(file=>file.kind==='trade').fileSha256||stock.rows!==2)fail('GP_OWNED_PAIR_FRESH_STOCK_PUBLICATION');
       }else equal(restoredBusinessContent,sourceBusinessContent,'GP_OWNED_PAIR_BUSINESS_CONTENT_CHANGED');
      }
      let application;
      try {
        application = await openTwoDatabaseDevelopmentApplication({ ...applicationUrls(restored, 55484), stage: 8, autoDeliver: false, authorize: () => true });
        equal(await fixtures.ownContentProof(application.provider), ownedContent, 'GP_OWNED_PAIR_OWN_CONTENT_CHANGED');
        if(fresh&&rehydrated){const article=await require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(application.provider).getByArticleNumber('000043');
         if(article?.productId!==pureArticleId||article.description!=='Fresh Access article 43'||!article.prices.some(price=>price.priceType==='sales'&&price.priceBasis==='gross'&&price.amount==='24.000000000000'))fail('GP_OWNED_PAIR_FRESH_CATALOG_CONTENT');
        }
      } finally { await application?.close(); }
      const applicationRoot = workRoot + '/application'; fs.mkdirSync(applicationRoot, { mode: 0o700 });
      writePrivate(applicationRoot + '/ownership-marker', 'grabenplaner-postgresql-full-application-v1\n');
      for (const [from, to] of [['postgresql-operations.json', 'operations-config.json'], ['configuration.env', 'source-encryption.env']]) { fs.copyFileSync(bundle + '/' + from, applicationRoot + '/' + to, fs.constants.COPYFILE_EXCL); fs.chmodSync(applicationRoot + '/' + to, 0o600); }
      for (const name of ['private', 'branding-kits']) if (fs.existsSync(bundle + '/' + name)) fs.cpSync(bundle + '/' + name, applicationRoot + '/' + name, { recursive: true, force: false, errorOnExist: true, dereference: false });
      // The actual recovery worker is one-shot. A second server require in the
      // same process would reuse the first rehearsal's already closed pools.
      const smoke = await runSmokeChild(applicationRoot);
      if (!smoke.passed || !smoke.ownedApplicationSmoke || smoke.fullApplicationSmoke !== false) fail('GP_OWNED_PAIR_APPLICATION_RESULT');
      return { ...smoke, compatibility: true, schemaUpgrades, gpIdentitiesPreserved: true, cashPublicationMetadataPreserved: true,...(fresh?{freshSourceGeneration:rehydrated,oldHeldRevisionPreserved:true,ownCashMappingAuditPreserved:true}:{}),
        ownArticleDescriptionPriceAndImagePreserved: true, headersSha256: restoredHeaders.sha256, ownedContent,...(rehydrated?{businessContent:restoredBusinessContent}: {}) };
    } });
    if (!result.verified || result.providerId !== 'postgresql-deploy-owned' || result.fullRecovery !== false || result.application?.ownedApplicationSmoke !== true
      || result.application?.fullApplicationSmoke !== false || result.manifestSha256 !== backup.sha256 || result.accessRehydration?.rehydrated !== rehydrate) fail('GP_OWNED_PAIR_RESTORE_RESULT');
    if (rehydrate && (result.cashRehydration?.verified !== true || !fresh&&result.cashRehydration.rowsRestored < 1 || result.requiresAccessRehydration !== false || result.requiresCashRehydration !== false)) fail('GP_OWNED_PAIR_REPLAY_RESULT');
    if(fresh&&result.requiresFreshAccess!==!rehydrate)fail('GP_OWNED_PAIR_FRESH_RESULT');
    return result;
  }
  const result = await restore(false, restoreWork), replay = await restore(true, rehydrateWork);
  if (result.application.smokeProcessPid === replay.application.smokeProcessPid) fail('GP_OWNED_PAIR_SMOKE_PROCESS_REUSED');
  const sourceRoot = path.resolve(__dirname, '..'), files = ['server.js', 'lib/persistence/postgresql/operations/runtime.js', 'lib/persistence/postgresql/operations/paired-restore.js',
    'lib/persistence/postgresql/operations/access-owned-state.js', 'lib/persistence/postgresql/operations/access-source-replay.js',
    'lib/persistence/postgresql/operations/access-fresh-rebuild.js',
    'lib/persistence/repositories/data-import-runtime.js','test-support/access-recovery-content-proof.cjs',
    'server-tools/linux/recovery/lib/postgresql-application-smoke.js', 'test-support/postgresql-deploy-owned-pair.cjs', 'test-support/postgresql-access-recovery-fixture.cjs', 'test-support/AccessRecoveryFixture.java'];
  const receipt = { format: FORMAT, syntheticOnly: true, productionContact: false, completeSchema: true, actualNativeBackup: true, actualNativeRestore: true,
    providerId: result.providerId, fullRecovery: false, fullSalesRecovery: false, actualAccessParsing: true, actualSixSourceReplay: true, injectedAccessReader: false,
    bootstrapIdentity: { role: 'gp_migration_admin', oid: 10, initializedBeforeSchema: true },
    sourceArchive: { generationSha256: archiveProof.generationSha256, sources: seeded.sources, sourceObjectsInBundle: false },
    omission: manifest.recovery.accessPlan.stats, sourceHeaders, sourceBusinessContent, ownedContent, ownedMasterAnchor,legacyCashHistory:seeded.legacyCashHistory,...(fresh?{basis:'fresh-source-rebuild',freshFixture,freshBusinessContent,ownedHistoryAnchor,ownedHistoryProof,unappliedSource,oldOriginalFilesRequired:false}:{}),
    source: { version: JSON.parse(fs.readFileSync(sourceRoot + '/package.json')).version, files: files.map(file => ({ file, sha256: sha(fs.readFileSync(sourceRoot + '/' + file)) })) },
    startedAt, completedAt: new Date().toISOString(), backup, restore: result, replay };
  writePrivate(runRoot + '/complete-pair-owned-backup-restore.json', JSON.stringify(receipt) + '\n'); return receipt;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--smoke-child') {
    const root = args.length === 2 ? args[1] : null;
    qualifySmokeChild(root).then(() => process.stdout.write('{"ownedApplicationSmoke":true,"passed":true}\n')).catch(error => {
      try { if (process.platform === 'linux' && process.getuid() !== 0 && SOURCE.test(root || '')) { directory(root); writePrivate(root + '/owned-smoke-child.failure.private.json', JSON.stringify({ code: error.code || null, message: String(error.message || ''), stack: String(error.stack || '') }) + '\n'); } } catch {}
      process.stderr.write(JSON.stringify({ failed: true, code: /^(?:GP_|PG_)[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'GP_OWNED_PAIR_SMOKE_CHILD_FAILED' }) + '\n'); process.exitCode = 1;
    });
  } else {
  const options = {}, names = { '--source-app-root': 'sourceAppRoot', '--environment-file': 'environmentFile', '--cluster-marker': 'clusterMarker', '--data-directory': 'dataDirectory', '--restore-work': 'restoreWork', '--rehydrate-work': 'rehydrateWork', '--fixture-receipt': 'fixtureReceipt','--fresh-fixture-receipt':'freshFixtureReceipt' };
  for (let i = 0; i < args.length; i += 2) { if (!names[args[i]] || !args[i + 1] || Object.hasOwn(options, names[args[i]])) fail('GP_OWNED_PAIR_ARGUMENTS'); options[names[args[i]]] = args[i + 1]; }
  qualifyPair(options).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    try { if (process.platform === 'linux' && process.getuid() !== 0 && SOURCE.test(options.sourceAppRoot || '')) { directory(options.sourceAppRoot); writePrivate(path.dirname(path.dirname(options.sourceAppRoot)) + '/complete-pair-owned.failure.private.json', JSON.stringify({ code: error.code || null, message: String(error.message || ''), stack: String(error.stack || ''), ...(error.syntheticDiagnostic ? { syntheticDiagnostic: error.syntheticDiagnostic } : {}) }) + '\n'); } } catch {}
    process.stderr.write(JSON.stringify({ failed: true, code: /^GP_|^PG_/.test(error.code || '') ? error.code : 'GP_OWNED_PAIR_FAILED' }) + '\n'); process.exitCode = 1;
  });
  }
}
module.exports = { qualifyPair,seedUnappliedTrade };
