"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { Module } = require("node:module");
const { createPersistenceProviderFacade, definePersistenceStatement } = require("../lib/persistence/contract");
const { POSTGRESQL_CAPABILITIES: capabilities } = require("../lib/persistence/postgresql/provider");
const { createAbsenceManagementRepository } = require("../lib/persistence/repositories/absence-management");
const { pendingVacationForRange } = require("../lib/persistence/statements/emma-absence-requests");

// Exercise the actual two-database routing/coordinator and native repository.
// Only transport/storage is synthetic here. The guarded HTTP PostgreSQL suite
// additionally proves the complete deferred app and real SQL schedule projection.
async function fixture() {
  const row = { id: 7, employee_number: "synthetic-self", date_from: "2031-04-08", date_to: "2031-04-10" };
  const state = { allowed: true, reads: [], commits: 0, rollbacks: 0, authorizations: [] };
  const core = createPersistenceProviderFacade({ providerId: "postgresql", capabilities,
    query: async () => { throw Error("The boundary must own the read transaction"); },
    execute: async () => { throw Error("The projection must not write"); }, close: async () => {},
    async beginTransaction(options) {
      assert.equal(options.readOnly, true);
      return { query: async (statement, parameters) => {
        assert.equal(statement, pendingVacationForRange);
        state.reads.push(parameters); return [{ data: row }];
      }, execute: async () => { throw Error("The projection must not write"); },
      commit: async () => { state.commits++; }, rollback: async () => { state.rollbacks++; } };
    } });
  const filename = path.resolve(__dirname, "../lib/persistence/postgresql/boundary/application.js");
  const subject = new Module(filename, module); subject.filename = filename; subject.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = subject.require.bind(subject);
  subject.require = id => id === "pg" ? { Pool: class { on() {} async end() {} } }
    : id === "../core/environment" ? { PROFILE: "synthetic-only", configuration: () => ({}), verifyEnvironment: async () => {} }
      : id === "../core/application" ? { openCoreDevelopmentApplication: async () => ({ provider: core, close: () => core.close() }) }
        : id === "../sales/application" ? { openSalesDevelopmentApplication: async () => ({
          provider: { transaction: async () => { throw Error("The Core projection must not reach Sales"); } }, close: async () => {},
        }) } : realRequire(id);
  subject._compile(fs.readFileSync(filename, "utf8"), filename);
  const app = await subject.exports.openTwoDatabaseDevelopmentApplication({ coreUrl: "synthetic-core", salesUrl: "synthetic-sales", stage: 8,
    authorize: async value => { state.authorizations.push(value); return state.allowed; } });
  return { row, state, app, repository: createAbsenceManagementRepository(app.provider) };
}

test("pending vacation schedule projection reaches its qualified Core owner through the real boundary", async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const period = { dateFrom: "2031-04-07", dateTo: "2031-04-13" };
  assert.deepEqual(await f.repository.pendingVacationForRange(period), [f.row]);
  assert.deepEqual(f.state.reads, [period]); assert.equal(f.state.commits, 1);
  assert.deepEqual(f.state.authorizations, [{ statementIds: [pendingVacationForRange.id], readOnly: true }]);
  const unknown = definePersistenceStatement({ id: "emma-absence-requests.unqualified-read", operation: "queryAll", parameters: {}, columns: { data: "json" } });
  await assert.rejects(f.app.provider.queryAll(unknown, {}));
  await assert.rejects(f.app.provider.execute(pendingVacationForRange, period), { code: "PERSISTENCE_STATEMENT_INVALID" });
  assert.equal(f.state.reads.length, 1); assert.equal(f.state.commits, 1);
});

test("pending vacation boundary read preserves the final authorization check", async t => {
  const f = await fixture(); t.after(() => f.app.close()); f.state.allowed = false;
  await assert.rejects(f.repository.pendingVacationForRange({ dateFrom: "2031-04-07", dateTo: "2031-04-13" }));
  assert.equal(f.state.reads.length, 1); assert.equal(f.state.commits, 0); assert.equal(f.state.rollbacks, 1);
});
