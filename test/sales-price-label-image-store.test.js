'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const sharp = require('sharp'), express = require('express'), { Readable } = require('node:stream');
const I = require('../lib/sales-price-label-image-store'), T = require('../lib/sales-price-label-template-store');
const { createAmuStorage, syncEncryptedFilesBackup, restoreEncryptedFilesBackup } = require('../lib/amu-storage');
const { fixture: persistenceFixture } = require('../test-support/trade-insights-sqlite');
const { registerSalesPriceLabelsRoutes } = require('../lib/sales-price-labels-routes');
const rights = Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS);
const box = assetId => ({ assetId, xMm: 2, yMm: 2, widthMm: 20, heightMm: 15 });
const input = (assetId, extra = {}) => ({ title: 'Synthetic label', options: { imageBoxes: [box(assetId)] }, filenameOptions: {}, visibility: 'private', recipients: [], ...extra });
const png = () => sharp({ create: { width: 120, height: 80, channels: 4, background: '#25A98988' } }).png().toBuffer();
async function fixture(t, { storageKeyId = 'synthetic' } = {}) {
 const p = await persistenceFixture(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-price-images-'));
 t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
 const state = { scans: 0, clean: true, gates: 0, gateActive: false, freshHook: null, accounts: ['18','19'].map(id => ({ id: 'acc' + id, active: true,
  accountType: 'branch', scopes: [{ locationId: id, departmentId: null }], locationActive: true })), sessions: {} };
 for (const id of ['42','43']) state.sessions[id] = { employeeNumber: id, accountId: 'employee-' + id, sessionKind: 'employee', isEmployee: true, homeLocationId: id === '42' ? '18' : '19', permissions: rights, scopes: [] };
 state.sessions.acc19 = { accountId: 'acc19', sessionKind: 'organization', isEmployee: false, accountType: 'branch', permissions: [...rights, 'branch_articles:read'], scopes: [{ locationId: '19', departmentId: null }] };
 const deps = { listBranchAccounts: async () => state.accounts, getEmployeeHomeLocation: async id => ({ id: state.sessions[id].homeLocationId, active: true }) };
 const storageOptions = { rootDirectory: path.join(directory, 'amu'), activeKeyId: storageKeyId, encryptionKeys: { [storageKeyId]: Buffer.alloc(32, 25) }, requireScanner: true,
  scanner: async () => { state.scans++; return { available: true, clean: state.clean, engine: 'synthetic' }; } };
 let storage = createAmuStorage(storageOptions), images;
 const templates = T.createSalesPriceLabelTemplateStore({ access: p.app.provider, vault: p.vault, validateImages: (...args) => images.validateOptions(...args) });
 images = I.createSalesPriceLabelImageStore({ access: p.app.provider, vault: p.vault, storage: () => storage, canReadAsset: (context, id) => templates.canReadImage(context, id) });
 const context = id => T.resolveTemplateSessionContext(state.sessions[id || '42'], deps);
 return { p, directory, state, deps, context, images, templates, storage: () => storage, restoreStorage: (rootDirectory = storageOptions.rootDirectory) => { storage = createAmuStorage({ ...storageOptions, rootDirectory }); } };
}
test('image decoding checks magic, complete raster decode and bounds; output strips metadata and scales without external references', async () => {
 const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#256477' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
 const image = await I.normalizeImage(source), meta = await sharp(image.buffer).metadata();
 assert.equal(meta.format, 'png'); assert.equal(Math.max(meta.width, meta.height), 1600); assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
 for (const buffer of [Buffer.from('<svg><image href="file:///etc/passwd"/></svg>'), Buffer.from('<html>bad</html>'), (await png()).subarray(0, 30), Buffer.alloc(0), Buffer.alloc(I.MAX_UPLOAD_BYTES + 1)])
  await assert.rejects(I.normalizeImage(buffer), error => error.status === 400 || error.status === 413);
 const bomb = Buffer.from(await png()); bomb.writeUInt32BE(250000, 16); await assert.rejects(I.normalizeImage(bomb));
 for (const format of ['webp', 'jpeg', 'gif']) assert.equal((await sharp((await I.normalizeImage(await sharp(await png())[format]().toBuffer())).buffer).metadata()).format, 'png');
});
test('bounded multipart accepts one image and rejects extra parts, forged field names, unsupported body types and oversized requests', async () => {
 const bytes = await png(), token = 'synthetic-boundary';
 const payload = name => Buffer.concat([Buffer.from(`--${token}\r\nContent-Disposition: form-data; name="${name}"; filename="../../ignored.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${token}--\r\n`)]);
 const request = (buffer, type = 'multipart/form-data; boundary=' + token, length = buffer.length) => Object.assign(Readable.from([buffer]), { headers: { 'content-type': type, 'content-length': String(length) } });
 assert.deepEqual(await I.readImageUpload(request(payload('image'))), bytes);
 for (const req of [request(payload('owner')), request(Buffer.concat([payload('image'), payload('image')])), request(bytes, 'application/json'), request(bytes, 'image/png', I.MAX_UPLOAD_BYTES + 20000)]) await assert.rejects(I.readImageUpload(req));
 assert.deepEqual(await I.readImageUpload(request(bytes, 'image/png')), bytes);
});
test('scanned encrypted blobs and protected metadata survive store reconstruction and existing backup copy without exposing source names', async t => {
 const f = await fixture(t), context = await f.context(), image = await f.images.create(context, await png());
 assert.equal(f.state.scans, 1); assert.match(image.assetId, /^[a-f0-9-]{36}$/); assert.equal(image.mime, 'image/png'); assert.equal(Object.hasOwn(image, 'storageKey'), false);
 const original = (await f.images.content(context, image.assetId)).buffer; f.restoreStorage(); assert.deepEqual((await f.images.content(context, image.assetId)).buffer, original);
 const copied = path.join(f.directory, 'backup'); syncEncryptedFilesBackup({ sourceDirectory: path.join(f.directory, 'amu'), targetDirectory: copied });
 const encryptedFiles = fs.readdirSync(path.join(f.directory, 'amu', 'blobs'), { recursive: true }).filter(name => name.endsWith('.amu'));
 for (const name of encryptedFiles) assert.notEqual(fs.readFileSync(path.join(f.directory, 'amu', 'blobs', name)).indexOf(original), 0);
 assert.ok(fs.readdirSync(copied).length > 0); const rows = f.p.app.database.prepare('SELECT payload FROM trade_annotations').all();
 assert.ok(rows.every(row => !row.payload.includes(image.assetId) && !row.payload.includes('employee:42')));
 const restored = path.join(f.directory, 'restored'); restoreEncryptedFilesBackup({ backupDirectory: copied, targetDirectory: restored });
 f.restoreStorage(restored); assert.deepEqual((await f.images.content(context, image.assetId)).buffer, original);
});

test('owner-bound upload receipts recover an acknowledged image without a duplicate scan or quota allocation', async t => {
 const f=await fixture(t),owner=await f.context(),other=await f.context('43'),bytes=await png(),uploadId=require('node:crypto').randomUUID();
 const first=await f.images.create(owner,bytes,{uploadId}),again=await f.images.create(owner,bytes,{uploadId});
 assert.deepEqual(again,first);assert.equal(f.state.scans,1);assert.deepEqual((await f.images.listOwned(owner)).map(row=>row.assetId),[first.assetId]);assert.deepEqual(await f.images.listOwned(other),[]);
 const changed=await sharp({create:{width:120,height:80,channels:4,background:'#990000'}}).png().toBuffer();await assert.rejects(f.images.create(owner,changed,{uploadId}),{status:409});assert.equal(f.state.scans,1);
 const otherImage=await f.images.create(other,bytes,{uploadId});assert.notEqual(otherImage.assetId,first.assetId);assert.equal(f.state.scans,2);assert.deepEqual((await f.images.listOwned(owner)).map(row=>row.assetId),[first.assetId]);
 await assert.rejects(f.images.listOwned(owner,{assertFresh:async()=>{throw Object.assign(Error('revoked'),{status:403});}}),{status:403});
});

test('nested project/draft saves recheck a foreign image share inside the same database snapshot before persistence', async t => {
 const f=await fixture(t),owner=await f.context(),branch=await f.context('acc19'),asset=await f.images.create(owner,await png()),crypto=require('node:crypto'),Ui=require('../public/sales-price-labels');
 let shared=await f.templates.create(owner,input(asset.assetId,{visibility:'selected',recipients:['acc19']})),revoke=false;
 const validateImages=async(ctx,value,opts)=>{const proof=await f.images.validateOptions(ctx,value,opts);if(revoke){revoke=false;shared=await f.templates.update(owner,shared.id,{...input(asset.assetId),version:shared.version});}return proof;};
 const stores={access:f.p.app.provider,vault:f.p.vault,validateImages},projects=require('../lib/sales-price-label-project-store').createSalesPriceLabelProjectStore(stores),drafts=require('../lib/sales-price-label-draft-store').createSalesPriceLabelDraftStore(stores);
 const options=Ui.normalizeOptions({imageBoxes:[box(asset.assetId)]}),label={id:crypto.randomUUID(),articleNumber:'107506',priceType:'sales',options};
 const project={schemaVersion:1,name:'Shared image copy',labels:[label],selectedLabelId:label.id,paper:{paper:'A4',paperWidthMm:210,paperHeightMm:297,orientation:'portrait',marginMm:10,gapMm:3},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}};
 const saved=await projects.create(branch,{project});assert.equal(saved.version,1);
 revoke=true;await assert.rejects(projects.update(branch,saved.id,{version:1,project}),{status:403});assert.equal((await projects.get(branch,saved.id)).version,1);
 shared=await f.templates.update(owner,shared.id,{...input(asset.assetId,{visibility:'selected',recipients:['acc19']}),version:shared.version});
 const draft={schemaVersion:1,draftId:crypto.randomUUID(),articleNumbers:'107506',priceType:'sales',options:Ui.normalizeOptions({}),rawSettings:{},filenameOptions:project.filenameOptions,name:'Draft',library:{mode:'new',templateId:'',templateVersion:null,title:'',visibility:'private',recipients:[]},selectedArticleNumber:'107506',paperPage:0,project:{id:'',version:null,data:project}};
 revoke=true;await assert.rejects(drafts.save(branch,{revision:0,mutationId:crypto.randomUUID(),draft}),{status:403});assert.equal((await drafts.get(branch)).revision,0);
});

test('authenticated opaque markers retain only committed images through orphan collection and require complete offline backup files', async t => {
 const f = await fixture(t), context = await f.context(), image = await f.images.create(context, await png());
 const { protectedStorageReferencesFromDatabase } = require('../lib/persistence/sqlite/operations/maintenance');
 const { verifyBackupReferences, verifyProtectedFileReferences } = require('../lib/amu-storage');
 const { verifyPriceLabelImageRows } = require('../lib/sales-price-label-image-references');
 const orphan = await f.storage().saveBuffer({ buffer: await png(), originalName: 'uncommitted.png' });
 const committed = await f.images.verifyStoredImages();
 const references = new Set(protectedStorageReferencesFromDatabase(f.p.app.database));
 assert.deepEqual([...references], committed);
 for (const key of f.storage().listStorageKeys()) if (!references.has(key)) f.storage().deleteBlob(key);
 assert.ok(!f.storage().listStorageKeys().includes(orphan.storageKey));
 assert.ok((await f.images.content(context, image.assetId)).buffer.length);
 const rows = f.p.app.database.prepare("SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations WHERE kind IN ('price-label-image','price-label-image-storage-v1')").all();
 const keyPayload = f.p.app.database.prepare("SELECT payload FROM data_import_runtime_keys WHERE id='data-import-v1'").get().payload;
 const files = await verifyPriceLabelImageRows({ rows, keyPayload, vault: f.p.vault });
 const copied = path.join(f.directory, 'strict-backup');
 syncEncryptedFilesBackup({ sourceDirectory: path.join(f.directory, 'amu'), targetDirectory: copied });
 const before = fs.readdirSync(copied, { recursive: true }).sort();
 const options = { sourceDirectory: copied, activeKeyId: 'synthetic', encryptionKeys: { synthetic: Buffer.alloc(32, 25) }, requiredFiles: files };
 assert.deepEqual(verifyProtectedFileReferences(options), { verified: true, fileCount: 1 });
 assert.deepEqual(fs.readdirSync(copied, { recursive: true }).sort(), before, 'offline verification never creates scratch/keycheck/temp files');
 assert.throws(() => verifyProtectedFileReferences({ ...options, requiredFiles: [{ ...files[0], sha256: '0'.repeat(64) }] }), { code: 'AMU_DOCUMENT_INTEGRITY_FAILED' });
 fs.unlinkSync(path.join(copied, 'blobs', files[0].storageKey));
 assert.throws(() => verifyProtectedFileReferences(options));
 assert.throws(() => verifyBackupReferences({ backupDirectory: copied, requiredStorageKeys: [...references] }));
});

test('offline image verification rejects missing, duplicate, swapped and forged markers or missing archive keys', async t => {
 const f = await fixture(t), context = await f.context();
 await f.images.create(context, await png()); await f.images.create(context, await png());
 const { verifyPriceLabelImageRows } = require('../lib/sales-price-label-image-references');
 const rows = f.p.app.database.prepare("SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations WHERE kind IN ('price-label-image','price-label-image-storage-v1')").all();
 const keyPayload = f.p.app.database.prepare("SELECT payload FROM data_import_runtime_keys WHERE id='data-import-v1'").get().payload;
 const verify = overrides => verifyPriceLabelImageRows({ rows, keyPayload, vault: f.p.vault, ...overrides });
 assert.equal((await verify({})).length, 2);
 const altered = rows.map(row => ({ ...row })); [altered[0].payload, altered[1].payload] = [altered[1].payload, altered[0].payload];
 for (const overrides of [{ keyPayload: null }, { rows: rows.filter(row => row.kind !== 'price-label-image-storage-v1') },
  { rows: [...rows, rows[0]] }, { rows: altered }, { rows: rows.map((row, i) => i ? row : { ...row, scopeId: '00/00000000-0000-4000-8000-000000000001.amu' }) }])
  await assert.rejects(verify(overrides), { code: 'PRICE_LABEL_IMAGE_INTEGRITY' });
 assert.deepEqual(await verifyPriceLabelImageRows({ rows: [] }), []);
 f.p.app.database.prepare("DELETE FROM trade_annotations WHERE kind='price-label-image-storage-v1'").run();
 await assert.rejects(f.images.verifyStoredImages(), { code: 'PRICE_LABEL_IMAGE_INTEGRITY' });
});

test('standalone backup verifies the exact snapshot image AAD before publishing complete and preserves prior good pairs', async t => {
 const f = await fixture(t); await f.images.create(await f.context(), await png());
 const databasePath = path.join(f.directory, 'snapshot.db'), backupDirectory = path.join(f.directory, 'snapshots');
 f.p.app.database.exec("VACUUM INTO '" + databasePath.replaceAll("'", "''") + "'");
 const environment = { ...process.env, DB_PATH: databasePath, GRABENPLANER_AMU_DIR: path.join(f.directory, 'amu'), GRABENPLANER_LOCAL_BACKUP_ARCHIVE: '0',
  GRABENPLANER_AMU_KEY_ID: 'synthetic', GRABENPLANER_AMU_KEY: Buffer.alloc(32, 25).toString('base64'), GRABENPLANER_AMU_KEYS: '',
  GRABENPLANER_INTEGRATION_KEY_ID: 'synthetic', GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 42).toString('base64'), GRABENPLANER_INTEGRATION_KEYS: '' };
 const run = () => require('node:child_process').spawnSync(process.execPath, ['-e',
  "const db=require('./lib/persistence/sqlite/provider').openSqliteLegacyDatabase(process.env.DB_PATH);try{require('./backup').createPairedBackup(db,process.argv[1],Date.now().toString(),'synthetic')}catch(e){process.stderr.write(String(e.code||'failure'));process.exitCode=1}finally{db.close()}", backupDirectory],
  { cwd: path.join(__dirname, '..'), env: environment, encoding: 'utf8', windowsHide: true });
 assert.equal(run().status, 0);
 const good = fs.readdirSync(backupDirectory).filter(name => name.endsWith('.complete.json')); assert.equal(good.length, 1);
 const database = require('../lib/persistence/sqlite/provider').openSqliteLegacyDatabase(databasePath);
 try {
  const row = database.prepare("SELECT id,payload FROM trade_annotations WHERE kind='price-label-image-storage-v1'").get();
  database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run(row.payload.slice(0, -6) + 'AAAAAA', row.id);
 } finally { database.close(); }
 assert.equal(run().status, 1);
 assert.deepEqual(fs.readdirSync(backupDirectory).filter(name => name.endsWith('.complete.json')), good, 'corruption never publishes a complete marker');
});

test('standalone desktop image backup reads existing private local keys without ENV secrets and never regenerates missing keys', async t => {
 const f = await fixture(t, { storageKeyId: 'local-v1' }); await f.images.create(await f.context(), await png());
 const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
 const localVault = createIntegrationSecretVault({ activeKeyId: 'local-v1', keys: { 'local-v1': Buffer.alloc(32, 42) } });
 const aad = { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' };
 const old = f.p.app.database.prepare("SELECT payload FROM data_import_runtime_keys WHERE id='data-import-v1'").get(); let payload;
 await f.p.vault.useSecret(old.payload, aad, bytes => { payload = localVault.seal(bytes, aad); });
 f.p.app.database.prepare("UPDATE data_import_runtime_keys SET payload=? WHERE id='data-import-v1'").run(payload);
 const databasePath = path.join(f.directory, 'desktop.db'), backupDirectory = path.join(f.directory, 'desktop-backups');
 f.p.app.database.exec("VACUUM INTO '" + databasePath.replaceAll("'", "''") + "'");
 for (const [name, fill] of [['amu-local.key', 25], ['integration-local.key', 42]]) fs.writeFileSync(path.join(f.directory, name), Buffer.alloc(32, fill).toString('base64') + '\n', { mode: 0o600 });
 const environment = { ...process.env, DB_PATH: databasePath, GRABENPLANER_AMU_DIR: path.join(f.directory, 'amu'), GRABENPLANER_LOCAL_BACKUP_ARCHIVE: '0', GRABENPLANER_OPERATION_MODE: 'local' };
 for (const key of Object.keys(environment)) if (/^GRABENPLANER_(?:AMU|INTEGRATION)_KEY/.test(key)) delete environment[key];
 const run = () => require('node:child_process').spawnSync(process.execPath, ['-e',
  "const db=require('./lib/persistence/sqlite/provider').openSqliteLegacyDatabase(process.env.DB_PATH);try{require('./backup').createPairedBackup(db,process.argv[1],Date.now().toString(),'synthetic')}catch(e){process.stderr.write(String(e.code||'failure'));process.exitCode=1}finally{db.close()}", backupDirectory],
  { cwd: path.join(__dirname, '..'), env: environment, encoding: 'utf8', windowsHide: true });
 const keyFile = path.join(f.directory, 'integration-local.key'), before = fs.readFileSync(keyFile);
 assert.equal(run().status, 0); assert.deepEqual(fs.readFileSync(keyFile), before);
 const good = fs.readdirSync(backupDirectory).filter(name => name.endsWith('.complete.json')); assert.equal(good.length, 1);
 fs.unlinkSync(keyFile); assert.equal(run().status, 1); assert.equal(fs.existsSync(keyFile), false);
 assert.deepEqual(fs.readdirSync(backupDirectory).filter(name => name.endsWith('.complete.json')), good);
});
test('private and branch images follow current template sharing; replacement preserves other references and scope revocation blocks reads', async t => {
 const f = await fixture(t), owner = await f.context(), other = await f.context('43'), branch = await f.context('acc19');
 const image = await f.images.create(owner, await png());
 await assert.rejects(f.images.content(other, image.assetId), { status: 404 }); await assert.rejects(f.images.content({ owner: owner.owner }, image.assetId), { status: 403 });
 const saved = await f.templates.create(owner, input(image.assetId, { visibility: 'selected', recipients: ['acc19'] }));
 assert.ok((await f.images.content(branch, image.assetId)).buffer.length);
 const copy = await f.templates.create(owner, input(image.assetId, { title: 'Second reference' }));
 await f.templates.update(owner, copy.id, { ...input(image.assetId), version: copy.version, options: {} });
 assert.ok((await f.images.content(branch, image.assetId)).buffer.length, 'other template reference survives removal');
 await f.templates.update(owner, saved.id, { ...input(image.assetId), version: saved.version, visibility: 'private', recipients: [] });
 await assert.rejects(f.images.content(branch, image.assetId), { status: 404 });
 await assert.rejects(f.templates.create(other, input(image.assetId)), { status: 404 });
 assert.equal((await f.images.resolve(owner, { imageBoxes: [box(image.assetId)] })).size, 1);
 await assert.rejects(f.images.resolve(owner, { imageBoxes: Array(4).fill(box(image.assetId)) }), { status: 400 });
});
test('corrupt encrypted blobs, rejected scans and late rights changes fail closed without usable new image references', async t => {
 const f = await fixture(t), owner = await f.context(); f.state.clean = false;
 await assert.rejects(f.images.create(owner, await png())); f.state.clean = true;
 const image = await f.images.create(owner, await png());
 let calls = 0; await assert.rejects(f.images.content(owner, image.assetId, { assertFresh() { if (++calls === 2) throw Object.assign(new Error('revoked'), { status: 403 }); } }), { status: 403 });
 const blobRoot = path.join(f.directory, 'amu', 'blobs'), name = fs.readdirSync(blobRoot, { recursive: true }).find(file => file.endsWith('.amu'));
 const file = path.join(blobRoot, name), bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
 await assert.rejects(f.images.content(owner, image.assetId), { code: 'PRICE_LABEL_IMAGE_INTEGRITY', status: 503 });
});
test('owner quota rejects before scanning or allocating another encrypted blob', async t => {
 const f = await fixture(t), context = await f.context(), { annotations } = require('../lib/persistence/repositories/trade-annotations');
 const store = annotations({ protection: f.p.protection, scopeId: 'grabenplaner-main:price-label-images' });
 await f.p.app.provider.transaction(tx => store.write(tx, 'price-label-image-owner', context.owner.id,
  { schemaVersion: 1, images: Array.from({ length: I.MAX_OWNER_IMAGES }, () => ({ assetId: require('node:crypto').randomUUID(), bytes: 100 })) }, 0, context.owner.id));
 await assert.rejects(f.images.create(context, await png()), { code: 'PRICE_LABEL_IMAGE_QUOTA', status: 413 });
 assert.equal(f.state.scans, 0); assert.deepEqual(f.storage().listStorageKeys(), []);
});
test('fresh session queries use the application provider outside the owned image transaction and late denial suppresses the response', async t => {
 const f = await fixture(t), context = await f.context(), { DATA_IMPORT_RUNTIME_STATEMENTS: S } = require('../lib/persistence/statements/data-import-runtime');
 let queries = 0;
 const assertFresh = async () => { await f.p.app.provider.queryOne(S.key, { id: 'data-import-v1' }); queries++; };
 const image = await f.images.create(context, await png(), { assertFresh });
 assert.ok(queries >= 4); assert.ok((await f.images.content(context, image.assetId, { assertFresh })).buffer.length);
 let calls = 0;
 await assert.rejects(f.images.create(context, await png(), { assertFresh: async () => {
  await assertFresh(); if (++calls === 4) throw Object.assign(new Error('revoked after commit'), { status: 403 });
 } }), { status: 403 });
});
test('share revocation during file decryption discards bytes and revocation before a template commit cannot grant a copied reference', async t => {
 const f = await fixture(t), owner = await f.context(), recipient = await f.context('acc19'), image = await f.images.create(owner, await png());
 const shared = await f.templates.create(owner, input(image.assetId, { visibility: 'selected', recipients: ['acc19'] }));
 const rawRead = f.storage().readBuffer;
 f.storage().readBuffer = async metadata => {
  const result = rawRead(metadata); await f.templates.update(owner, shared.id, { ...input(image.assetId), version: shared.version }); return result;
 };
 await assert.rejects(f.images.content(recipient, image.assetId), { status: 404 }); f.storage().readBuffer = rawRead;
 const again = await f.templates.update(owner, shared.id, { ...input(image.assetId, { visibility: 'selected', recipients: ['acc19'] }), version: 2 });
 const copying = T.createSalesPriceLabelTemplateStore({ access: f.p.app.provider, vault: f.p.vault,
  validateImages: async (...args) => {
   const proof = await f.images.validateOptions(...args);
   await f.templates.update(owner, shared.id, { ...input(image.assetId), version: again.version }); return proof;
  } });
 await assert.rejects(copying.create(recipient, input(image.assetId)), { status: 403 });
 assert.equal((await f.templates.list(recipient)).templates.length, 0);
});
async function httpFixture(t) {
 const f = await fixture(t), app = express(); app.use(express.json({ limit: '1mb' }));
 registerSalesPriceLabelsRoutes(app, { ...f.deps, catalog: { getByArticleNumber: async number => ({ articleNumber: number, prices: [{ priceType: 'sales', amount: '10.00', priceBasis: 'gross', currency: 'EUR', qualityStatus: 'confirmed' }] }) },
  loadDetail: async () => ({ article: { description: 'Synthetic', sourceSections: [], identifiers: [], priceMatrix: { vatPercent: 20, sales: [{ id: 'sales', gross: { amount: '10.00' } }] } } }), templateStore: f.templates, imageStore: f.images, draftVault: f.p.vault,
  sessionFor: req => structuredClone(f.state.sessions[req.get('X-Actor') || '42']), assertFresh: async () => f.state.freshHook?.(), refreshSession: async req => f.state.sessions[req.get('X-Actor') || '42'],
  assertCsrf: req => { if (req.get('X-CSRF-Token') !== 'test') throw Object.assign(new Error('csrf'), { status: 403 }); },
  privateHeaders: res => res.set('Cache-Control', 'private, no-store'),
  withImageWrite: async work => { f.state.gates++; f.state.gateActive = true; try { return await work(); } finally { f.state.gateActive = false; } },
  preferences: { get: async (owner, key) => ({ value: f.state[owner + key] }), upsert: async (owner, key, value) => { f.state[owner + key] = value; } },
 });
 app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'UNEXPECTED' }));
 const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
 return { ...f, request: (suffix, { body, actor = '42', csrf = 'test', type, method } = {}) => fetch('http://127.0.0.1:' + server.address().port + '/api/sales/price-labels/' + suffix,
  { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'X-Actor': actor, 'X-CSRF-Token': csrf, ...(type ? { 'Content-Type': type } : {}) }, ...(body === undefined ? {} : { body }) }) };
}
test('image API applies CSRF, owner checks, binary private headers and write gate while keeping global JSON at 1MiB', async t => {
 const f = await httpFixture(t), form = new FormData(); form.append('image', new Blob([await png()], { type: 'image/png' }), 'Image.png');
 assert.equal((await f.request('images', { body: form, csrf: 'bad' })).status, 403); assert.equal(f.state.gates, 0);
 const response = await f.request('images', { body: form }); assert.equal(response.status, 200, await response.clone().text());
 const image = (await response.json()).image; assert.equal(f.state.gates, 1); assert.equal(f.state.gateActive, false);
 const read = await f.request('images/' + image.assetId); assert.equal(read.status, 200); assert.match(read.headers.get('content-type'), /image\/png/); assert.equal(read.headers.get('cache-control'), 'private, no-store');
 const preview = require('node:crypto').randomUUID() + '-1';
 const nonceRead = await f.request('images/' + image.assetId + '?preview=' + preview); assert.equal(nonceRead.status, 200); assert.equal(nonceRead.headers.get('cache-control'), 'private, no-store');
 assert.equal((await f.request('images/' + image.assetId + '?preview=' + preview, { actor: '43' })).status, 404);
 assert.equal((await f.request('images/' + image.assetId + '?preview=m123fallbacknonce-2')).status, 200);
 for (const query of ['preview=', 'preview=' + 'x'.repeat(81), 'preview=a&preview=b', 'preview=../../private'])
  assert.equal((await f.request('images/' + image.assetId + '?' + query)).status, 400, query);
 for (const query of ['owner=42', 'preview=valid-1&owner=42']) assert.equal((await f.request('images/' + image.assetId + '?' + query)).status, 422, query);
 assert.equal((await f.request('images/' + image.assetId, { actor: '43' })).status, 404);
 assert.equal((await f.request('images', { body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }), type: 'application/json' })).status, 413);
 const body = JSON.stringify({ options: { imageBoxes: [box(image.assetId)] }, filenameOptions: {} });
 assert.equal((await f.request('templates', { body, type: 'application/json' })).status, 200);
 assert.match(f.state['42sales_price_labels_v1'], /^gp-integration-secret:v1:/); assert.equal(f.state['42sales_price_labels_v1'].includes(image.assetId), false);
 assert.equal((await (await f.request('templates')).json()).options.imageBoxes[0].assetId, image.assetId);
 const exported = await f.request('export.pdf', { type: 'application/json', body: JSON.stringify({ articleNumbers: ['001234'], options: { imageBoxes: [box(image.assetId)] }, name: 'Synthetic', stamp: 'none' }) });
 assert.equal(exported.status, 200, await exported.clone().text()); assert.match(Buffer.from(await exported.arrayBuffer()).toString('latin1'), /\/Subtype\s*\/Image/);
 f.state['43sales_price_labels_v1'] = f.state['42sales_price_labels_v1']; assert.equal((await f.request('templates', { actor: '43' })).status, 503);
});
test('current actor role and branch-account reassignment revoke image responses even during file access', async t => {
 const f = await httpFixture(t), owner = await f.context(), image = await f.images.create(owner, await png());
 await f.templates.create(owner, input(image.assetId, { visibility: 'selected', recipients: ['acc19'] }));
 assert.equal((await f.request('images/' + image.assetId, { actor: 'acc19' })).status, 200);
 f.state.accounts.find(row => row.id === 'acc19').scopes = [{ locationId: '18', departmentId: null }];
 assert.equal((await f.request('images/' + image.assetId, { actor: 'acc19' })).status, 403);
 let calls = 0; f.state.freshHook = () => { if (++calls === 5) f.state.sessions['42'].role = 'changed'; };
 assert.equal((await f.request('images/' + image.assetId)).status, 403);
});
