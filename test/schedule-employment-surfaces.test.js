'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { employmentProjection } = require('../lib/schedule-employment');
const server = fs.readFileSync(require.resolve('../server'), 'utf8').replaceAll('\r\n', '\n');
function between(start, end) {
  const from = server.indexOf(start), to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start); return server.slice(from, to);
}
const addDays = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
const start = '2026-10-05', end = '2026-10-11', entry = '2026-10-08';
const number = 'synthetic-hire';
const shifts = [6, 8].map(day => ({ employee_number: number, shift_date: '2026-10-0' + day, start_time: '09:00', end_time: '18:00', nickname: 'Synthetic' }));
const options = [{ employee_number: number, date_from: start, date_to: end, all_day: 1, option_type: 'vacation' }];
const projectScheduleEmployment = async (rows, from, to) => employmentProjection(rows, from, to, new Map([[number, entry]]));

test('own portal and mobile schedules exclude old pre-entry shifts and clip a spanning option without leaking dates from the personnel file', async () => {
  // These are the actual qualified mobile-query DTOs: actor identity is part
  // of the WHERE clause and is deliberately absent from every returned row.
  const ownShifts = [6, 8, 9].map((day, index) => Object.freeze({ id: index + 1, shift_date: '2026-10-0' + day,
    start_time: '09:00', end_time: '18:00', area: '', note: '', location_id: 'branch', department_id: null,
    duty_code: '', location_name: 'Synthetic', department_name: null }));
  const ownOptions = [Object.freeze({ id: 7, date_from: start, date_to: end, option_type: 'vacation', note: '',
    all_day: 1, start_time: null, end_time: null })];
  const { SQLITE_PLANNING_SETTINGS_CATALOG: catalog } = require('../lib/persistence/catalogs/planning-settings-catalog');
  for (const [suffix, row] of [['shifts', ownShifts[0]], ['options', ownOptions[0]]]) {
    const sql = catalog.find(item => item.statement.id === `planning-settings.mobile-schedule.${suffix}`).sql;
    const fields = [...sql.match(/SELECT json_object\(([\s\S]*?)\) AS data/)[1].matchAll(/'([a-z_]+)',/g)].map(match => match[1]);
    assert.deepEqual(Object.keys(row), fields, 'The fixture must match the qualified query projection');
    assert.match(sql, /employee_number = json_extract\(\$payload, '\$\.employeeNumber'\)/);
  }
  const context = vm.createContext({ projectScheduleEmployment, addDays, isIsoDate: () => true, getMonday: date => date,
    currentWeekStart: () => start, getIsoWeek: () => 41, publicPortalUser: () => ({ employeeNumber: number }),
    planningSettingsRepository: { listMobileScheduleShifts: async () => ownShifts, listMobileScheduleOptions: async () => ownOptions } });
  vm.runInContext(between('async function mobileSchedulePayload(', 'function portalStatusForSession(') + '\n'
    + between('async function ownPortalSchedule(', 'app.get("/api/portal/v1/me/schedule"'), context);
  const original = JSON.stringify({ ownShifts, ownOptions });
  for (const payload of [await context.mobileSchedulePayload({ employeeNumber: number }, start), await context.ownPortalSchedule({ employeeNumber: number }, start)]) {
    assert.equal(payload.shifts.length, 2); assert.equal(payload.shifts[0].date || payload.shifts[0].shift_date, entry);
    assert.equal(payload.shifts[1].date || payload.shifts[1].shift_date, '2026-10-09');
    assert.equal(payload.options[0].dateFrom || payload.options[0].date_from, entry);
    assert.doesNotMatch(JSON.stringify(payload), /employee_number|_actor|employment|startDate|planningDates|protected_payload/);
    if (payload.shifts[0].shift_date) {
      assert.deepEqual(Object.keys(payload.shifts[0]), Object.keys(ownShifts[1]));
      assert.deepEqual(Object.keys(payload.options[0]), Object.keys(ownOptions[0]));
    } else {
      assert.deepEqual(Object.keys(payload.shifts[0]), ['id', 'date', 'startTime', 'endTime', 'area', 'note', 'locationId', 'locationName', 'departmentId', 'departmentName', 'dutyCode']);
      assert.deepEqual(Object.keys(payload.options[0]), ['id', 'dateFrom', 'dateTo', 'type', 'note', 'allDay', 'startTime', 'endTime']);
    }
  }
  assert.equal(JSON.stringify({ ownShifts, ownOptions }), original);
});

test('own schedule projections bind each session actor separately and retain the original ID-free response shape', async () => {
  const actors = ['early-hire', 'later-hire', 'future-hire'];
  const starts = new Map([[actors[0], ''], [actors[1], entry], [actors[2], '2026-10-12']]);
  const calls = [], sources = new Map(actors.map((actor, index) => [actor, {
    shifts: Object.freeze([6, 8, 9].map(day => Object.freeze({ id: index * 10 + day, shift_date: `2026-10-0${day}`, note: actor }))),
    options: Object.freeze([Object.freeze({ id: index, date_from: start, date_to: end, option_type: 'vacation', note: actor })]),
  }]));
  const before = JSON.stringify([...sources]);
  const context = vm.createContext({ addDays, isIsoDate: () => true, getMonday: date => date,
    currentWeekStart: () => start, getIsoWeek: () => 41, publicPortalUser: session => ({ employeeNumber: session.employeeNumber }),
    projectScheduleEmployment: async (rows, from, to) => employmentProjection(rows, from, to, starts),
    planningSettingsRepository: Object.fromEntries([['listMobileScheduleShifts', 'shifts'], ['listMobileScheduleOptions', 'options']]
      .map(([method, field]) => [method, async query => { calls.push({ ...query }); return sources.get(query.employeeNumber)[field]; }])) });
  vm.runInContext(between('async function mobileSchedulePayload(', 'function portalStatusForSession(') + '\n'
    + between('async function ownPortalSchedule(', 'app.get("/api/portal/v1/me/schedule"'), context);
  for (const method of ['ownPortalSchedule', 'mobileSchedulePayload']) for (const [index, actor] of actors.entries()) {
    const payload = await context[method]({ employeeNumber: actor }, start);
    assert.equal(payload.shifts.length, [3, 2, 0][index]);
    assert.equal(payload.options.length, index === 2 ? 0 : 1);
    assert.ok(payload.shifts.every(row => row.note === actor));
    if (payload.options.length) assert.equal(payload.options[0].date_from || payload.options[0].dateFrom, index === 1 ? entry : start);
    assert.doesNotMatch(JSON.stringify(payload), /employee_number|_actor|planningDates|startDate|protected_payload/);
    assert.deepEqual(calls.slice(-2).map(query => query.employeeNumber), [actor, actor]);
    assert.ok(calls.slice(-2).every(query => query.weekStart === start && query.weekEnd === end));
  }
  assert.equal(JSON.stringify([...sources]), before, 'No session projection may mutate the repository rows');
});

test('organization schedule projects source IDs internally but never returns the identifiers or HR basis to a terminal', async () => {
  const context = { app: { get: (_path, handler) => { context.route = handler; } }, ORGANIZATION_SCHEDULE_PERMISSION: 'branch_schedule:read',
    requirePortalSession: () => ({ sessionKind: 'organization', homeLocationId: 'branch' }), assertSessionContextScope() {},
    normalizeLocationId: String, validateLocationExists: async () => ({ id: 'branch', name: 'Synthetic' }), getMonday: date => date,
    isIsoDate: () => true, currentWeekStart: () => start, addDays, getIsoWeek: () => 41, projectScheduleEmployment,
    planningSettingsRepository: { listScheduleEmployees: async () => [{ personnel_number: number }],
      listScheduleShifts: async () => [...shifts, { ...shifts[1], employee_number: 'inactive', nickname: 'INACTIVE' }] },
    branchOrderOperations: { branchPortalSettingsSnapshot: async () => ({}) } };
  vm.runInNewContext(between('app.get("/api/portal/v1/location-dashboard/schedule",', '\napp.get('), context);
  let result; await context.route({ query: { week: start } }, { json: value => { result = value; } });
  assert.equal(result.shifts.length, 1); assert.equal(result.shifts[0].date, entry);
  assert.doesNotMatch(JSON.stringify(result), /employee_number|employeeNumber|employment|startDate|planningDates|INACTIVE/);
});

test('cross-location schedule source applies the same day projection before exposing its minimal foreign team', async () => {
  const context = vm.createContext({ addDays, projectScheduleEmployment, crossLocationScheduleEmployeeDepartment: () => 1,
    planningSettingsRepository: { listScheduleEmployees: async () => [{ personnel_number: number, nickname: 'Synthetic', home_location_id: 'branch' }],
      listScheduleShifts: async () => shifts, listScheduleWeekOptions: async () => options, listScheduleLendings: async () => [] } });
  vm.runInContext(between('async function crossLocationScheduleSource(', 'async function crossLocationSchedulePayload('), context);
  const payload = await context.crossLocationScheduleSource({ id: 'branch', name: 'Synthetic', active: true, departments: [] }, start);
  assert.equal(payload.shifts.length, 1); assert.equal(payload.shifts[0].date, entry);
  assert.equal(payload.unavailability[0].dateFrom, entry);
  assert.deepEqual(Array.from(payload.teamMembers[0].planningDates), [entry, '2026-10-09', '2026-10-10', end]);
  assert.doesNotMatch(JSON.stringify(payload), /employment|startDate|protected_payload/);
});

test('PDF projection clips recreated assignments and positions; matrix cells are empty before entry and stored data stays intact', () => {
  const context = vm.createContext({ addDays, collapsedScheduleWeekOptions: value => value, isTeamWideMeetingOption: () => false,
    resolveScheduleDuty: () => ({ code: 'general', label: 'Dienst' }) });
  vm.runInContext(between('function schedulePlanningEmployeeOnDate(', 'function schedulePdfWeekOptions(') + '\n'
    + between('function scheduleMatrixCellData(', 'function scheduleMatrixMeetingText('), context);
  const schedule = { weekStart: start, weekEnd: end, settings: {}, employees: [{ personnel_number: number,
    planningDates: [entry, '2026-10-09', '2026-10-10', end] }], shifts, weekOptions: [] };
  const original = JSON.stringify(schedule);
  const range = context.schedulePdfPlanningRows(schedule, options);
  assert.equal(range[0].date_from, entry); assert.equal(range[0].date_to, end);
  assert.equal(context.schedulePdfPlanningRows(schedule, shifts).length, 1);
  assert.equal(context.scheduleMatrixCellData(schedule, schedule.employees[0], start).lines[0].text, '');
  assert.equal(context.scheduleMatrixCellData(schedule, schedule.employees[0], entry).lines[0].type, 'shift');
  assert.equal(JSON.stringify(schedule), original);
});

test('timeline PDF draws employee names only on their eligible days and keeps the per-day lane alignment', async () => {
  const text = [], shapes = []; let doc;
  const fake = { page: { width: 842, height: 595 } };
  doc = new Proxy(fake, { get(target, key) { if (key in target) return target[key]; return (...args) => {
    if (key === 'text') text.push(args); if (key === 'rect') shapes.push(args); return doc;
  }; } });
  const context = vm.createContext({ addDays, PDFDocument: class { constructor() { return doc; } }, APP_NAME: 'GP', APP_VERSION_LABEL: 'test',
    settingEnabled: () => false, planningDays: [['monday']], timeToMinutes: value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)),
    formatDateGerman: String, contrastColor: () => '#000000', collapsedScheduleWeekOptions: value => value,
    isTeamWideMeetingOption: () => false, operatingHours: async () => ({ start: '09:00', end: '18:00' }),
    dayConfiguration: async () => ({ lunchEnabled: false }), pdfFooterContact: () => '' });
  vm.runInContext(between('function schedulePlanningEmployeeOnDate(', 'function schedulePdfPlanningRows(') + '\n'
    + between('async function drawScheduleTimelinePdf(', '\nconst {\n  buildScheduleMatrixOptionSpans,'), context);
  const schedule = { weekStart: start, weekEnd: end, context: {}, settings: { pdf_title: 'Synthetic', monday_start_time: '09:00', monday_end_time: '18:00' },
    employees: [{ personnel_number: 'existing', nickname: 'EXISTING', color: '#cccccc' },
      { personnel_number: number, nickname: 'NEW-HIRE', color: '#abcdef', planningDates: [entry, '2026-10-09', '2026-10-10', end] }],
    shifts: [{ employee_number: number, shift_date: entry, start_time: '09:00', end_time: '10:00' }], weekOptions: [], globalDayBlocks: [] };
  await context.drawScheduleTimelinePdf(schedule, {});
  const headers = text.filter(call => call[0] === 'NEW-HIRE');
  assert.equal(headers.length, 3, 'Thursday through Saturday only; Sunday is hidden');
  assert.ok(headers[0][1] > 400, 'No name is rendered in the Monday-Wednesday columns');
  const existing = text.filter(call => call[0] === 'EXISTING');
  assert.equal(existing.length, 6);
  assert.ok(Math.abs((existing[0][3].width + 2) / 2 - (existing[3][3].width + 2)) < 0.001, 'The existing lane halves only after the new colleague joins');
  assert.ok(Math.abs(existing[3][1] + existing[3][3].width + 2 - headers[0][1]) < 0.001, 'Thursday name headers occupy adjacent per-day lanes');
  assert.ok(shapes.some(shape => Math.abs(shape[0] - headers[0][1]) < 0.001 && shape[1] > 100 && shape[3] < 50), 'The new colleague\'s shift stays aligned with their own Thursday header');
});
