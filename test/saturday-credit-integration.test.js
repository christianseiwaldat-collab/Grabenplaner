"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_SATURDAY_CREDIT_CATALOG } = require('../lib/persistence/sqlite/saturday-credit-catalog');
const { ensureSqliteSaturdayCreditSchema } = require('../lib/persistence/sqlite/operations/saturday-credit-schema');
const { createSaturdayCreditService } = require('../lib/persistence/repositories/saturday-credit');
const { compilePostgresqlDialectEntry } = require('../lib/persistence/postgresql/dialect-compiler');
async function fixture(t, initialize = true) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_SATURDAY_CREDIT_CATALOG });
  ensureSqliteSaturdayCreditSchema(app.database);
  let tick = 0;
  const service = createSaturdayCreditService({ access: app.provider, today: () => '2026-09-12', clock: () => new Date(Date.UTC(2026, 8, 6, 12, 0, tick++)).toISOString() });
  t.after(async () => { await app.provider.close(); app.database.close(); });
  if (initialize) await service.initialize({ effectiveDate: '2026-09-07', legacySettings: { '*': { enabled: true, from: '13:00', factor: 1.5 } } });
  return { ...app, service };
}
const input = { employeeNumber: '419', workDate: '2026-09-12', source: 'actual',
  segments: [{ startMinute: 600, endMinute: 750, workClassification: 'normal' }, { startMinute: 780, endMinute: 1020, workClassification: 'normal' }],
  dayComplete: true, breaksResolved: true, publicHoliday: false,
  legacy: { workedMinutes: 390, saturdayBonusMinutes: 120, valuedMinutes: 510 } };
test('explicit dated employee sales decision, no guessed positions; old valuations stay unchanged', async t => {
  const { service } = await fixture(t);
  assert.equal((await service.evaluate(input)).saturdayCreditStatus, 'review_required');
  const assignment = await service.assign({ employeeNumber: '419', activity: 'retail_sales', effectiveDate: '2026-09-07', reason: 'Confirmed synthetic sales assignment' }, async () => 'personnel-manager');
  const result = await service.evaluate({ ...input, persist: true });
  assert.equal(result.saturdayBonusMinutes, 120); assert.equal(result.valuedMinutes, 510);
  assert.ok(result.saturdayCreditRecordId);
  assert.deepEqual(await service.evaluate({ ...input, persist: true }), result);
  const before = await service.evaluate({ ...input, workDate: '2026-09-05' });
  assert.equal(before.saturdayCreditStatus, 'legacy'); assert.equal(before.valuedMinutes, 510);
  await assert.rejects(service.assign({ employeeNumber: '419', activity: 'other', effectiveDate: '2026-09-05', reason: 'Wrong backdate', expectedPreviousId: assignment.id }, async () => 'personnel-manager'), e => e.code === 'SATURDAY_CREDIT_BEFORE_CUTOVER');
});
test('assignment changes are immutable, scoped, concurrent-safe and invalidate the later calculation identity', async t => {
  const { service, database } = await fixture(t);
  const assign = { employeeNumber: '419', activity: 'retail_sales', effectiveDate: '2026-09-07', reason: 'Confirmed sales' };
  await assert.rejects(service.assign(assign, async () => null), e => e.status === 403);
  const first = await service.assign(assign, async () => 'manager');
  await assert.rejects(service.assign(assign, async () => 'manager'), e => e.code === 'SATURDAY_CREDIT_CONCURRENT_CHANGE');
  await service.assign({ ...assign, activity: 'other', effectiveDate: '2026-09-14', expectedPreviousId: first.id }, async () => 'manager');
  assert.equal((await service.evaluate(input)).saturdayBonusMinutes, 120);
  assert.equal((await service.evaluate({ ...input, workDate: '2026-09-19' })).saturdayBonusMinutes, 0);
  assert.throws(() => database.prepare('UPDATE saturday_credit_records SET payload=? WHERE id=?').run('{}', first.id), /immutable/);
  assert.throws(() => database.prepare('DELETE FROM saturday_credit_records WHERE id=?').run(first.id), /immutable/);
});
test('open days and unresolved breaks do not create a final credit receipt', async t => {
  const { service } = await fixture(t);
  await service.assign({ employeeNumber: '419', activity: 'retail_sales', effectiveDate: '2026-09-07', reason: 'Confirmed sales' }, async () => 'manager');
  for (const changes of [{ dayComplete: false }, { breaksResolved: false }, { publicHoliday: true }]) {
    const result = await service.evaluate({ ...input, ...changes, persist: true });
    assert.equal(result.saturdayCreditStatus, 'review_required'); assert.equal(result.saturdayCreditRecordId, undefined);
  }
});
test('Saturday credit persistence retains portable bound statements', () => {
  for (const entry of SQLITE_SATURDAY_CREDIT_CATALOG) assert.ok(compilePostgresqlDialectEntry(entry));
});

test('authorized deployment assigns the complete existing workforce atomically and only once', async t => {
  const { service, database } = await fixture(t, false);
  const rollout = { effectiveDate: '2026-09-07', legacySettings: { '*': { enabled: true, from: '13:00', factor: 1.5 } },
    actor: 'authorized-release', existingEmployees: async () => ['419', 'apprentice', 'inactive'] };
  database.exec("CREATE TRIGGER synthetic_rollout_failure BEFORE INSERT ON saturday_credit_records WHEN NEW.employee_number='apprentice' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(service.initialize(rollout));
  assert.equal(database.prepare('SELECT count(*) AS n FROM saturday_credit_records').get().n, 0);
  database.exec('DROP TRIGGER synthetic_rollout_failure');
  const first = await service.initialize(rollout);
  assert.equal(first.initialSalesAssignmentCount, 3);
  for (const number of ['419','apprentice','inactive']) assert.equal((await service.status(number)).assignment.activity, 'retail_sales');
  assert.deepEqual(await service.initialize({ ...rollout, effectiveDate: '2026-09-08', existingEmployees: async () => ['new'] }), first);
  assert.equal((await service.status('new')).assignment, null);
  assert.equal(database.prepare('SELECT count(*) AS n FROM saturday_credit_records').get().n, 4);
});
