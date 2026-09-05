import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract');
const { TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS, TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS } = require('../lib/tradefoto-article-source-profile');
const { salesArticlePriceGroup } = require('../lib/sales-article-catalog-access');
const source = require('../docs/tradefoto-gesamtimport-v0.1/catalog.json');
const trade = source.sources.find(item => item.id === 'trade');
// Reviewed candidate strategies. No Access PK declaration is claimed. Other tables
// keep snapshot + ordinal identity, including genuine duplicate note/condition rows.
const keys = { KUNDEN: ['KUND_NR'], LIEFERANTEN: ['Suchname'], MITARBEITER: ['Verkäufer_ID'],
  FILIALEN: ['FilialID'], ARTIKEL_STAMM: ['EAN'], ARTIKEL_ZWEITEAN: ['ZweitEAN'],
  ADANREDE: ['ANREDE'], ARTIKEL_BILDER_V2: ['ID'], ARTIKEL_Provisionen: ['ProvisionKZ'],
  ARTIKEL_Sortimente: ['Sortiment'], Artikel_Sortimentsart: ['Sortimentsart'], ARTIKEL_Sparten: ['Sparte'],
  ARTIKEL_Warengruppen: ['Warengruppe'], Bundle: ['BundleId'], Gerätetyp: ['Gerätetyp_ID'],
  Kunden_GPreisgruppen: ['GPreisgruppe'], Kunden_Preisgruppen: ['Preisgruppe'], Kunden_Zahlart: ['ID'],
  Kundengruppen: ['Kundengruppe'], Kundenrabattgruppen: ['KundenRabattGruppe'],
  Preis_Kennung: ['KennungA', 'KennungB', 'KennungC', 'KennungD'], Sortiment_Rabattgruppen: ['SortimentRabattGruppe'],
};
const selected = trade.tables.filter(table => /^(catalog|crm|suppliers|organization)\./u.test(table.group));
for (const [name, columns] of Object.entries(keys)) {
  const evidence = trade.keys.find(key => key.table === name && C.equal(key.columns, columns));
  if (!evidence || evidence.rows < 1 || evidence.nullRows !== 0 || evidence.duplicateRows !== 0) throw new Error('Candidate key evidence is missing or ambiguous');
}
const priceClasses = new Map(TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(field => [field.sourceField, 'catalog_' + salesArticlePriceGroup(field.priceType)]));
for (const field of TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS) priceClasses.set(field.sourceField, 'catalog_costs');
function dataClass(table, column) {
  const sourceClass = column.destination.dataClass;
  if (sourceClass !== 'internal_business') return sourceClass;
  if (table.name === 'ARTIKEL_STAMM' && priceClasses.has(column.name)) return priceClasses.get(column.name);
  if (table.group === 'catalog.pricing' || table.group === 'suppliers.conditions') return 'catalog_costs';
  return sourceClass;
}
const tables = selected.map(table => ({ name: table.name, group: table.group, keys: keys[table.name] || null,
  columns: table.columns.map(column => ({ name: column.name, type: column.type,
    dataClass: dataClass(table, column), excluded: C.secretField(column.name) })) }));
const tableByName = new Map(tables.map(table => [table.name.toLowerCase(), table]));
// Access relationship metadata has different casing from table/column metadata.
// Resolve schema names only; never case-fold source identity values.
const relations = source.relations.flatMap(relation => {
  const from = tableByName.get(relation.childTable.toLowerCase()), to = tableByName.get(relation.parentTable.toLowerCase());
  if (relation.childSource !== 'trade' || relation.parentSource !== 'trade' || !from || !to) return [];
  const column = (table, name) => {
    const matches = table.columns.filter(field => field.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new Error('Relationship column is ambiguous');
    return matches[0].name;
  };
  return [{ from: from.name, fields: relation.childColumns.map(name => column(from, name)), to: to.name,
    keys: relation.parentColumns.map(name => column(to, name)), evidence: relation.evidence,
    reviewOnly: relation.evidence !== 'declared_in_access' }];
});
const metadata = { version: 1, sourceSystem: 'tradefoto.master-data', schemaSha256: trade.schemaSha256,
  coverage: { tables: tables.length, fields: tables.reduce((sum, table) => sum + table.columns.length, 0) }, tables, relations };
const output = JSON.stringify(metadata, null, 2) + '\n';
const path = new URL('../lib/tradefoto-master-metadata.json', import.meta.url);
if (process.argv.includes('--write')) fs.writeFileSync(path, output);
else if (fs.readFileSync(path, 'utf8') !== output) throw new Error('Master metadata differs from reviewed inventory');
console.log(JSON.stringify({ ...metadata.coverage, relations: relations.length, mode: process.argv.includes('--write') ? 'generated_metadata_only' : 'verified' }));
