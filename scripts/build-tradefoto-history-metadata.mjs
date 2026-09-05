import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract');
const catalog = require('../docs/tradefoto-gesamtimport-v0.1/catalog.json');
// Candidate uniqueness was measured in the pinned inventory, not declared as an Access PK.
const keys = {
  cash: { Umsatz_KASSE: ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'], Umsatz_Kasse_Details: ['RepID'], KassenJournal: ['Vorgang'] },
  trade: { tblProtBestand: ['ID'], tblProtBestand_comp: ['ID'], ARTIKEL_PlattForm: ['PEAN'],
    MWST_Sätze: ['MWST'], Rechnung_Export: ['Rechnungsnr'], REPARATUR_WERKSTATT: ['Werkstatt_Id'], Shopware_Artikel: ['EAN'] },
};
function dataClass(table, column) {
  // A receipt line is customer-linkable even when the customer number is only in its head.
  if (/Verkäufer|verkaeufer|Personalkennziffer|Provision|^Prov$/iu.test(column.name)) return 'personnel_restricted';
  if (/KUND_NR|KPLZ/iu.test(column.name) || table.group.startsWith('repairs.')) return 'customer_restricted';
  if (table.group.startsWith('finance.')) return 'restricted_finance';
  if (/Rohertrag|DEK|EK_|IKosten|Kalk|Aufschlag/iu.test(column.name)) return 'catalog_costs';
  if (['sales.receipts', 'sales.lines'].includes(table.group)) return 'customer_restricted';
  return column.destination.dataClass;
}
const tables = catalog.sources.flatMap(source => source.tables.filter(table => source.id === 'cash'
  || /^(inventory|finance|repairs|commerce)\./u.test(table.group) || table.group === 'legacy.documents_exports').map(table => {
  const candidate = keys[source.id]?.[table.name] || null;
  if (candidate) {
    const evidence = source.keys.find(key => key.table === table.name && C.equal(key.columns, candidate));
    if (!evidence || !evidence.rows || evidence.nullRows || evidence.duplicateRows) throw new Error('History candidate key not verified: ' + table.name);
  }
  return { source: source.id, sourceSystem: 'tradefoto.history.' + source.id, schemaSha256: source.schemaSha256,
    name: table.name, group: table.group, keys: candidate,
    columns: table.columns.map(column => ({ name: column.name, type: column.type, dataClass: dataClass(table, column) })) };
}));
const metadata = { version: 1, coverage: { tables: tables.length, fields: tables.reduce((n, t) => n + t.columns.length, 0) }, tables };
const output = JSON.stringify(metadata, null, 2) + '\n';
const path = new URL('../lib/tradefoto-history-metadata.json', import.meta.url);
if (process.argv.includes('--write')) fs.writeFileSync(path, output);
else if (fs.readFileSync(path, 'utf8') !== output) throw new Error('History metadata differs from pinned inventory');
console.log(JSON.stringify({ ...metadata.coverage, mode: process.argv.includes('--write') ? 'generated_metadata_only' : 'verified' }));
