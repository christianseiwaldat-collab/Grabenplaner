'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { Module } = require('node:module');
const { createPersistenceProviderFacade } = require('../lib/persistence/contract');
const { POSTGRESQL_CAPABILITIES: capabilities } = require('../lib/persistence/postgresql/provider');
const { ORGANIZATION_PERSONNEL_STATEMENTS: O } = require('../lib/persistence/statements/organization-personnel');
const { WORK_RULE_STORE_STATEMENTS: W } = require('../lib/persistence/statements/work-rule-store');
const { createApplicationRepositories } = require('../lib/persistence/application-repositories');
const employment = require('../lib/schedule-employment');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function fn(name) {
  const from = server.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')), to = server.indexOf('\n}', from);
  assert(from >= 0 && to > from); return server.slice(from, to + 2);
}

// Execute the real boundary coordinator and repository contracts. Only the
// PostgreSQL transport/storage is synthetic; this is not a native SQL test.
async function fixture() {
  const state = { start: '2026-10-14', shifts: [], events: [], owner: null, waiting: [], blocked: deferred() };
  const data = createPersistenceProviderFacade({ providerId: 'postgresql', capabilities,
    query: async () => { throw Error('A transaction is required'); }, execute: async () => { throw Error('A transaction is required'); }, close: async () => {},
    async beginTransaction() {
      const draft = { start: state.start, shifts: structuredClone(state.shifts) };
      return { query: async statement => {
        assert.equal(statement, O.getPersonnelSensitiveRecord);
        state.events.push('date-read:' + draft.start);
        return [{ employee_number: '434', protected_payload: draft.start, social_security_lookup: '' }];
      }, execute: async (statement, parameters) => {
        if (statement === W.insertPlanningShift) { draft.shifts.push(parameters); state.events.push('shift-insert'); return { rowsAffected: 1, returnedRows: [{ id: draft.shifts.length }] }; }
        assert.equal(statement, O.upsertPersonnelSensitiveRecord);
        draft.start = parameters.protectedPayload; state.events.push('hr-write:' + draft.start); return { rowsAffected: 1, returnedRows: [] };
      }, commit: async () => { state.start = draft.start; state.shifts = draft.shifts; state.events.push('domain-commit'); }, rollback: async () => {} };
    } });
  class Pool {
    on() {} async end() {}
    async connect() {
      const client = { on() {}, release() {}, query: async sql => {
        if (sql === 'SELECT pg_advisory_lock(9261207)') {
          if (state.owner) { const wait = deferred(); state.waiting.push({ client, wait }); state.blocked.resolve(); await wait.promise; }
          state.owner = client; state.events.push('lock');
        } else if (sql === 'SELECT pg_advisory_unlock(9261207)') {
          assert.equal(state.owner, client); state.events.push('unlock'); state.owner = null;
          const next = state.waiting.shift(); if (next) { state.owner = next.client; next.wait.resolve(); }
        }
        return { rows: [], fields: [] };
      } }; return client;
    }
  }
  const filename = path.resolve(__dirname, '../lib/persistence/postgresql/boundary/application.js');
  const subject = new Module(filename, module); subject.filename = filename; subject.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = subject.require.bind(subject);
  subject.require = id => id === 'pg' ? { Pool }
    : id === '../core/environment' ? { PROFILE: 'synthetic-only', configuration: () => ({}), verifyEnvironment: async () => {} }
      : ['../core/application', '../sales/application'].includes(id) ? {
        openCoreDevelopmentApplication: async () => ({ provider: data, close: async () => {} }),
        openSalesDevelopmentApplication: async () => ({ provider: data, close: async () => {} }),
      } : realRequire(id);
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  const open = () => subject.exports.openTwoDatabaseDevelopmentApplication({ coreUrl: 'synthetic-core', salesUrl: 'synthetic-sales', stage: 8, authorize: async () => true });
  const app = await open(), hr = await open();
  const context = vm.createContext({ persistenceProvider: app.provider, createApplicationRepositories,
    organizationPersonnelRepository: createApplicationRepositories(app.provider).organizationPersonnel,
    personnelSensitiveProfile: async (number, repository) => ({ employment: { startDate: (await repository.getPersonnelSensitiveRecord(number)).protected_payload } }),
    require: id => { assert.equal(id, './lib/schedule-employment'); return employment; },
  });
  vm.runInContext(fn('assertPlanningEmployment') + '\n' + fn('runWorkRuleMutationTransaction'), context);
  const shift = { employeeNumber: '434', locationId: '18', departmentId: null, dutyCode: 'general', shiftDate: '2026-10-14', startTime: '09:00', endTime: '10:00', area: '', note: '' };
  const updateHr = tx => createApplicationRepositories(tx).organizationPersonnel.upsertPersonnelSensitiveRecord({ employeeNumber: '434', protectedPayload: '2026-10-16', socialSecurityLookup: '', actor: 'synthetic-hr' });
  return { state, app, hr, context, shift, updateHr, close: async () => { await app.close(); await hr.close(); } };
}

test('real boundary coordinator keeps a concurrent personnel update outside the protected-read-to-shift-insert window', async t => {
  const f = await fixture(); t.after(f.close);
  const read = deferred(), resume = deferred(); let hrCommitted = false;
  const shift = f.context.runWorkRuleMutationTransaction(async (repository, organization) => {
    await f.context.assertPlanningEmployment(f.shift, organization);
    read.resolve(); await resume.promise;
    await repository.insertPlanningShift(f.shift);
  });
  await read.promise;
  const hr = f.hr.provider.transaction(f.updateHr, { isolation: 'serializable' }).then(() => { hrCommitted = true; });
  await f.state.blocked.promise;
  assert.equal(hrCommitted, false); assert.equal(f.state.start, '2026-10-14'); assert.equal(f.state.shifts.length, 0);
  resume.resolve(); await shift; await hr;
  assert(f.state.events.indexOf('shift-insert') < f.state.events.indexOf('hr-write:2026-10-16'));
  assert(f.state.events.indexOf('domain-commit') < f.state.events.indexOf('hr-write:2026-10-16'));
  assert.equal(f.state.shifts.length, 1);
});

test('a personnel update holding the same real boundary lock finishes before the shift guard and prevents the stale assignment', async t => {
  const f = await fixture(); t.after(f.close);
  const written = deferred(), resume = deferred();
  const hr = f.hr.provider.transaction(async tx => { await f.updateHr(tx); written.resolve(); await resume.promise; }, { isolation: 'serializable' });
  await written.promise;
  const shift = f.context.runWorkRuleMutationTransaction(async (repository, organization) => {
    await f.context.assertPlanningEmployment(f.shift, organization);
    await repository.insertPlanningShift(f.shift);
  });
  const rejected = assert.rejects(shift, error => error.code === 'SHIFT_BEFORE_EMPLOYMENT');
  await f.state.blocked.promise;
  resume.resolve(); await hr; await rejected;
  assert.equal(f.state.start, '2026-10-16'); assert.equal(f.state.shifts.length, 0);
  assert(f.state.events.includes('date-read:2026-10-16'));
});
