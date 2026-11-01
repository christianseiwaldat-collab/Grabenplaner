'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const employment = require('../lib/schedule-employment');
const { createPersistenceProviderFacade } = require('../lib/persistence/contract');
const { POSTGRESQL_CAPABILITIES: capabilities } = require('../lib/persistence/postgresql/provider');
const { createWorkRuleStoreRepository } = require('../lib/persistence/repositories/work-rule-store');
const { WORK_RULE_STORE_STATEMENTS: W } = require('../lib/persistence/statements/work-rule-store');
const { SQLITE_PLANNING_SETTINGS_CATALOG: planningCatalog } = require('../lib/persistence/catalogs/planning-settings-catalog');
const { addDays, mondayOfWeek } = require('../lib/work-rules/calendar');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fn(name) {
  const from = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')), to = source.indexOf('\n}', from);
  assert(from >= 0 && to > from, name); return source.slice(from, to + 2);
}
function route(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, start); return source.slice(from, to);
}
const team = [{ personnel_number: '434', nickname: 'Synthetic entry', home_location_id: '18', fixed_workdays: '', contracted_hours: 4 }];
function shiftDto(statementId, rows) {
  const sql = planningCatalog.find(item => item.statement.id === statementId)?.sql;
  assert.ok(sql, statementId);
  const fields = [...sql.match(/SELECT json_object\(([\s\S]*?)\) AS data/)[1].matchAll(/'([a-z_]+)',/g)].map(match => match[1]);
  return rows.map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? null])));
}

test('entry is inclusive, missing dates remain compatible and only week-relative eligibility is public', () => {
  const starts = new Map([['434', '2026-10-12']]);
  assert.equal(employment.employmentProjection(team, '2026-10-05', '2026-10-11', starts).employees.length, 0);
  const first = employment.employmentProjection(team, '2026-10-12', '2026-10-18', starts);
  assert.equal(first.employees[0].planningDates.length, 7);
  assert.equal(first.allows('434', '2026-10-12'), true);
  assert.equal(first.allows('434', '2026-10-11'), false);
  assert(!JSON.stringify(first.employees).includes('startDate'));
  assert.equal(employment.employmentProjection(team, '2026-10-05', '2026-10-11', new Map()).employees[0].planningDates.length, 7);
  assert.throws(() => employment.assertEmploymentDate('2026-10-12', '2026-10-11'), e => e.code === 'SHIFT_BEFORE_EMPLOYMENT');
  assert.doesNotThrow(() => employment.assertEmploymentDate('2026-10-12', '2026-10-12'));
  assert.doesNotThrow(() => employment.assertEmploymentDate('', '2020-01-01'));
  assert.throws(() => employment.assertEmploymentDate('2026-02-30', '2026-10-12'), e => e.code === 'SCHEDULE_EMPLOYMENT_UNAVAILABLE');
});

test('partial entry week clips shifts and spanning options without changing retained source history', () => {
  const projection = employment.employmentProjection(team, '2026-10-12', '2026-10-18', new Map([['434', '2026-10-14']]));
  const shifts = [{ id: 1, employee_number: '434', shift_date: '2026-10-13' }, { id: 2, employee_number: '434', shift_date: '2026-10-14' }];
  const options = [{ employee_number: '434', date_from: '2026-10-01', date_to: '2026-10-31', note: 'Synthetic retained' }];
  const before = structuredClone({ shifts, options, team });
  assert.deepEqual(projection.clip(shifts).map(row => row.id), [2]);
  assert.equal(projection.clip(options)[0].date_from, '2026-10-14');
  assert.equal(projection.clip(options)[0].date_to, '2026-10-31');
  assert.equal(projection.clip([{ ...options[0], date_to: '2026-10-13' }]).length, 0);
  assert.equal(projection.eligibleOnDate('434', '2026-10-01'), false);
  assert.deepEqual({ shifts, options, team }, before);
});

async function fixture(t) {
  const app = express(); app.use(express.json());
  const state = { start: '2026-10-14', atCommit: null, profiles: [], shifts: [], evaluations: [], transactions: 0, next: 1,
    planningReads: [], deletedShiftIds: [] };
  const organization = { marker: 'outside', getPersonnelSensitiveRecord: async () => null }, boundOrganization = { marker: 'transaction' };
  // Keep the actual delete-ID contract: a permissive memory stub previously
  // concealed that the qualified auto-planning DTO intentionally has no id.
  const deleteProvider = createPersistenceProviderFacade({ providerId: 'postgresql', capabilities,
    query: async () => { throw Error('Unexpected query'); },
    execute: async (statement, parameters) => {
      assert.equal(statement, W.deletePlanningShift);
      state.deletedShiftIds.push(parameters.id);
      const count = state.shifts.length;
      state.shifts = state.shifts.filter(row => Number(row.id) !== parameters.id);
      return { rowsAffected: count - state.shifts.length, returnedRows: [] };
    },
    beginTransaction: async () => { throw Error('Unexpected provider transaction'); }, close: async () => {},
  });
  t.after(() => deleteProvider.close());
  const deleteRepository = createWorkRuleStoreRepository(deleteProvider);
  const workRules = {
    async insertPlanningShift(shift) { const id = state.next++; state.shifts.push({ id, ...plain(shift) }); return { rowsAffected: 1, returnedRows: [{ id }] }; },
    async updatePlanningShift(shift) { state.shifts = state.shifts.map(row => Number(row.id) === Number(shift.id) ? { ...row, ...plain(shift) } : row); return { rowsAffected: 1 }; },
    deletePlanningShift: id => deleteRepository.deletePlanningShift(id),
    async invalidatePlanningDayReview() {}, async invalidatePlanningReviewsForRange() {},
  };
  const all = () => state.shifts.map(row => ({ id: row.id, employee_number: row.employeeNumber || '434',
    shift_date: row.shiftDate, location_id: row.locationId || '18', start_time: row.startTime, end_time: row.endTime,
    department_id: row.departmentId ?? null, duty_code: row.dutyCode || '' }));
  const planningShifts = (statementId, query) => {
    state.planningReads.push({ statementId, query: plain(query) });
    return shiftDto(statementId, all().filter(row => row.location_id === query.locationId
      && row.shift_date >= query.weekStart && row.shift_date <= query.weekEnd
      && (query.departmentId == null || row.department_id === query.departmentId)));
  };
  const register = Object.fromEntries(['post', 'put', 'delete'].map(method => [method, (url, handler) => app[method](url, (...args) => Promise.resolve(handler(...args)))]));
  const context = vm.createContext({ app: register, require: id => id === './lib/schedule-employment' ? employment : require(id),
    console, Set, Map, Object, Array, String, Number, Promise, Math,
    addDays, getMonday: mondayOfWeek,
    personnelSensitiveProfile: async (number, repository) => { state.profiles.push(repository.marker); return { employment: { startDate: state.start } }; },
    organizationPersonnelRepository: organization,
    planningSettingsRepository: {
      getPlanningEmployee: async () => team[0], getOverlappingShift: async () => null,
      getShiftById: async ({ id }) => all().find(row => Number(row.id) === id),
      listAutoPlanningEmployees: async () => team,
      listAutoPlanningShifts: async query => planningShifts('planning-settings.auto-planning.shifts', query),
      listScheduleShifts: async query => planningShifts('planning-settings.schedule.shifts', query),
      listAutoPlanningEmployeeShifts: async () => all(), listAutoPlanningOptions: async () => [], listScheduleLendings: async () => [],
    },
    persistenceProvider: { async transaction(work) {
      state.transactions++; const before = structuredClone(state.shifts);
      if (state.atCommit !== null) state.start = state.atCommit;
      try { return await work({ organizationPersonnel: boundOrganization, workRules }); }
      catch (error) { state.shifts = before; throw error; }
    } },
    createApplicationRepositories: value => value, readPlanningMutation: work => work(),
    employeeLocationLendingOperations: { overlapForShift: async () => null },
    parseFixedWorkdays: () => [], dayKeyForDate: () => 'mon', normalizeDepartmentId: () => null,
    defaultScheduleDutyCode: () => 'general', normalizeLocationId: value => value,
    validateLocationExists: async () => ({}), validateDepartmentExists: async () => ({}),
    isIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value || ''), isTime: value => /^\d{2}:\d{2}$/.test(value || ''),
    settingsForLocation: async () => ({}), assertDateEditable: async () => {}, getGlobalDayBlockForDate: () => null,
    manualPlanningHours: () => ({ start: '07:00', end: '23:00' }),
    dayConfiguration: async () => ({ minStaff: 0, key: 'mon', start: '09:00', end: '17:00' }),
    overlappingWeekOption: async () => null, activeSicknessEmployeeNumbers: async () => new Set(),
    resolvePlanningContext: async input => ({ locationId: input.locationId || '18', departmentId: input.departmentId || null }), assertSessionContextScope() {}, assertShiftEmployeeAssignmentScope: async () => {},
    planningMutationEmployees: async () => team,
    evaluateScheduleWorkRules: async (week, context, employees, change) => { state.evaluations.push(change ? plain(change) : null); return { assessment: { outcome: 'allowed' } }; },
    evaluateBranchSupervisionMutation: async () => ({ after: { issueCount: 0 } }),
    evaluateBranchSupervisionShiftUpdate: async () => ({}), assertWorkRuleAssessmentAllowsMutation() {}, assertBranchSupervisionAllowsMutation() {}, assertBranchSupervisionComplete() {},
    createPlanningWorkRuleEvaluator: () => async () => ({ assessment: {} }), evaluateWorkRuleChanges: async () => [], absenceManagementRepository: {},
    recordEvaluatedWorkRuleEvaluation: async () => null, staffAssignmentShiftConstraintError: error => error,
    refreshPlanningDerivedStateAfterCommit: async () => {}, refreshSicknessStaffingAfterPlanningChange: async () => {}, sessionCanReadWorkRules: () => false,
    assertWeekEditable: async () => {}, getGlobalDayBlocksForRange: () => [], publicHolidaysForRange: () => [],
    getSchedule: async () => ({ employees: team, shifts: all() }), shiftMetrics: async () => ({ counted_minutes: 120 }),
    sicknessCreditsForRange: async () => [], preferredDayCost: () => 0, automaticPlanningWindows: () => [{}],
    operatingHours: async () => ({}), bestAutomaticShiftForWindows: async () => ({ shift: { start_time: '09:00', end_time: '11:00' }, metrics: { counted_minutes: 120 } }),
    formatHours: value => String(value), shiftCoversPeriod: () => false,
  });
  vm.runInContext(['httpError', 'employeeCanWorkOnDate', 'createScheduleSensitiveReader', 'projectScheduleEmployment', 'assertPlanningEmployment', 'runWorkRuleMutationTransaction', 'validateShift'].map(fn).join('\n')
    + '\n' + route('app.post("/api/shifts",', 'app.delete("/api/shifts/:id",')
    + '\n' + route('app.delete("/api/schedule",', 'function requestCreatesTeamMeetingGroup(')
    + '\n' + route('app.post("/api/schedule/auto",', 'app.get("/api/portal/v1/product-readiness",'), context);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ code: error.code, error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (url, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const shift = date => ({ employeeNumber: '434', locationId: '18', date, startTime: '09:00', endTime: '11:00' });
  return { state, context, request, shift, rows: all };
}

test('actual shift HTTP handlers reject pre-entry creation and moves, allow entry day and recheck changed protected dates at commit', async t => {
  const f = await fixture(t);
  const early = await f.request('/api/shifts', f.shift('2026-10-13'));
  assert.equal(early.status, 409); assert.equal(early.body.code, 'SHIFT_BEFORE_EMPLOYMENT');
  assert.equal(f.state.shifts.length, 0); assert.equal(f.state.transactions, 0);
  const current = await f.request('/api/shifts', f.shift('2026-10-14'));
  assert.equal(current.status, 201, JSON.stringify(current)); assert.equal(f.state.shifts.length, 1);
  assert(f.state.profiles.includes('transaction'));
  const moved = await f.request(`/api/shifts/${current.body.id}`, f.shift('2026-10-13'), 'PUT');
  assert.equal(moved.status, 409); assert.equal(f.state.shifts[0].shiftDate, '2026-10-14');
  f.state.atCommit = '2026-10-16';
  const changed = await f.request('/api/shifts', f.shift('2026-10-15'));
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'SHIFT_BEFORE_EMPLOYMENT');
  assert.equal(f.state.shifts.length, 1, 'a changed protected entry basis must prevent the write');
});

test('actual classic auto planner skips pre-entry days, preserves hidden historical rows and rolls back stale batches', async t => {
  const f = await fixture(t);
  f.state.shifts.push({ id: 90, employeeNumber: '434', shiftDate: '2026-10-12', startTime: '09:00', endTime: '10:00' });
  f.state.shifts.push({ id: 91, employeeNumber: '434', shiftDate: '2026-10-14', startTime: '09:00', endTime: '10:00' });
  const result = await f.request('/api/schedule/auto', { weekStart: '2026-10-12', locationId: '18', replaceExisting: true });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.created, 2);
  assert.deepEqual(f.state.evaluations[0].deletedShiftIds, [91]);
  assert.deepEqual(f.state.deletedShiftIds, [91]);
  assert.deepEqual(f.state.planningReads, [{ statementId: 'planning-settings.schedule.shifts', query: {
    weekStart: '2026-10-12', weekEnd: '2026-10-18', locationId: '18', departmentId: null,
  } }]);
  assert.equal(f.state.evaluations[0].replaceRange, undefined, 'preview must retain the same pre-entry history as the commit');
  assert(f.state.shifts.some(row => row.id === 90), 'replace retains the original pre-entry record');
  assert(f.state.shifts.filter(row => row.id !== 90).every(row => row.shiftDate >= '2026-10-14'));
  const before = structuredClone(f.state.shifts); f.state.atCommit = '2026-10-19';
  const stale = await f.request('/api/schedule/auto', { weekStart: '2026-10-12', locationId: '18', replaceExisting: true });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'SHIFT_BEFORE_EMPLOYMENT');
  assert.deepEqual(f.state.shifts, before, 'no removal or partial assignment may survive changed entry data');
});

test('the ID-bearing qualified schedule read retains the exact auto-planning location, department and date predicates', () => {
  const ids = ['planning-settings.auto-planning.shifts', 'planning-settings.schedule.shifts'];
  const scopedWhere = ids.map(id => planningCatalog.find(item => item.statement.id === id).sql
    .split('WHERE ')[1].split('ORDER BY')[0].replaceAll('s.', '').replace(/\s+/g, ''));
  assert.equal(scopedWhere[1], scopedWhere[0]);
  const row = { id: 91, employee_number: '434', shift_date: '2026-10-14' };
  assert.equal(Object.hasOwn(shiftDto(ids[0], [row])[0], 'id'), false, 'The legacy lightweight projection must not invent an ID');
  assert.equal(shiftDto(ids[1], [row])[0].id, 91);
});

test('classic auto replacement deletes only qualified visible IDs and preserves foreign, department and pre-entry history', async t => {
  for (const departmentId of [null, 7]) await t.test(departmentId == null ? 'whole branch' : 'explicit department', async t => {
    const f = await fixture(t);
    const stored = (id, shiftDate, extra = {}) => ({ id, employeeNumber: '434', shiftDate,
      startTime: '09:00', endTime: '10:00', locationId: '18', departmentId: 7, ...extra });
    f.state.shifts.push(stored(90, '2026-10-12'), stored(91, '2026-10-14'),
      stored(92, '2026-10-15', { departmentId: 8 }), stored(93, '2026-10-16', { departmentId: null }),
      stored(94, '2026-10-17', { locationId: '11' }), stored(95, '2026-10-19'),
      stored(96, '2026-10-14', { employeeNumber: '999' }));
    const original = structuredClone(f.state.shifts);
    const expected = departmentId == null ? [91, 92, 93] : [91];
    const response = await f.request('/api/schedule/auto', {
      weekStart: '2026-10-12', locationId: '18', departmentId, replaceExisting: true,
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.deepEqual(f.state.evaluations[0].deletedShiftIds, expected);
    assert.deepEqual(f.state.deletedShiftIds, expected, 'Preview and actual repository deletion must use the same persistent IDs');
    for (const row of original.filter(row => !expected.includes(row.id))) {
      assert.deepEqual(f.state.shifts.find(saved => saved.id === row.id), row, `Stored history ${row.id} remains byte-for-byte unchanged`);
    }
    assert.deepEqual(f.state.planningReads[0].query, {
      weekStart: '2026-10-12', weekEnd: '2026-10-18', locationId: '18', departmentId,
    });
  });
});

test('clearing the visible week preserves pre-entry history and binds its evaluation to the exact deleted IDs', async t => {
  const f = await fixture(t);
  f.state.shifts.push({ id: 90, employeeNumber: '434', shiftDate: '2026-10-12', startTime: '09:00', endTime: '10:00' },
    { id: 91, employeeNumber: '434', shiftDate: '2026-10-14', startTime: '09:00', endTime: '10:00' });
  f.context.getSchedule = async () => {
    const p = await f.context.projectScheduleEmployment(team, '2026-10-12', '2026-10-18');
    return { employees: p.employees, shifts: p.clip(f.rows()) };
  };
  const cleared = await f.request('/api/schedule?week=2026-10-12&locationId=18', {}, 'DELETE');
  assert.equal(cleared.status, 200, JSON.stringify(cleared)); assert.equal(cleared.body.deleted, 1);
  assert.deepEqual(f.state.shifts.map(row => row.id), [90]);
  assert.deepEqual(f.state.evaluations[0].deletedShiftIds, [91]); assert.equal(f.state.evaluations[0].replaceRange, undefined);
});

test('actual schedule read model excludes pre-entry work, credits and actual-day totals while retaining only planning dates', async t => {
  const f = await fixture(t), before = { id: 1, employee_number: '434', shift_date: '2026-10-12', start_time: '09:00', end_time: '10:00', location_id: '18' },
    after = { ...before, id: 2, shift_date: '2026-10-14' };
  const snapshot = structuredClone([before, after]);
  Object.assign(f.context, {
    normalizeTargetWorkdays: () => 5, preferredDaysOff: () => [],
    applyScopedPdfSettings: value => value, pastWeekEditingAllowedForActor: async () => true,
    getLocationsForSession: async () => [], getScheduleNote: async () => null,
    getGlobalDayBlocksForRange: () => [{ block_date: '2026-10-13', is_public_holiday: true }],
    timeTrackingRepository: {
      listActiveXoffiWeekRows: async () => [{ employee_number: '434', import_id: 1, use_as_actual: 1, weekly_actual_minutes: 600, weekly_valued_minutes: 700, weekly_surcharge_minutes: 100, closing_balance_minutes: 99 }],
      listActiveXoffiWeekDays: async () => [{ employee_number: '434', import_id: 1, work_date: '2026-10-12', actual_minutes: 540, valued_minutes: 630, surcharge_minutes: 90 },
        { employee_number: '434', import_id: 1, work_date: '2026-10-14', actual_minutes: 60, valued_minutes: 70, surcharge_minutes: 10 }],
      listLatestXoffiBalances: async () => [{ employee_number: '434', balance_week_start: '2026-10-05', closing_balance_minutes: 88 }],
      listXoffiSnapshots: async () => [{ employeeNumber: '434', importId: 1, snapshot: { balanceDate: '2026-10-12', closingBalance: 88 } }],
    },
    saturdayCreditService: { cutover: async () => null },
    absenceManagementRepository: { pendingTimeOffForRange: async () => [] },
    sicknessCreditsForEmployeesInRange: async () => [{ employee_number: '434', date: '2026-10-12', minutes: 30 }, { employee_number: '434', date: '2026-10-15', minutes: 30 }],
    shiftMetrics: async () => ({ counted_minutes: 60, raw_minutes: 60, break_minutes: 0, bonus_minutes: 0 }),
    optionMinutesPerDay: () => 0, optionIsAllDay: () => true, isTeamWideMeetingOption: () => false,
    creditedOptionDatesInRange: () => [], claimCreditedOptionDaysInRange: () => 0, claimEmployeeDate: () => true,
    publicHolidaysForRange: () => [{ date: '2026-10-12' }, { date: '2026-10-16' }], hasNonVacationCreditOnDate: () => false, holidayCreditMinutes: () => 60,
    getScheduleManualLock: async () => null, getIsoWeek: () => 42, currentWeekStart: () => '2026-10-12', isPastWeekStart: () => false,
    settingEnabled: () => false, currentWeekLockPoint: () => '',
  });
  Object.assign(f.context.planningSettingsRepository, {
    listScheduleEmployees: async () => team, listScheduleShifts: async () => [before, after],
    listAutoPlanningEmployeeShifts: async () => [],
    listScheduleWeekOptions: async () => [{ employee_number: '434', date_from: '2026-10-12', date_to: '2026-10-18', option_type: 'other' }],
  });
  vm.runInContext(['serializeEmployee', 'finiteScheduleMinutes', 'scheduleShiftMinuteBasis', 'addScheduleMinutes', 'getSchedule'].map(fn).join('\n'), f.context);
  const result = plain(await f.context.getSchedule('2026-10-12', { locationId: '18' }, null, { fast: true }));
  assert.deepEqual(result.shifts.map(row => row.id), [2]);
  assert.deepEqual(result.employees[0].planningDates, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.equal(result.weekOptions[0].date_from, '2026-10-14');
  assert.equal(result.sicknessCredits.length, 1); assert.equal(result.totals['434'], 150);
  assert.equal(result.xoffiTime.weekByEmployee['434'].actualMinutes, 60);
  assert.equal(result.xoffiTime.weekByEmployee['434'].valuedMinutes, 70);
  assert.equal(result.xoffiTime.weekByEmployee['434'].closingBalanceMinutes, null);
  assert.deepEqual(result.xoffiTime.balanceByEmployee, {}); assert.deepEqual(result.xoffiTime.snapshotByEmployee, {});
  assert(!JSON.stringify(result).includes('startDate'));
  assert.deepEqual([before, after], snapshot, 'read projection must not alter stored historical records');
});

test('actual roster endpoint applies existing branch authority before week eligibility and keeps the general roster unchanged', async t => {
  const f = await fixture(t), reads = []; let handler;
  const outside = { personnel_number: '999', nickname: 'Outside branch', home_location_id: '11' };
  Object.assign(f.context, {
    readModelResponse: work => work,
    refreshApplicationSettingsSnapshot: async () => {},
    createPersonnelProfileRosterAccess: () => ({ canReadSubject: () => false }), installationFeatureEnabled: () => true,
    serializeEmployee: row => ({ ...row }), sessionCanViewTimeConfirmationLevel: () => false, sessionCanManageTimeConfirmationLevel: () => false,
    publicPortalAccessProfileForEmployee: async () => ({}), sessionHasGlobalScope: () => false,
    personnelDisplayProfile: async () => ({}),
    personnelSensitiveProfile: async number => { reads.push(number); return { employment: { startDate: '2026-10-14' }, privateEmail: 'never-export@example.invalid' }; },
  });
  f.context.app.get = (url, work) => { assert.equal(url, '/api/employees'); handler = work; };
  f.context.organizationPersonnelRepository.listEmployees = async () => [...team, outside];
  vm.runInContext(fn('isIsoDate') + '\n' + route('app.get("/api/employees",', 'async function saturdayLegacySettingsSnapshot()'), f.context);
  const request = query => ({ query, portalSession: { role: 'manager', scopes: [{ locationId: '18' }] } });
  const normal = plain(await handler(request({})));
  assert.equal(normal.length, 1); assert.equal(normal[0].planningDates, undefined); assert.deepEqual(reads, []);
  assert.deepEqual(plain(await handler(request({ planningWeek: '2026-10-05' }))), []);
  assert.deepEqual(reads, ['434'], 'a scoped request must not decrypt another branch employment record');
  const first = plain(await handler(request({ planningWeek: '2026-10-12' })));
  assert.equal(first[0].planningDates[0], '2026-10-14');
  assert(!JSON.stringify(first).includes('startDate')); assert(!JSON.stringify(first).includes('never-export'));
  for (const invalid of ['2026-02-30', ['2026-10-12'], 'not-a-date']) {
    await assert.rejects(handler(request({ planningWeek: invalid })), e => e.code === 'SCHEDULE_EMPLOYMENT_WEEK_INVALID');
  }
});
