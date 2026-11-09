'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const Issues = require('../lib/sales-report-receipt-issues');
const { CASH_SNAPSHOT_TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { isLoopbackHostname } = require('../lib/persistence/postgresql/policy');

const databaseUrl = String(process.env.TEST_POSTGRESQL_URL || '').trim();
test('native PostgreSQL receipt-issue paging matches SQLite for missing children, null dates and dataset boundaries', {
  skip: databaseUrl ? false : 'TEST_POSTGRESQL_URL is required for the native PostgreSQL qualification',
}, async () => {
  const url = new URL(databaseUrl);
  assert.ok(isLoopbackHostname(url.hostname), 'This synthetic test requires a loopback PostgreSQL server');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /(?:^|_)test(?:_|$)/, 'Use a separately designated test database');
  const schemaName = `gp_receipt_issues_${process.pid}_${randomBytes(6).toString('hex')}`;
  const schema = `"${schemaName}"`;
  const head = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_KASSE').sqlName;
  const line = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_Kasse_Details').sqlName;
  const actualHead = require('../lib/persistence/postgresql/sales/schema').createSalesSchemaPlan(5)
    .statements.find(entry => entry.id === head);
  assert.match(actualHead.sql, /business_date TEXT COLLATE "C"/, 'The fixture must match the real native snapshot date column');
  const db = new DatabaseSync(':memory:');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}."${head}"(dataset_slot INTEGER,source_row INTEGER,business_date TEXT COLLATE "C");
      CREATE TABLE ${schema}."${line}"(dataset_slot INTEGER,parent_row INTEGER);`);
    db.exec(`CREATE TABLE ${head}(dataset_slot INTEGER,source_row INTEGER,business_date TEXT);
      CREATE TABLE ${line}(dataset_slot INTEGER,parent_row INTEGER);`);
    const insert = db.prepare(`INSERT INTO ${head} VALUES(?,?,?)`);
    const fixtures = Array.from({ length: 405 }, (_, index) => [1, index + 1, index < 203 ? '2026-02-01' : null]);
    fixtures.push([1, 406, '2026-01-01'], [2, 1, '2026-02-01']);
    for (const row of fixtures) {
      insert.run(...row);
      await client.query(`INSERT INTO ${schema}."${head}" VALUES($1,$2,$3)`, row);
    }
    const children = [[2, 1], [1, 2], [1, 405]];
    for (const row of children) {
      db.prepare(`INSERT INTO ${line} VALUES(?,?)`).run(...row);
      await client.query(`INSERT INTO ${schema}."${line}" VALUES($1,$2)`, row);
    }
    const compiled = Issues.postgresql()[0];
    assert.ok(compiled.parameterBindings.every(binding => binding.source === 'value'));
    const sql = compiled.sql.replaceAll('kassa.', `${schema}.`);
    assert.notEqual(sql, compiled.sql, 'Only the test-owned schema qualifier is replaced');
    const normalize = row => ({ sourceRow: Number(row.sourceRow), businessDate: row.businessDate instanceof Date
      ? row.businessDate.toISOString().slice(0, 10) : row.businessDate });
    async function readAll(query) {
      const params = { datasetSlot: 1, dateFrom: '2026-02-01', dateTo: '2026-02-28',
        afterDate: '9999-12-31', afterRow: 10000000, limit: 201 };
      const rows = [], pages = [];
      for (;;) {
        const page = (await query(params)).map(normalize);
        pages.push(page.length); rows.push(...page);
        assert.ok(pages.length <= 4, 'The finite fixture must terminate without repeating a cursor');
        if (page.length < params.limit) break;
        params.afterDate = page.at(-1).businessDate; params.afterRow = page.at(-1).sourceRow;
      }
      return { rows, pages };
    }
    const sqlite = await readAll(params => db.prepare(Issues.CATALOG[0].sql).all(params));
    const postgres = await readAll(async params => (await client.query(sql,
      compiled.parameterBindings.map(binding => params[binding.parameter]))).rows);
    assert.deepEqual(postgres, sqlite);
    assert.deepEqual(postgres.pages, [201, 201, 2]);
    assert.equal(postgres.rows.length, 404);
    assert.equal(new Set(postgres.rows.map(row => row.sourceRow)).size, 404);
    assert.equal(postgres.rows.filter(row => row.businessDate === null).length, 202);
    assert.ok(postgres.rows.some(row => row.sourceRow === 1), 'Foreign dataset child must not hide this head');
    assert.ok(!postgres.rows.some(row => row.sourceRow === 2 || row.sourceRow === 406));
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    await pool.end(); db.close();
  }
});
