"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const M = require('../lib/tradefoto-master-profiles');
const R = require('../lib/tradefoto-sales-rules');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterService } = require('../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters, createImportHistoryService } = require('../lib/persistence/repositories/import-history');
const { ensureSqliteDataImportSchema } = require('../lib/persistence/sqlite/operations/data-import-schema');
const { ensureSqliteImportMasterSchema } = require('../lib/persistence/sqlite/operations/import-master-schema');
const { ensureSqliteImportHistorySchema, IMPORT_HISTORY_SCHEMA_SQL } = require('../lib/persistence/sqlite/operations/import-history-schema');
const { ensureSqliteCrmSchema } = require('../lib/persistence/sqlite/operations/crm-schema');
const { ensureSqliteSalesArticleCatalogSchema } = require('../lib/persistence/sqlite/operations/sales-article-catalog-schema');
const { SQLITE_DATA_IMPORT_CATALOG } = require('../lib/persistence/sqlite/data-import-catalog');
const { SQLITE_IMPORT_MASTER_CATALOG } = require('../lib/persistence/sqlite/import-master-catalog');
const { SQLITE_IMPORT_HISTORY_CATALOG } = require('../lib/persistence/sqlite/import-history-catalog');
const { SQLITE_CRM_CUSTOMERS_CATALOG } = require('../lib/persistence/sqlite/crm-customers-catalog');
const { SQLITE_SALES_ARTICLE_CATALOG } = require('../lib/persistence/sqlite/sales-article-catalog-catalog');
const { IMPORT_HISTORY_STATEMENTS: S } = require('../lib/persistence/statements/import-history');
const { IMPORT_MASTER_STATEMENTS: MS } = require('../lib/persistence/statements/import-master-data');
const { compilePostgresqlDialectEntry } = require('../lib/persistence/postgresql/dialect-compiler');
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require('../lib/tradefoto-article-source-profile');
const { createSalesHistoryWorkspace } = require('../lib/persistence/repositories/sales-history-workspace');
const { SALES_HISTORY_PERMISSIONS: HP } = require('../lib/sales-history-access');
const { SALES_ANALYTICS_PERMISSIONS: AP } = require('../lib/sales-analytics-access');
const { CRM_PERMISSIONS: CP } = require('../lib/crm-access');
const express = require('express');
const { registerSalesHistoryRoutes } = require('../lib/sales-history-routes');
const TIME = '2026-09-05T11:00:00.000Z', DAY = '2026-09-04T00:00:00.000', SHA = 'a'.repeat(64);
const code = expected => error => error?.code === expected;
const raw = (source, name, extra = {}) => Object.assign(Object.fromEntries(H.tableFor(source, name).columns.map(f => [f.name, null])), extra);
const masterRaw = (name, extra) => Object.assign(Object.fromEntries(M.tableFor(name).columns.map(f => [f.name, null])), extra);
const head = (extra = {}) => raw('cash', 'Umsatz_KASSE', { Bonnr: '001', Filialid: '1', Kassenid: '1', Bondatum: DAY, Bonzeit: '1899-12-30T10:15:30.000',
  KUND_NR: '000419', VerkäuferID: '7', RechnungsBetrag: '12', ...extra });
const flags = Object.fromEntries(R.STATUS_FIELDS.map(f => [f, false]));
const line = (extra = {}) => raw('cash', 'Umsatz_Kasse_Details', { RepID: '00000000-0000-0000-0000-000000000001', Bonnr: '001', Filialid: '1', Kassenid: '1', Bondatum: DAY,
  EAN: '0000123', VKMenge: '1', VK_Preis: '12', MWST: '1', Verkäuferid: '8', Artikelbezeichnung: 'Synthetischer historischer Artikel', ...flags, ...extra });
function policy(extra = {}) {
  return R.defineTradeFotoSalesPolicy({ id: 'synthetic-confirmed-policy', version: 1, scopeId: 'scope', sourceInstance: 'cash-source',
    schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, evidenceSha256: SHA, approvedBy: 'synthetic-reviewer', approvedAt: TIME,
    currency: 'EUR', minorUnits: 2, priceBasis: 'gross', priceMeaning: 'final_unit', headerBasis: 'gross', rounding: 'half_away_from_zero',
    vatRates: { '1': '20' }, headerToleranceMinor: 0, statusRules: [
      { id: 'positive', status: 'sale', flags, quantitySign: 'positive' },
      { id: 'negative', status: 'return', flags, quantitySign: 'negative' },
      { id: 'void', status: 'excluded', flags: { ...flags, BStorno: true }, quantitySign: 'any' },
    ], ...extra });
}
const coverage = (header, lines, extra = {}) => R.defineTradeFotoReceiptCoverage({ scopeId: 'scope', sourceInstance: 'cash-source', fileSha256: SHA,
  schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, evidenceSha256: SHA, expectedSourceRows: lines.length, verifiedSourceRows: lines.length,
  head: header, lines, ...extra });

test('History retains the 43 original tables, 21 Bestell profiles and six limited supplement profiles', () => {
  assert.deepEqual(H.TRADEFOTO_HISTORY_METADATA.coverage, { tables: 70, fields: 1218 });
  assert.equal(H.TRADEFOTO_HISTORY_PROFILES.length, 70);
  assert.equal(H.TRADEFOTO_HISTORY_METADATA.tables.filter(t=>!t.sourceFile).length,43);
  const B=require('../lib/tradefoto-bestell/profiles');
  for(const table of B.metadata.tables.filter(t=>t.included)) assert.equal(H.profileFor('trade',table.name),B.profileFor(table.name));
  assert.deepEqual(H.profileFor('cash', 'Umsatz_KASSE').keyFields, ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum']);
  assert.deepEqual(H.profileFor('cash', 'Umsatz_Kasse_Details').keyFields, ['RepID']);
  for (const name of ['Tagesbericht', 'KassenJournal_Details']) assert.deepEqual(H.profileFor('cash', name).keyFields, ['_source_snapshot_sha256', '_source_row']);
  assert.throws(() => H.profileFor('trade', 'MITARBEITER'));
});

test('Block 4: reader retains civil time, leading zeros and fractional decimals; GUID keys have a single canonical form', () => {
  const prepared = H.prepareTradeFotoHistoryRow('cash', 'Umsatz_Kasse_Details', line({ RepID: '{ABCDEFAB-0000-0000-0000-000000000001}', VKMenge: 1e-7, Bondatum: new Date(DAY + 'Z') }));
  const result = C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), prepared);
  assert.equal(result.key[0], 'abcdefab-0000-0000-0000-000000000001'); assert.equal(result.source.VKMenge, '0.0000001');
  assert.equal(result.source.Bondatum, DAY); assert.equal(result.source.EAN, '0000123');
  assert.throws(() => C.normalizeDataImportRow(H.profileFor('cash', 'Umsatz_Kasse_Details'), { ...prepared, RepID: '{not-guid}' }), code('IMPORT_GUID_INVALID'));
  assert.throws(() => H.prepareTradeFotoHistoryRow('cash', 'Umsatz_KASSE', head({ Bonnr: 9007199254740992 })), code('IMPORT_IDENTIFIER_PRECISION'));
  assert.throws(() => H.prepareTradeFotoHistoryRow('cash', 'Umsatz_KASSE', { ...head(), NewColumn: 'x' }), code('IMPORT_SHAPE_INVALID'));
});

test('Central imports register history and snapshot catalogs with permission-checked apply', () => {
  assert.equal(SQLITE_IMPORT_HISTORY_CATALOG.length, 33); assert.equal(Object.keys(S).length, 23);
  const snapshotStatements=require('../lib/persistence/statements/import-history-snapshots').S;
  for (const entry of SQLITE_IMPORT_HISTORY_CATALOG) assert.equal(compilePostgresqlDialectEntry(entry).strategy,
    entry.statement===snapshotStatements.membersPut?'requires-override':'portable-generated', entry.statement.id);
  assert.ok(!/AUTOINCREMENT|PRAGMA|rowid|json_|RAISE\(/iu.test(IMPORT_HISTORY_SCHEMA_SQL));
  const catalog=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  assert.ok(SQLITE_IMPORT_HISTORY_CATALOG.every(e=>catalog.some(c=>c.statement===e.statement)));
  assert.match(fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),/createDataImportRuntime\(\{[^}]*allowApply: true, sharedPayloads: true/);
});

const reconcile = (heads, lines, options = {}) => R.reconcileTradeFotoReceipt({ head: heads, lines: lines.map(source => ({ source, parentRevision: 1 })),
  headRevision: 1, snapshotDate: '2026-09-05', scopeId: 'scope', sourceInstance: 'cash-source', policy: policy(), coverage: coverage(heads, lines), ...options });

test('Productive Block 1: an explicitly verified placeholder head never erases signed final-price sales or zero lines',()=>{
  const header=head({RechnungsBetrag:'0'}),rows=[line({VK_Preis:'600.78',MWST:'20',AStorno:true,Ret:false,NachlaßDM:'10'}),
    line({RepID:'00000000-0000-0000-0000-000000000002',VK_Preis:'75',VKMenge:'-1',MWST:'20',AStorno:true,Ret:false})];
  const rules=[{id:'sale-a',status:'sale',quantitySign:'positive',flags:{...flags,AStorno:true}},
    {id:'return-a',status:'return',quantitySign:'negative',flags:{...flags,AStorno:true}}];
  const verified=policy({headerZeroMeaning:'unavailable',vatRates:{20:'20'},statusRules:rules});
  const result=reconcile(header,rows,{policy:verified});assert.equal(result.totals.gross,'525.78');assert.equal(result.totals.net,'438.15');
  assert.equal(result.reconciliation.headerStatus,'unavailable_zero_placeholder');assert.equal(result.reconciliation.difference,null);
  assert.equal(header.RechnungsBetrag,'0');assert.equal(rows[0].NachlaßDM,'10');
  assert.equal(reconcile(header,rows,{policy:policy({vatRates:{20:'20'},statusRules:rules})}).totals,null);
  assert.equal(reconcile(header,rows,{policy:verified,coverage:null}).totals,null);
  assert.equal(reconcile(head({RechnungsBetrag:'1'}),rows,{policy:verified}).totals,null);
  const zero=line({VK_Preis:'0',VKMenge:'5',MWST:'20',AStorno:true});const zeroResult=reconcile(header,[zero],{policy:verified});
  assert.equal(zeroResult.totals.gross,'0.00');assert.equal(zeroResult.counts.lines,1);assert.equal(zeroResult.positions.length,1);
  assert.throws(()=>policy({headerZeroMeaning:'ignore'}),code('IMPORT_SALES_POLICY_INVALID'));
});
test('Block 4: default sales gate stays closed, including heads without details', () => {
  const result = reconcile(head(), [], { policy: null }); assert.equal(result.canAggregate, false); assert.equal(result.totals, null);
  assert.ok(result.issues.includes('SALES_SEMANTICS_UNCONFIRMED')); assert.ok(result.issues.includes('RECEIPT_WITHOUT_LINES'));
  assert.throws(() => reconcile(head(), [line()], { policy: { ...policy() } }), code('IMPORT_SALES_POLICY_UNTRUSTED'));
  assert.throws(() => reconcile(head(), [line()], { sourceInstance: 'different' }), code('IMPORT_SALES_POLICY_SCOPE'));
});
test('Block 4: exact decimal arithmetic handles sales, fractional quantities, returns and discounts already in final price', () => {
  const result = reconcile(head({ RechnungsBetrag: '24.00' }), [line({ VKMenge: '2.5', Rabatt_DM: '3', Rabatt: '10' }), line({ RepID: '00000000-0000-0000-0000-000000000002', VKMenge: '-0.5' })]);
  assert.equal(result.canAggregate, true); assert.deepEqual(result.totals, { currency: 'EUR', gross: '24.00', net: '20.00', tax: '4.00' });
  assert.equal(result.counts.sales, 1); assert.equal(result.counts.returns, 1);
  const rounded = reconcile(head({ RechnungsBetrag: '0.01' }), [line({ VKMenge: '0.1', VK_Preis: '0.05' })]); assert.equal(rounded.totals.gross, '0.01');
  const negative = reconcile(head({ RechnungsBetrag: '-0.01' }), [line({ VKMenge: '-0.1', VK_Preis: '0.05' })]); assert.equal(negative.totals.gross, '-0.01');
});
test('Block 4: explicit net and line-final price meanings do not multiply or discount twice', () => {
  const net = reconcile(head(), [line({ VK_Preis: '10' })], { policy: policy({ priceBasis: 'net' }) }); assert.equal(net.totals.gross, '12.00');
  const final = reconcile(head(), [line({ VKMenge: '3', VK_Preis: '12', NachlaßDM: '4' })], { policy: policy({ priceMeaning: 'final_line' }) }); assert.equal(final.totals.gross, '12.00');
});
test('Block 4: unknown/ambiguous status, VAT, amounts and incomplete totals fail closed', () => {
  for (const [extra, issue] of [[{ AStorno: true }, 'STATUS_REVIEW_REQUIRED'], [{ MWST: '99' }, 'VAT_CODE_UNKNOWN'], [{ VK_Preis: '-12' }, 'NEGATIVE_UNIT_PRICE_REVIEW'], [{ VKMenge: null }, 'IMPORT_SALES_DECIMAL_INVALID']]) {
    const result = reconcile(head(), [line(extra)]); assert.equal(result.canAggregate, false); assert.equal(result.totals, null); assert.ok(result.issues.includes(issue));
  }
  const ambiguous = policy({ statusRules: [{ id: 'a', status: 'sale', quantitySign: 'positive', flags }, { id: 'b', status: 'sale', quantitySign: 'any', flags }] });
  assert.ok(reconcile(head(), [line()], { policy: ambiguous }).issues.includes('STATUS_RULE_AMBIGUOUS'));
  assert.ok(reconcile(head({ RechnungsBetrag: '13' }), [line()]).issues.includes('RECEIPT_AMOUNT_MISMATCH'));
  assert.ok(reconcile(head(), [line()], { lines: [{ source: line({ Filialid: '2' }), parentRevision: 1 }] }).issues.includes('RECEIPT_LINE_KEY_MISMATCH'));
  assert.ok(reconcile(head({ Bondatum: '2026-12-30T00:00:00.000' }), []).issues.includes('BUSINESS_DATE_REVIEW_REQUIRED'));
  const voided = reconcile(head({ RechnungsBetrag: '0' }), [line({ BStorno: true })]); assert.equal(voided.canAggregate, true); assert.equal(voided.counts.excluded, 1);
});

test('Block 4: a matching receipt amount cannot hide omitted zero/void lines or incomplete source coverage', () => {
  const missing = reconcile(head(), [line()], { coverage: null }); assert.equal(missing.canAggregate, false); assert.equal(missing.totals, null);
  const second = line({ RepID: '00000000-0000-0000-0000-000000000002', BStorno: true });
  const incomplete = reconcile(head(), [line()], { coverage: coverage(head(), [line(), second]) });
  assert.ok(incomplete.issues.includes('RECEIPT_SOURCE_COVERAGE_MISMATCH')); assert.equal(incomplete.totals, null);
  assert.throws(() => coverage(head(), [line()], { expectedSourceRows: 2 }), code('IMPORT_SALES_COVERAGE_INCOMPLETE'));
  assert.throws(() => coverage(head(), [line(), line()]), code('IMPORT_SALES_COVERAGE_LINES'));
  assert.throws(() => reconcile(head(), [line()], { coverage: { ...coverage(head(), [line()]) } }), code('IMPORT_SALES_COVERAGE_UNTRUSTED'));
});
