'use strict';
// Explicit synthetic qualification helpers, never a production import entrypoint.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const C = require('../lib/data-import-contract');
const S = require('../lib/tradefoto-full-import-source');
const E = require('../lib/tradefoto-supplement-profiles');
const { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const FORMAT = 'gp-six-access-recovery-fixture-v1', AT = '2026-11-16T12:00:00.000Z', CIVIL = '2026-11-16T12:00:00';
const ARTICLE = '0000000000042', SECOND_ARTICLE = '0000000000043';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function ownedDirectory(directory) {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) fail('GP_ACCESS_FIXTURE_DIRECTORY');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail('GP_ACCESS_FIXTURE_DIRECTORY');
}
function writePrivate(file, value) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fixtureRows(generation = 'original') {
  const article = (EAN, suffix) => ({ EAN, Artikelbezeichnung: 'Synthetic Access article ' + suffix, Suchname: 'SYNTHETIC', MWST: 1, Sortiment: 130,
    'Änderungsdatum': CIVIL, Anlagedatum: CIVIL, Verkaufspreis: 12.3456, eNvk: 10.288, UPE: 15.4321, Rechnungspreis: 5.2345, NNPreis: 4.1234,
    AKurzbeschreibung: 'Synthetic memo ÄÖÜ ' + suffix, ShopText: 'Synthetic protected source memo ' + suffix });
  const key = { Bonnr: 1, Filialid: 18, Kassenid: 1, Bondatum: CIVIL };
  const values = {
    trade: {
      FILIALEN: [{ FilialID: 18, FName: 'Synthetic branch 18', Bemerkung: 'Synthetic source branch memo' }],
      MITARBEITER: [{ 'Verkäufer_ID': 1, NACHNAME: 'Synthetic seller', VORNAME: 'Fixture', FilialNr: 18, INFO: 'Synthetic legacy personnel memo' }],
      LIEFERANTEN: [{ Suchname: 'SYNTHETIC', Firma: 'Synthetic supplier', Lieferant_ID: 1, INFO: 'Synthetic supplier memo' }],
      ARTIKEL_STAMM: [article(ARTICLE, '42'), article(SECOND_ARTICLE, '43')],
      ARTIKEL_ZWEITEAN: [{ EAN: ARTICLE, ZweitEAN: '4006381333931', Rang: 1 }, { EAN: SECOND_ARTICLE, ZweitEAN: '9780201379624', Rang: 1 }],
      ARTIKEL_FILIALEN: [{ EAN: ARTICLE, FilialID: 18, FBestand: 2.5, Fvkj: 1, Bestellt: 1, Bestandsänderungsdatum: CIVIL },
        { EAN: SECOND_ARTICLE, FilialID: 18, FBestand: 3, Fvkj: 2, Bestandsänderungsdatum: CIVIL }],
    },
    cash: {
      KassenJournal: [{ Vorgang: 1001, Filiale: 18, Datum: CIVIL }],
      Umsatz_KASSE: [{ ...key, Bonzeit: CIVIL, 'VerkäuferID': 1, RechnungsBetrag: 12.3456, RechnungsNr: 'synthetic-1' }],
      EigeneKonten: [{ Ekontobeschreibung: 'Synthetic own account', EkontoNr: 1000 }],
      ExportRichtTabelle: [{ Richtid: 1, Idd: 1, Id: 1, FilialId: 18, KassenId: 1, Position: 1, EAN: ARTICLE, Artikelbezeichnung: 'Synthetic export article', VK: '12.3456' }],
      KassenJournal_Details: [{ Vorgang: 1001, Filiale: 18, Beleg: 1, Datum: CIVIL, Konto: 1000, EinAuszahlung: 'E', Bezeichnung: 'Synthetic journal', Beschreibung: 'Unicode ÄÖÜ synthetic', Einzahlung: 12.3456, Auszahlung: 0, MwSt_Satz: 20 }],
      Tagesbericht: [{ ZBon: 1, KoBeschreibung: 'Synthetic nullable date', Bondatum: null, Filialid: 18, Kassenid: 1, Rechnungsnr: 1, KontoNr: 1000, Einnahmen: '12.3456', Ausgaben: '0.0000', Rang: 1 }],
      Umsatz_Kasse_Details: [{ ...key, RepID: '00000000-0000-0000-0000-000000000001', EAN: ARTICLE, VKMenge: 1, Sollpreis: '12.3456', VK_Preis: '12.3456', MWST: 20,
        RohertragDM: 1.2345, 'Verkäuferid': 1, Sortiment: 130, Artikelbezeichnung: 'Synthetic article', UMarke: 'Synthetic' }],
    },
    bestell: { BESTELLUNGEN: [{ BestellNr: 101, Bestelldatum: CIVIL, Suchname: 'SYNTHETIC', BFirma: 'Synthetic supplier', LFilialID: 18, Text1: 'Synthetic order memo' }] },
    weum: {
      WE: [{ We_ID: 201, We: true, Umlagerung: false, EAN: ARTICLE, Suchname: 'SYNTHETIC', FilialID: 18, Menge: 2.5, WEDatum: CIVIL, AkWeDatum: CIVIL, NNPreis: 4.1234, Rechnungspreis: 5.2345 }],
      'ARTIKEL_STAMMGelöscht': [{ EAN: ARTICLE, Artikelbezeichnung: 'Synthetic former label', Suchname: 'SYNTHETIC', Sortiment: 130, MWST: 20, Anlagedatum: CIVIL, 'Löschdatum': CIVIL }],
    },
    inventur: {
      Inventur: [{ InventurNummer: 301, InventurFilialid: 18, InventurDatum: CIVIL, gebucht: true }],
      Inventurdetails: [{ ID: 302, Inventurnummer: 301, InventurFilialid: 18, EAN: ARTICLE, AlteMenge: 2, Differenz: 0.5, NeueMenge: 2.5, NNPreis: '4.1234' }],
    },
    lieferantenrechnungen: {
      Rechnung_A: [{ ID: 401, Rechnungsnr: 'SYNTHETIC-401', Suchname: 'SYNTHETIC', BFirma: 'Synthetic supplier', Anlegedatum: CIVIL, Buchdatum: CIVIL }],
      Rechnungsdetails_A: [{ ID: 402, we_id: 201, Rechnungsnr: 'SYNTHETIC-401', Suchname: 'SYNTHETIC', EAN: ARTICLE, Artikelbezeichnung: 'Synthetic invoice article', menge: 2.5,
        Rechnungspreis: 5.2345, NNPreis: 4.1234, WELieferscheinnr: 'SYNTHETIC-DELIVERY', Filialid: 18 }],
    },
  };
  if (generation === 'fresh') {
    values.trade.FILIALEN[0].FName = 'Fresh source branch 18';
    for (const [index, article] of values.trade.ARTIKEL_STAMM.entries()) {
      article.Artikelbezeichnung = 'Fresh Access article ' + (index ? '43' : '42');
      article.Verkaufspreis = index ? 24 : 36; article.eNvk = index ? 20 : 30;
    }
    values.trade.ARTIKEL_FILIALEN[0].FBestand = 9.5; values.trade.ARTIKEL_FILIALEN[1].FBestand = 17;
    values.cash.Umsatz_KASSE[0].RechnungsBetrag = 27.5;
    values.cash.Umsatz_Kasse_Details[0].Sollpreis = '27.5000'; values.cash.Umsatz_Kasse_Details[0].VK_Preis = '27.5000';
    values.cash.KassenJournal_Details[0].Einzahlung = 27.5; values.cash.Tagesbericht[0].Einnahmen = '27.5000'; values.cash.ExportRichtTabelle[0].VK = '27.5000';
    values.bestell.BESTELLUNGEN[0].Text1 = 'Fresh generation order memo'; values.weum.WE[0].Menge = 5.5;
    values.inventur.Inventurdetails[0].NeueMenge = 6.5; values.inventur.Inventurdetails[0].Differenz = 4.5;
    values.lieferantenrechnungen.Rechnungsdetails_A[0].menge = 7.5;
  } else if (generation !== 'original') fail('GP_ACCESS_FIXTURE_GENERATION');
  return values;
}
function definitionsForFiles() { return SOURCE_KINDS.map(kind => ({ kind, tables: E.physical[kind]?.tables || S.definitions(kind) })); }
async function generateAccessRecoveryFixture({ directory, assetsRoot, javac, generation = 'original' }) {
  ownedDirectory(directory); if (fs.readdirSync(directory).length) fail('GP_ACCESS_FIXTURE_NEW_DIRECTORY');
  if (!assetsRoot || !path.isAbsolute(assetsRoot) || !javac || !path.isAbsolute(javac) || !fs.statSync(javac).isFile()) fail('GP_ACCESS_FIXTURE_TOOLS');
  const assets = require('../lib/import-verifier-runtime-assets').inspectRuntimeAssets(assetsRoot);
  if (assets.descriptorSha256 !== require('../lib/data-import-af-verifier-policy').runtime.descriptorSha256) fail('GP_ACCESS_FIXTURE_RUNTIME_PIN');
  const prefix = path.join(assetsRoot, assets.installPrefix), descriptor = JSON.parse(fs.readFileSync(path.join(prefix, 'descriptor.json')));
  const java = path.join(prefix, 'jre/bin/java' + (process.platform === 'win32' ? '.exe' : '')), classpath = descriptor.jars.map(jar => path.join(prefix, jar.path)).join(path.delimiter);
  const classes = path.join(directory, 'classes'); fs.mkdirSync(classes, { mode: 0o700 }); let tool = 0;
  function command(binary, args) {
    const log = path.join(directory, 'tool-' + (++tool)), out = fs.openSync(log + '.out', 'wx', 0o600), err = fs.openSync(log + '.err', 'wx', 0o600); let result;
    try { result = spawnSync(binary, args, { timeout: 120000, env: { PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', out, err] }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    if (result.error || result.status !== 0) throw Object.assign(new Error('GP_ACCESS_FIXTURE_TOOL_FAILED'), { code: 'GP_ACCESS_FIXTURE_TOOL_FAILED', toolLog: log });
    return fs.readFileSync(log + '.out', 'utf8');
  }
  command(javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', classpath, '-d', classes, path.resolve(__dirname, 'AccessRecoveryFixture.java')]);
  const data = fixtureRows(generation), files = [];
  for (const { kind, tables } of definitionsForFiles()) {
    const spec = path.join(directory, 'fixture-' + kind + '.json'), file = path.join(directory, 'synthetic-' + kind + '.accdb');
    for (const name of Object.keys(data[kind])) if (!tables.some(t => t.name === name)) fail('GP_ACCESS_FIXTURE_TABLE');
    const tableSpecs = tables.map(table => {
      for (const row of data[kind][table.name] || []) if (Object.keys(row).some(key => !table.columns.some(c => c.name === key))) fail('GP_ACCESS_FIXTURE_COLUMN');
      return { name: table.name, columns: table.columns.map(({ name, type }) => ({ name, type })), rows: data[kind][table.name] || [] };
    });
    writePrivate(spec, JSON.stringify({ tables: tableSpecs }));
    const written = JSON.parse(command(java, ['-cp', classes + path.delimiter + classpath, 'AccessRecoveryFixture', spec, file])); fs.chmodSync(file, 0o600);
    const buffer = fs.readFileSync(file), fileSha256 = sha(buffer), catalogRows = { ARTIKEL_STAMM: [], ARTIKEL_ZWEITEAN: [] }; let manifest, complete;
    try { await S.readTradeFotoFullSource({ buffer, kind, send: async event => {
      if (event.type === 'manifest') manifest = event; if (event.type === 'complete') complete = event;
      if (kind === 'trade' && event.type === 'rows' && Object.hasOwn(catalogRows, event.name)) catalogRows[event.name].push(...event.rows);
    } }); }
    finally { buffer.fill(0); }
    if (!manifest || !complete || written.syntheticAccessFile !== true || written.encryptedAccessFile !== false || written.tables !== tables.length
      || written.rows !== tableSpecs.reduce((n, t) => n + t.rows.length, 0) || complete.rows < 1 || manifest.fileSha256 !== fileSha256) fail('GP_ACCESS_FIXTURE_PARSER');
    if (kind === 'trade') {
      // Qualify the synthetic tax code, gross/net pairs and alias quality with
      // the ordinary catalog adapter too; parsing alone proves no Apply gate.
      const sync = require('../lib/data-import-article-sync').createDataImportArticleSync();
      try {
        const prepared = await sync.prepareSource({ id: fileSha256, fileSha256, fileName: path.basename(file), createdAt: AT,
          tables: manifest.tables.map(table => ({ ...table, run: { id: table.name } })) },
        async name => ({ rows: catalogRows[name], after: catalogRows[name].length, complete: true }), async () => {});
        if (prepared.normalizedArticles.length !== 2 || prepared.rows.some(row => row.action !== 'ready')) throw Object.assign(new Error('GP_ACCESS_FIXTURE_CATALOG_SOURCE'), {
          code: 'GP_ACCESS_FIXTURE_CATALOG_SOURCE', syntheticDiagnostic: prepared.rows.map(({ articleNumber, action, issueCodes }) => ({ articleNumber, action, issueCodes })),
        });
      } finally { sync.clear(); }
    }
    files.push({ kind, file, fileSha256, bytes: fs.statSync(file).size, physicalTables: written.tables, physicalRows: written.rows,
      tables: complete.tables, rows: complete.rows });
  }
  const result = { format: FORMAT, directory, generation, syntheticOnly: true, actualAccessParser: true, injectedReader: false, encryptedAccess: false,
    runtimeDescriptorSha256: assets.descriptorSha256, files };
  writePrivate(path.join(directory, 'fixture-receipt.json'), JSON.stringify(result) + '\n'); return result;
}

function checkFixture(fixture) {
  if (fixture?.format !== FORMAT || fixture.syntheticOnly !== true || fixture.actualAccessParser !== true || fixture.injectedReader !== false
    || !Array.isArray(fixture.files) || fixture.files.length !== SOURCE_KINDS.length) fail('GP_ACCESS_FIXTURE_PROOF');
  ownedDirectory(fixture.directory);
  fixture.files.forEach((source, i) => {
    if (source.kind !== SOURCE_KINDS[i] || path.dirname(source.file) !== fixture.directory || path.basename(source.file) !== 'synthetic-' + source.kind + '.accdb') fail('GP_ACCESS_FIXTURE_SOURCE');
    const stat = fs.lstatSync(source.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== source.bytes || stat.size > S.MAX_BYTES || process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail('GP_ACCESS_FIXTURE_SOURCE');
  });
}
function syntheticSession() {
  return { employeeNumber: '00001', isEmployee: true, role: 'developer', permissions: [
    ...Object.values(require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS), ...Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS),
    'sales:analytics:access', 'sales:analytics:company:read',
  ] };
}
async function seedAccessRecoveryFixture({ access, vault, archive, fixture, isolatedRecovery = false, getSession = async () => syntheticSession(), scopeId = 'grabenplaner-main', onProgress = () => {} }) {
  if (isolatedRecovery !== true || access?.getCapabilities?.().providerId !== 'postgresql') fail('GP_ACCESS_FIXTURE_ISOLATION');
  checkFixture(fixture);
  const { createDataImportRuntime } = require('../lib/persistence/repositories/data-import-runtime');
  const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
  const runtime = createDataImportRuntime({ access, vault, scopeId, allowApply: true, sharedPayloads: true, compactCash: true, syncArticleCatalog: true,
    clock: () => AT, readSource: options => S.readTradeFotoFullSource({ ...options, send: options.onMessage }) });
  const summaries = []; let protection,legacyCashHistory;
  try {
    for (const file of fixture.files) {
      onProgress({ kind: file.kind, phase: 'upload' });
      if(file.kind==='cash')legacyCashHistory=await require('./postgresql-legacy-cash-seed.cjs').seedLegacyCashHistory({access,vault,file:file.file,scopeId,ownerId:(await getSession()).employeeNumber,clock:()=>AT});
      const buffer = fs.readFileSync(file.file); if (sha(buffer) !== file.fileSha256) { buffer.fill(0); fail('GP_ACCESS_FIXTURE_SOURCE_CHANGED'); }
      let source;
      try {
        source = await runtime.reserve(getSession, { buffer, kind: file.kind, fileName: path.basename(file.file) });
        await archive.stage({ source, buffer });
        source = await runtime.upload(getSession, { buffer, kind: file.kind, fileName: path.basename(file.file) });
      } finally { buffer.fill(0); }
      let steps = 0;
      while (source.status === 'reviewing') {
        if (++steps > 1000) fail('GP_ACCESS_FIXTURE_REVIEW_LIMIT');
        source = await runtime.sourceOperation(getSession, source.id, 'review', { expectedRevision: source.revision });
      }
      if (!source.complete || !['ready', 'needs_review'].includes(source.status)) fail('GP_ACCESS_FIXTURE_REVIEW');
      if (file.kind === 'cash') {
        if (source.status !== 'ready') fail('GP_ACCESS_FIXTURE_CASH_NOT_READY');
        protection ||= await loadManagedDataImportProtection({ access, vault, clock: () => AT });
        const { createCashPublications } = require('../lib/persistence/repositories/cash-publications'), policies = require('../lib/cash-source-policies').CASH_SOURCE_POLICIES;
        const publications = createCashPublications({ access, protection, scopeId, policies, clock: () => AT }), session = await getSession(), actor = { scopeId, ownerId: session.employeeNumber };
        const projection = { tables: ['FILIALEN', 'MITARBEITER', 'ARTIKEL_STAMM', 'KUNDEN'].map(table => ({ table, write: true })) };
        const request = { sourceId: source.id, expectedRevision: 0, label: 'Synthetic all-six recovery cash', policyId: policies[0].id, resolveArticles: false,
          mappings: [{ kind: 'FILIALEN', sourceId: '18', targetId: '18', historical: false }, { kind: 'MITARBEITER', sourceId: '1', targetId: '00001', historical: false }] };
        const plan = await access.transaction(tx => publications.plan(tx, actor, request, projection, 'synthetic-six-access'), { isolation: 'serializable', readOnly: true });
        const publication = await access.transaction(tx => publications.activate(tx, actor, request, projection, 'synthetic-six-access', plan.planHash), { isolation: 'serializable' });
        await archive.promote({ source, publication: { ...publication, sourceId: source.id } });
      } else {
        while (source.status !== 'applied' || source.catalogUpdatePending) {
          if (++steps > 2000) fail('GP_ACCESS_FIXTURE_APPLY_LIMIT');
          onProgress({ kind: file.kind, phase: 'apply', step: steps, table: source.currentStep?.table || null });
          source = await runtime.sourceOperation(getSession, source.id, 'apply', { expectedRevision: source.revision });
        }
        // The job worker also requires catalog completion and a fresh durable
        // readback before acknowledging Apply. A master-data terminal status
        // alone must not race the separate article-catalog synchronization.
        source = await runtime.sourceOperation(getSession, source.id, 'read');
        if (source.status !== 'applied' || source.catalogUpdatePending) fail('GP_ACCESS_FIXTURE_CATALOG_PENDING');
        await archive.promote({ source });
      }
      summaries.push({ kind: file.kind, sourceId: source.id, fileSha256: source.fileSha256, status: source.status, rows: file.rows, tables: file.tables, revision: source.revision,
        catalogUpdatePending: source.catalogUpdatePending, ...(source.catalog ? { catalog: source.catalog } : {}) });
    }
    const proof = await archive.verify();
    if (proof.kinds.some(slot => !slot.current)) fail('GP_ACCESS_FIXTURE_SOURCE_COVERAGE');
    return { format: FORMAT, syntheticOnly: true, actualAccessParser: true, actualRuntimeApply: true, compactCash: true, sharedPayloads: true, syncArticleCatalog: true, sources: summaries, archiveProof: proof,legacyCashHistory };
  } finally { protection?.destroy(); await runtime.stop(); }
}

async function ownContentProof(access) {
  const catalog = require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(access);
  const images = require('../lib/persistence/repositories/sales-article-images').createSalesArticleImagesRepository(access);
  const article = await catalog.getByArticleNumber('000042'), image = await images.content('000042');
  if (!article || !image) fail('GP_ACCESS_FIXTURE_OWN_CONTENT_MISSING');
  try { return { articleSha256: sha(C.canonical(JSON.parse(JSON.stringify(article)))), ownImageSha256: sha(image.buffer), ownImageBytes: image.buffer.length,
    ownImageMetadata: { revision: image.revision, mime: image.mime, width: image.width, height: image.height, byteSize: image.byteSize, updatedAt: image.updatedAt } }; }
  finally { image.buffer.fill(0); }
}
async function seedOwnMasterAnchor({access,isolatedRecovery=false}){
  if(isolatedRecovery!==true||access?.getCapabilities?.().providerId!=='postgresql')fail('GP_ACCESS_FIXTURE_ISOLATION');
  const M=require('../lib/persistence/statements/import-master-data').IMPORT_MASTER_STATEMENTS;
  const records=await access.queryAll(M.listMappings,{scopeId:'grabenplaner-main',sourceInstance:'tradefoto-trade',sourceTable:'FILIALEN',after:'',status:'all',limit:2});
  if(records.length!==1)fail('GP_ACCESS_FIXTURE_MASTER_ANCHOR');
  await access.transaction(async tx=>{
    const result=await tx.execute(M.insertHold,{recordId:records[0].id,consumerId:'gp.synthetic-owned-recovery-reference'});
    if(result.rowsAffected!==1)fail('GP_ACCESS_FIXTURE_MASTER_ANCHOR');
  },{isolation:'serializable'});
  return {recordId:records[0].id,sourceRevision:records[0].revision,consumerId:'gp.synthetic-owned-recovery-reference'};
}
async function seedOwnArticleContent({ access, isolatedRecovery = false, actor = '00001' }) {
  if (isolatedRecovery !== true || access?.getCapabilities?.().providerId !== 'postgresql') fail('GP_ACCESS_FIXTURE_ISOLATION');
  const catalog = require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(access), before = await catalog.getByArticleNumber('000042');
  if (!before || before.description !== 'Synthetic Access article 42') throw Object.assign(new Error('GP_ACCESS_FIXTURE_OWN_CONTENT_SOURCE'), {
    code: 'GP_ACCESS_FIXTURE_OWN_CONTENT_SOURCE', syntheticDiagnostic: { articlePresent: !!before,
      articleNumber: before?.articleNumber || null, description: before?.description || null, sourceSystem: before?.sourceSystem || null, currentRevision: before?.currentRevision || null },
  });
  const mutation = await catalog.updateManual({ actor, timestamp: AT, mutationId: crypto.randomUUID(), input: { currentArticleNumber: '000042', expectedRevision: before.currentRevision,
    articleNumber: '000042', description: 'GP own manually edited article 42', identifiers: [{ identifierValue: '4006381333931', isPrimary: true }],
    prices: { sales: [{ priceType: 'sales', amount: '99.870000000000', currency: 'EUR', priceBasis: 'gross' }] } } });
  if (mutation.outcome !== 'updated') fail('GP_ACCESS_FIXTURE_OWN_EDIT');
  const image = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: { r: 19, g: 73, b: 121 } } }).webp().toBuffer();
  try { await require('../lib/persistence/repositories/sales-article-images').createSalesArticleImagesRepository(access).save({ articleNumber: '000042', productId: before.productId, expectedRevision: null,
    image: { buffer: image, mime: 'image/webp', width: 2, height: 2 }, actor }); }
  finally { image.fill(0); }
  return ownContentProof(access);
}
module.exports = { FORMAT, fixtureRows, definitionsForFiles, generateAccessRecoveryFixture, seedAccessRecoveryFixture, seedOwnArticleContent, seedOwnMasterAnchor, ownContentProof };
