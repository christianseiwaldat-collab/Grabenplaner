'use strict';
// Synthetic import through the same encrypted master/history writers as the GP.
const crypto = require('node:crypto');
const C = require('../../lib/data-import-contract'), M = require('../../lib/tradefoto-master-profiles'), H = require('../../lib/tradefoto-history-profiles');
const { createDataImportEngine } = require('../../lib/data-import-engine');
const { createDataImportRepository } = require('../../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterService } = require('../../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters } = require('../../lib/persistence/repositories/import-history');
const { createSalesArticleImagesRepository } = require('../../lib/persistence/repositories/sales-article-images');
const { createSalesArticleCatalogRepository } = require('../../lib/persistence/repositories/sales-article-catalog');
const TIME = '2026-09-13T12:00:00.000Z', sourceInstance = 'tradefoto-trade';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function seedBranchArticleDetails({ access, protection, ownLocation = '93', otherLocation = '94' }) {
  const composition = { protection, getActor: () => ({ scopeId: 'grabenplaner-main', ownerId: 'synthetic-admin' }), authorize: () => true, clock: () => TIME };
  const engine = createDataImportEngine({ ...composition, repository: createDataImportRepository(access), profiles: [...M.TRADEFOTO_MASTER_PROFILES, ...H.TRADEFOTO_HISTORY_PROFILES],
    writers: { ...createImportMasterWriters({ protection }), ...createImportHistoryWriters({ ...composition, resolveMasterSourceInstance: () => sourceInstance }) } });
  const masters = createImportMasterService({ ...composition, access });
  async function ingest(source, name, values, snapshotAt = TIME) {
    const meta = source === 'master' ? M : H, table = source === 'master' ? M.tableFor(name) : H.tableFor(source, name);
    const profile = source === 'master' ? M.profileFor(name) : H.profileFor(source, name), fileSha256 = digest(JSON.stringify([name, values, snapshotAt]));
    let run = await engine.start({ profileHash: profile.fingerprint, manifest: { sourceInstance, fileSha256, schemaSha256: profile.schemaSha256,
      expectedRows: values.length, declaredRows: values.length, snapshotAt, gates: [] } });
    if (run.status === 'applied') return run;
    const rows = values.map((value, index) => {
      const raw = { ...Object.fromEntries(table.columns.map(c => [c.name, null])), ...value }, context = { fileSha256, rowNumber: index + 1 };
      return source === 'master' ? meta.prepareTradeFotoMasterRow(name, raw, context) : meta.prepareTradeFotoHistoryRow(source, name, raw, context);
    });
    for (let start = 0; start < rows.length; start += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: start + 1, rows: rows.slice(start, start + C.LIMITS.batch) });
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === 'reviewing');
    if (run.status !== 'ready') throw new Error('Synthetic article detail import: ' + JSON.stringify(await engine.preview(run.id)));
    do { run = await engine.apply(run.id, run.revision); } while (run.status === 'applying');
    return run;
  }
  await ingest('master', 'FILIALEN', [ownLocation, otherLocation, '00', '77', '70'].map(FilialID => ({ FilialID, FName: 'Demo-Filiale ' + FilialID })));
  for (const key of [ownLocation, otherLocation]) {
    const row = (await masters.mappings({ table: 'FILIALEN', sourceInstance, key })).items[0];
    if (!row.binding) {
      const input = { recordId: row.id, expectedSourceRevision: row.revision, targetId: key, historical: false, reason: 'Synthetische Filialzuordnung' };
      await masters.bind(input, (await masters.previewBinding(input)).planHash);
    }
  }
  await ingest('master', 'ARTIKEL_STAMM', [
    { EAN: '1', Artikelbezeichnung: 'Kamera Aurora 24 – Vorführmodell', Sortimentsart: 'Abverkauf', Abverkauf: true, MWST: 1, DurchschnittEK: '123.456789', NNPreis: '99', DEK_A: '777',
      HerstellerLink: 'https://example.com/aurora https://geizhals.at/?fs=Aurora https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=Aurora' },
    { EAN: '2', Artikelbezeichnung: 'Objektiv 35 mm – Café Edition', Sortimentsart: 'Stamm', MWST: 1 },
    { EAN: '3', Artikelbezeichnung: 'Kamerazubehör Muster 3', Sortimentsart: 'EOL', Auslaufartikel: true, MWST: 2 },
    { EAN: '4', Artikelbezeichnung: 'Kamerazubehör Muster 4', Sortimentsart: 'keine LW', MWST: 0 },
  ]);
  await ingest('master', 'KUNDEN', [
    { KUND_NR: '090078', KontoNr: 8801, VORNAME: 'Mia', NACHNAME: 'Muster', 'STRaße': 'Musterstraße 12', PLZ: '6020', ORT: 'Innsbruck', Land: 'Österreich', TELEFON: '+43 512 123456', Handy: '+43 660 111222', EMail: 'mia.muster@example.test' },
    { KUND_NR: '090079', KontoNr: 8802, VORNAME: 'Noah', NACHNAME: 'Beispiel', 'STRaße': 'Testgasse 8', PLZ: '1010', ORT: 'Wien', TELEFON: '+43 1 987654', Handy: '+43 660 333444', EMail: 'noah@example.test' },
    { KUND_NR: '0', VORNAME: 'UNASSIGNED-CUSTOMER-SECRET', NACHNAME: 'Anonymous', EMail: 'anonymous@example.test' },
  ]);
  const linkedCustomer = (await masters.mappings({ table: 'KUNDEN', sourceInstance, key: '090079' })).items[0];
  if (!linkedCustomer.binding) {
    const input = { recordId: linkedCustomer.id, expectedSourceRevision: linkedCustomer.revision, decision: { customerType: 'private' } };
    await masters.syncCustomer(input, (await masters.previewCustomer(input)).planHash);
  }
  const values = [ownLocation, otherLocation, '00', '77', '70'].map((FilialID, i) => ({ EAN: '1', FilialID, FBestand: [3, 8, 0, -1, 2][i], ProvisionKZ: 'SECRET-COMMISSION', Bestandsänderungsdatum: '2026-09-13T09:00:00.000' }));
  await ingest('trade', 'ARTIKEL_FILIALEN', [{ EAN: '1', FilialID: ownLocation, FBestand: 99 }], '2026-09-12T12:00:00.000Z');
  await ingest('trade', 'ARTIKEL_FILIALEN', values);
  const images = createSalesArticleImagesRepository(access), catalog = createSalesArticleCatalogRepository(access);
  if (!(await images.metadata('00042')).present) {
    const buffer = await require('sharp')({ create: { width: 88, height: 76, channels: 3, background: '#c4d7cf' } }).webp().toBuffer();
    await images.save({ articleNumber: '00042', productId: (await catalog.getByArticleNumber('00042')).productId,
      expectedRevision: null, actor: 'synthetic-demo', image: { buffer, mime: 'image/webp', width: 88, height: 76 } });
  }
  return { ingest };
}
module.exports = { seedBranchArticleDetails };
