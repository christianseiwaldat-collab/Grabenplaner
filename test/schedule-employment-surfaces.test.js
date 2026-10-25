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
  const context = vm.createContext({ projectScheduleEmployment, addDays, isIsoDate: () => true, getMonday: date => date,
    currentWeekStart: () => start, getIsoWeek: () => 41, publicPortalUser: () => ({ employeeNumber: number }),
    planningSettingsRepository: { listMobileScheduleShifts: async () => shifts, listMobileScheduleOptions: async () => options } });
  vm.runInContext(between('async function mobileSchedulePayload(', 'function portalStatusForSession(') + '\n'
    + between('async function ownPortalSchedule(', 'app.get("/api/portal/v1/me/schedule"'), context);
  const original = JSON.stringify({ shifts, options });
  for (const payload of [await context.mobileSchedulePayload({ employeeNumber: number }, start), await context.ownPortalSchedule({ employeeNumber: number }, start)]) {
    assert.equal(payload.shifts.length, 1); assert.equal(payload.shifts[0].date || payload.shifts[0].shift_date, entry);
    assert.equal(payload.options[0].dateFrom || payload.options[0].date_from, entry);
    assert.doesNotMatch(JSON.stringify(payload), /employment|startDate|planningDates|protected_payload/);
  }
  assert.equal(JSON.stringify({ shifts, options }), original);
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
