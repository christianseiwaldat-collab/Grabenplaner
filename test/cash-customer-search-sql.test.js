'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../lib/persistence/statements/cash-publications');
const { CASH_LOCATION_READS: R } = require('../lib/persistence/statements/cash-location-reads');
const { CASH_SNAPSHOT_STATEMENTS: D, CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { SQLITE_CASH_PUBLICATIONS_CATALOG } = require('../lib/persistence/sqlite/cash-publications-catalog');
const { CATALOG: LOCATION_CATALOG } = require('../lib/persistence/sqlite/cash-location-reads-catalog');
const NAME = 'Umsatz_Kasse_Details', publicationId = 'a'.repeat(64), otherPublication = 'b'.repeat(64);
const key = number => Buffer.alloc(32, number);
const head = TABLES.find(table => table.name === 'Umsatz_KASSE');
const line = TABLES.find(table => table.name === NAME);
const customer = S.searchCustomer[NAME], assigned = S.searchCustomerAssigned[NAME];
const defaults = { publicationId, datasetSlot: 1, dateFrom: '2026-08-01', dateTo: '2026-08-31',
  afterDate: '2026-09-01', afterRow: Number.MAX_SAFE_INTEGER, locationId: 'branch-a', unassigned: false,
  sellerId: null, sellerMode: 'none', sellerRole: 'line_seller', customerId: 'customer-a', customerKey: key(2), limit: 100 };

async function seed(access) {
  await access.transaction(async tx => {
    for (const slot of [1, 2]) await tx.execute(D.insert, { slot, id: String(slot).repeat(64), scopeId: 'synthetic-customer-sql',
      ownerId: 'synthetic-owner', revision: 1, createdAt: '2026-10-05T00:00:00.000Z', payload: 'synthetic' });
    for (const id of [publicationId, otherPublication]) await tx.execute(S.insertPublication, { id, scopeId: 'synthetic-customer-sql',
      datasetId: '1'.repeat(64), ownerId: 'synthetic-owner', createdAt: '2026-10-05T00:00:00.000Z', payload: 'synthetic' });
    for (const [kind, source, targetId, historical] of [
      ['FILIALEN', 11, 'branch-a', false], ['FILIALEN', 12, 'branch-b', false],
      ['MITARBEITER', 21, 'seller-line', false], ['MITARBEITER', 22, 'seller-header', false],
      ['KUNDEN', 1, 'customer-a', false], ['KUNDEN', 3, 'customer-b', false], ['KUNDEN', 5, 'customer-a', true],
    ]) await tx.execute(S.insertBinding, { publicationId, kind, sourceKey: key(source), targetId, historical, payload: 'synthetic' });
    await tx.execute(S.insertBinding, { publicationId: otherPublication, kind: 'KUNDEN', sourceKey: key(2),
      targetId: 'customer-b', historical: false, payload: 'synthetic' });
    const receipts = [
      { row: 1, customer: 1, rows: [11, 12] }, { row: 2, customer: 2, rows: [20] },
      { row: 3, customer: 3, rows: [30] }, { row: 4, customer: 2, rows: [40], location: null },
      { row: 5, customer: 2, rows: [50], location: 12 }, { row: 6, customer: 2, rows: [60], seller: null },
      { row: 7, customer: null, rows: [70] }, { row: 8, customer: 5, rows: [80], date: '2026-07-31' },
    ];
    for (const receipt of receipts) {
      const locationKey = Object.hasOwn(receipt, 'location') ? receipt.location === null ? null : key(receipt.location) : key(11);
      const customerKey = receipt.customer === null ? null : key(receipt.customer);
      const businessDate = receipt.date || '2026-08-01';
      await tx.execute(head.statements.insert, { datasetSlot: 1, sourceRow: receipt.row, sourceKey: key(receipt.row), businessDate,
        parentRow: null, locationKey, sellerKey: key(22), customerKey, articleKey: null, payload: 'synthetic' });
      for (const sourceRow of receipt.rows) await tx.execute(line.statements.insert, { datasetSlot: 1, sourceRow, sourceKey: key(sourceRow),
        businessDate, parentRow: receipt.row, locationKey, sellerKey: receipt.seller === null ? null : key(21),
        customerKey: null, articleKey: key(31), payload: 'synthetic' });
    }
    await tx.execute(head.statements.insert, { datasetSlot: 2, sourceRow: 1, sourceKey: key(1), businessDate: '2026-08-01', parentRow: null,
      locationKey: key(11), sellerKey: key(22), customerKey: key(2), articleKey: null, payload: 'synthetic' });
    await tx.execute(line.statements.insert, { datasetSlot: 2, sourceRow: 99, sourceKey: key(99), businessDate: '2026-08-01', parentRow: 1,
      locationKey: key(11), sellerKey: key(21), customerKey: null, articleKey: key(31), payload: 'synthetic' });
  });
}

async function check(access) {
  const rows = async (statement = customer, overrides = {}) => {
    const parameters = { ...defaults, ...overrides };
    if (statement === R.nullCustomerSearch[NAME]) { delete parameters.locationId; delete parameters.unassigned; }
    return (await access.queryAll(statement, parameters)).map(row => row.sourceRow);
  };
  assert.deepEqual(await rows(), [60, 20, 12, 11], 'verified fallback and explicit mapping are combined without duplicates');
  assert.deepEqual(await rows(assigned), [60, 20, 12, 11]);
  assert.deepEqual(await rows(customer, { customerKey: null }), [12, 11], 'explicit mappings remain usable without a bridge');
  assert.deepEqual(await rows(customer, { customerKey: key(3) }), [12, 11], 'explicit assignment to another customer suppresses the fallback');
  assert.deepEqual(await rows(customer, { customerKey: key(1) }), [12, 11], 'matching explicit assignment is returned once');
  assert.deepEqual(await rows(customer, { customerId: null }), [], 'a customer-specific search requires its authorized target');
  assert.deepEqual(await rows(customer, { customerId: 'customer-b', customerKey: null }), [30]);
  assert.deepEqual(await rows(customer, { locationId: 'branch-b' }), [50]);
  assert.deepEqual(await rows(customer, { locationId: null, unassigned: true }), [40]);
  assert.deepEqual(await rows(assigned, { locationId: null, unassigned: true }), []);
  assert.deepEqual(await rows(R.nullCustomerSearch[NAME]), [40], 'legacy branch-zero candidate path retains the customer filter');
  assert.deepEqual(await rows(R.nonNullCustomerSearch[NAME], { locationId: null, unassigned: true }), []);
  assert.deepEqual(await rows(R.nonNullCustomerSearch[NAME]), [60, 20, 12, 11]);
  assert.deepEqual(await rows(customer, { sellerMode: 'target', sellerRole: 'line_seller', sellerId: 'seller-line' }), [20, 12, 11]);
  assert.deepEqual(await rows(customer, { sellerMode: 'unassigned', sellerRole: 'line_seller' }), [60]);
  assert.deepEqual(await rows(customer, { sellerMode: 'target', sellerRole: 'header_seller', sellerId: 'seller-header' }), [60, 20, 12, 11]);
  assert.deepEqual(await rows(customer, { dateFrom: '2026-07-01' }), [60, 20, 12, 11, 80]);
  assert.deepEqual(await rows(customer, { dateFrom: '2026-08-02' }), []);
  assert.deepEqual(await rows(customer, { limit: 2 }), [60, 20]);
  assert.deepEqual(await rows(customer, { afterDate: '2026-08-01', afterRow: 20 }), [12, 11]);
  assert.deepEqual(await rows(customer, { datasetSlot: 2 }), [99], 'candidate receipt heads are isolated by dataset');
}

test('customer cash SQL preserves explicit assignments, bridge precedence and all authorization filters in SQLite', async t => {
  const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [...require('../lib/persistence/sqlite/cash-snapshots-catalog').SQLITE_CASH_SNAPSHOTS_CATALOG,
    ...SQLITE_CASH_PUBLICATIONS_CATALOG, ...LOCATION_CATALOG] });
  const database = app.database, access = app.provider;
  require('../lib/persistence/sqlite/operations/cash-snapshots-schema').ensureSqliteCashSnapshotsSchema(database);
  require('../lib/persistence/sqlite/operations/cash-publications-schema').ensureSqliteCashPublicationsSchema(database);
  t.after(async () => { await access.close(); database.close(); });
  await seed(access); await check(access);
  const entry = SQLITE_CASH_PUBLICATIONS_CATALOG.find(entry => entry.statement === customer);
  const params = Object.fromEntries(Object.entries(defaults).map(([name, value]) => ['$' + name, typeof value === 'boolean' ? Number(value) : value]));
  const plan = database.prepare('EXPLAIN QUERY PLAN ' + entry.sql).all(params).map(row => row.detail).join('\n');
  assert.match(plan, /cash_snapshot_1_customer_key[^\n]*customer_key=/);
});

test('customer cash reads qualify independently of pinned PostgreSQL contracts and stay wholly in Sales', () => {
  const { createSalesCatalog } = require('../lib/persistence/postgresql/sales/catalog');
  const pinned = JSON.stringify(createSalesCatalog(8).entries);
  const catalog = [...require('../lib/persistence/postgresql/sales/cash-customer-search').CATALOG,
    ...require('../lib/persistence/postgresql/sales/cash-location-reads').CATALOG.filter(entry => entry.statement.id.includes('customer-search'))];
  assert.equal(catalog.length, 4);
  assert.equal(new Set(catalog.map(entry => entry.statement.id)).size, 4);
  for (const entry of catalog) {
    assert.equal(entry.statement.operation, 'queryAll');
    assert.ok(entry.parameterOrder.includes('customerKey'));
    assert.match(entry.sql, /h \. customer_key IN/);
    assert.match(entry.sql, /UNION SELECT/);
    assert.doesNotMatch(entry.sql, /INDEXED BY|crm_customers|import_master_bindings|core\./);
  }
  assert.equal(JSON.stringify(createSalesCatalog(8).entries), pinned);
  assert.deepEqual(customer.parameters, { ...S.search[NAME].parameters, customerKey: { kind: 'bytes', nullable: true, optional: false } });
});

test('native PostgreSQL customer cash SQL preserves the same customer and branch eligibility',
  { skip: process.env.GP_PG_MIGRATION_LIVE !== '1', timeout: 90000 }, async t => {
    await require('../test-support/postgresql-migration/sales-fixture').withSalesFixture(8, async fixture => {
      await seed(fixture.postgres); await check(fixture.postgres);
      // A tiny fixture legitimately favors sequential scans. Give the planner
      // a realistic unrelated receipt population, with fresh statistics, and
      // prove that selecting one customer does not read the detail population.
      await fixture.client.query(`INSERT INTO kassa.cash_snapshot_1
        (dataset_slot,source_row,source_key,business_date,parent_row,location_key,seller_key,customer_key,article_key,payload)
        SELECT 1,1000+g,decode(md5('head-'||g)||md5('head-key-'||g),'hex'),'2026-08-01',NULL,$1,$2,
          decode(md5('customer-'||g)||md5('customer-key-'||g),'hex'),NULL,'synthetic-noise'
        FROM generate_series(1,10000) g`, [key(11), key(22)]);
      await fixture.client.query(`INSERT INTO kassa.cash_snapshot_6
        (dataset_slot,source_row,source_key,business_date,parent_row,location_key,seller_key,customer_key,article_key,payload)
        SELECT 1,1000+g*4+i,decode(md5('line-'||g||'-'||i)||md5('line-key-'||g||'-'||i),'hex'),
          '2026-08-01',1000+g,$1,$2,NULL,$3,'synthetic-noise'
        FROM generate_series(1,10000) g CROSS JOIN generate_series(1,4) i`, [key(11), key(21), key(31)]);
      await fixture.client.query('ANALYZE kassa.cash_snapshot_1; ANALYZE kassa.cash_snapshot_6; ANALYZE kassa.cash_publication_bindings');
      const catalog = require('../lib/persistence/postgresql/sales/cash-customer-search').CATALOG;
      for (const statement of [customer, assigned]) {
        const entry = catalog.find(entry => entry.statement === statement);
        const values = entry.parameterBindings.map(binding => defaults[binding.parameter]);
        const report = (await fixture.client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + entry.sql, values)).rows[0]['QUERY PLAN'][0];
        const nodes = [], visit = node => { nodes.push(node); for (const child of node.Plans || []) visit(child); };
        visit(report.Plan);
        const headScan = nodes.find(node => node['Relation Name'] === head.sqlName && node['Index Name'] === head.sqlName + '_customer_key');
        const detailScan = nodes.find(node => node['Relation Name'] === line.sqlName && node['Index Cond']?.includes('parent_row'));
        assert.ok(headScan?.['Index Cond']?.includes('customer_key'), 'receipt heads must be selected by the customer key index');
        assert.ok(detailScan, 'positions must be looked up by the selected receipt parent');
        assert.ok(nodes.every(node => node['Relation Name'] !== line.sqlName || node['Node Type'] !== 'Seq Scan'), 'customer search must not scan the detail population');
        assert.equal(report.Plan['Actual Rows'], 4);
        t.diagnostic('CUSTOMER_SEARCH_PLAN ' + JSON.stringify({ statement: statement.id, synthetic: true, unrelatedHeads: 10000,
          unrelatedPositions: 40000, headIndex: headScan['Index Name'], positionIndex: detailScan['Index Name'],
          returnedRows: report.Plan['Actual Rows'], executionMs: report['Execution Time'] }));
      }
    });
  });
