'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTools } = require('../scripts/import-tradefoto-crm.cjs');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { ensureSqliteCrmSchema } = require('../lib/persistence/sqlite/operations/crm-schema');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterReferenceReader } = require('../lib/persistence/repositories/import-master-data');
const { DATA_IMPORT_RUNTIME_STATEMENTS: R } = require('../lib/persistence/statements/data-import-runtime');
const M = require('../lib/tradefoto-master-profiles');
const raw = extra => Object.assign(Object.fromEntries(M.tableFor('KUNDEN').columns.map(c => [c.name, null])), extra);


test('CRM maintenance projection keeps account identity, missing fields and all invalid original values', () => {
  const tools = createTools();
  assert.equal(tools.project({ KUND_NR: '0' }), null);
  const result = tools.project({ KUND_NR: '00042', EMail: 'bad@@mail', UStID: 'ATU123', TELEFON: '', Handy: 'x'.repeat(81), NACHNAME: null });
  assert.equal(result.accountNumber, '00042'); assert.equal(result.normalized.customerType, 'unknown');
  assert.equal(result.normalized.customerNumber, null); assert.equal(result.normalized.email, ''); assert.equal(result.normalized.vatId, '');
  assert.equal(result.reviewFields.length, 3); assert(result.reviewFields.some(f => f.value.includes('Handy') && f.value.includes('x'.repeat(81))));
  assert.equal(result.nameless, true); assert.equal(tools.project({ KUND_NR: '43', TELEFON: '123', Handy: '456' }).normalized.phone, '123');
  assert.throws(() => tools.project({ KUND_NR: '' }));
});
