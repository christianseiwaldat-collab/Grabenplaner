"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPostgresqlSystemHealth } = require('../lib/persistence/postgresql/application-operations/system-health');

function fixture(rows) {
  const closed = [];
  const checked = [];
  return { closed, checked, deps: {
    environment: { configuration: options => options,
      verifyEnvironment: async (_pool, options) => { checked.push([options.domain, options.purpose]); } },
    Pool: class {
      constructor(options) { this.domain = options.domain; }
      async query() { const row = rows[this.domain]; if (row instanceof Error) throw row; return { rows: [row] }; }
      async end() { closed.push(this.domain); }
    },
  } };
}
const config = { readers: { coreUrl: 'core', salesUrl: 'sales' } };
const core = { bytes: '207722175', foreign_keys: 276, invalid_foreign_keys: 0 };
const sales = { bytes: '11578234559', foreign_keys: 0, invalid_foreign_keys: 0 };

test('measures both real databases and checks both reader identities', async () => {
  const f = fixture({ core, sales });
  const result = await readPostgresqlSystemHealth(config, f.deps);
  assert.equal(result.databaseBytes, 11785956734);
  assert.equal(result.foreignKeys, true);
  assert.deepEqual(f.checked, [['core', 'reader'], ['sales', 'reader']]);
  assert.deepEqual(f.closed, ['core', 'sales']);
});
test('invalid constraints fail; absent constraints are unknown', async () => {
  assert.equal((await readPostgresqlSystemHealth(config, fixture({ core: { ...core, invalid_foreign_keys: 1 }, sales }).deps)).foreignKeys, false);
  assert.equal((await readPostgresqlSystemHealth(config, fixture({ core: { ...core, foreign_keys: 0 }, sales }).deps)).foreignKeys, null);
});
test('failed or invalid measurements never report zero bytes or partial success', async () => {
  for (const bad of [new Error('reader unavailable'), { ...sales, bytes: null }, { ...sales, bytes: 'NaN' }]) {
    const f = fixture({ core, sales: bad });
    await assert.rejects(readPostgresqlSystemHealth(config, f.deps));
    assert.deepEqual(f.closed, ['core', 'sales']);
  }
});
