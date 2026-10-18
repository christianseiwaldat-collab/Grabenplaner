'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { createRequire } = require('node:module');
const catalogFile = path.resolve(__dirname, '../lib/persistence/postgresql/core/catalog.js');
const catalogRequire = createRequire(catalogFile), core = catalogRequire('./catalog');
const { SQLITE_APPLICATION_CATALOG } = catalogRequire('../../sqlite/application-catalog');
const baseline = catalogRequire('../contracts/block-4-catalog.json');
const extension = catalogRequire('../contracts/authentication-catalog-v1.json');
const AUTH_IDS = Object.freeze([
  'portal-access.employee-login.failure', 'portal-access.organization-login.failure',
  'portal-access.employee-login.success', 'portal-access.organization-login.success',
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const qualified = core.createCoreCatalog();
const compiled = qualified.entries.map((providerEntry, index) => ({ providerEntry, provenance: qualified.provenance[index] }));
const copyCompiled = () => compiled.map(entry => ({ providerEntry: { ...entry.providerEntry }, provenance: { ...entry.provenance } }));
const qualificationError = /drift; explicit qualification required/;
function isolatedCatalog({ sourceEntries = SQLITE_APPLICATION_CATALOG, reviewedExtension = extension } = {}) {
  const context = { module: { exports: {} }, __dirname: path.dirname(catalogFile), require(id) {
    if (id === '../../sqlite/application-catalog') return { SQLITE_APPLICATION_CATALOG: sourceEntries };
    if (id === '../contracts/authentication-catalog-v1.json') return reviewedExtension;
    return catalogRequire(id);
  } };
  vm.runInNewContext(fs.readFileSync(catalogFile, 'utf8'), context, { filename: catalogFile });
  return context.module.exports;
}

test('authentication qualifies exactly four statements against unchanged historical locks and schema', () => {
  assert.deepEqual(extension.entries.map(entry => entry.statementId).sort(), [...AUTH_IDS].sort());
  assert.equal(extension.entries.length, 4);
  assert.equal(sha(JSON.stringify(catalogRequire('../contracts/block-1-inventory.json'))), 'fee930837cc7b3f4bdb36ad644e5a31c95364c7d9f5c94c2eb3854382042ad5f');
  assert.equal(sha(JSON.stringify(baseline)), '2088f71213db7d595d3c900aa944b21e236aa31c3c8f910a6c06d9997359ed70');
  assert.equal(extension.baseSchemaPlanSha256, catalogRequire('./schema').createSchemaPlan().digest);
  assert.equal(extension.productActivation, false);
  for (const receipt of extension.entries) {
    const old = baseline.entries.find(entry => entry.statementId === receipt.statementId);
    const current = compiled.find(entry => entry.provenance.statementId === receipt.statementId);
    assert.equal(receipt.baseSourceContract, old.sourceContract);
    assert.equal(receipt.baseSqlSha256, old.sqlSha256);
    assert.equal(receipt.sourceContract, current.provenance.sourceContract);
    assert.equal(receipt.sqlSha256, sha(current.providerEntry.sql));
    assert.equal(receipt.parameterBindingsSha256, sha(JSON.stringify(current.providerEntry.parameterBindings)));
    assert.equal(receipt.parameterOrderSha256, sha(JSON.stringify(current.providerEntry.parameterOrder)));
  }
});

test('authentication binds thresholds as integers and credential, clock and lock fields as text', () => {
  for (const id of AUTH_IDS) {
    const entry = qualified.entries.find(item => item.statement.id === id);
    const expected = id.endsWith('.failure') ? { maximum: 'bigint', lockedUntil: 'text', expectedPasswordHash: 'text', now: 'text' }
      : { expectedPasswordHash: 'text', now: 'text' };
    for (const [field, type] of Object.entries(expected)) {
      const matches = entry.parameterBindings.map((binding, index) => ({ binding, index }))
        .filter(({ binding }) => binding.parameter === 'payload' && binding.source === 'json-extract' && binding.path.join('.') === field);
      assert.equal(matches.length, 1, `${id}.${field}`);
      assert.match(entry.sql, new RegExp(`\\$${matches[0].index + 1}\\s*::\\s*${type}\\b`), `${id}.${field}`);
    }
    assert.equal(entry.parameterBindings.some(binding => binding.path.includes('attempts')), false, id);
    assert.match(entry.sql, /AND password_hash =/);
    assert.match(entry.sql, /AND active = 1/);
    assert.match(entry.sql, /locked_until IS NULL OR locked_until <=/);
    if (id.includes('employee-login')) assert.match(entry.sql, /EXISTS \( SELECT 1 FROM employees/);
  }
});

test('each authentication source SQL change fails before compilation and cannot admit unrelated statements', () => {
  const other = qualified.entries.find(entry => !AUTH_IDS.includes(entry.statement.id)).statement.id;
  for (const id of [...AUTH_IDS, other]) {
    const changed = SQLITE_APPLICATION_CATALOG.map(entry => entry.statement.id === id ? { ...entry, sql: entry.sql + '\n-- unreviewed' } : entry);
    assert.throws(() => isolatedCatalog({ sourceEntries: changed }).sourceEntries(), /Core source catalog drift/);
  }
});

test('authentication rejects altered compiled SQL, identity and provenance receipts', () => {
  for (const id of AUTH_IDS) for (const mutate of [
    entry => { entry.providerEntry.sql += ' AND false'; },
    entry => { entry.providerEntry.statement = { ...entry.providerEntry.statement, id: 'unreviewed.statement' }; },
    entry => { entry.provenance.sourceContract = '0'.repeat(64); },
    entry => { entry.provenance.sqlSha256 = '0'.repeat(64); },
  ]) {
    const changed = copyCompiled(); mutate(changed.find(entry => entry.provenance.statementId === id));
    assert.throws(() => core.assertCoreCatalogLock(changed, baseline), qualificationError, id);
  }
});

test('authentication rejects swapped payload bindings and changed parameter order even with unchanged SQL', () => {
  for (const id of AUTH_IDS) for (const mutate of [
    entry => { entry.providerEntry.parameterBindings = [...entry.providerEntry.parameterBindings].reverse(); },
    entry => { entry.providerEntry.parameterBindings = entry.providerEntry.parameterBindings.map((binding, index) => index ? binding : { ...binding, path: ['forged'] }); },
    entry => { entry.providerEntry.parameterOrder = ['forged']; },
  ]) {
    const changed = copyCompiled(); mutate(changed.find(entry => entry.provenance.statementId === id));
    assert.throws(() => core.assertCoreCatalogLock(changed, baseline), qualificationError, id);
  }
});

test('each authentication extension anchor remains bound to reviewed source, SQL and parameters', () => {
  for (const id of AUTH_IDS) for (const field of ['sourceContract', 'sqlSha256', 'baseSourceContract', 'baseSqlSha256', 'parameterBindingsSha256', 'parameterOrderSha256']) {
    const changed = structuredClone(extension); changed.entries.find(entry => entry.statementId === id)[field] = '0'.repeat(64);
    assert.throws(() => isolatedCatalog({ reviewedExtension: changed }).assertCoreCatalogLock(compiled, baseline), qualificationError, `${id}.${field}`);
  }
});

test('authentication extension rejects changed metadata, unrelated IDs, duplicates and missing statements', () => {
  for (const mutate of [
    value => { value.version = 2; }, value => { value.scope = 'unreviewed'; },
    value => { value.baseCatalog = 'other.json'; }, value => { value.baseSchemaPlanSha256 = '0'.repeat(64); },
    value => { value.productActivation = true; }, value => { value.entries.pop(); },
    value => { value.entries.push({ ...value.entries[0] }); },
    value => { value.entries[0].statementId = 'unreviewed.statement'; },
    value => { value.entries[0].statementId = value.entries[1].statementId; },
  ]) {
    const changed = structuredClone(extension); mutate(changed);
    assert.throws(() => isolatedCatalog({ reviewedExtension: changed }).assertCoreCatalogLock(compiled, baseline), qualificationError);
  }
});

test('authentication extension cannot rewrite its historical source or SQL anchors', () => {
  for (const id of AUTH_IDS) for (const field of ['sourceContract', 'sqlSha256']) {
    const changed = structuredClone(baseline); changed.entries.find(entry => entry.statementId === id)[field] = '0'.repeat(64);
    assert.throws(() => core.assertCoreCatalogLock(compiled, changed), qualificationError, `${id}.${field}`);
  }
});
