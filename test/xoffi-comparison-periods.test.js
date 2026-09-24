"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildComparison, combineComparisons, thresholds } = require('../lib/xoffi-plan-comparison');
const limits = thresholds();
const dates = (from, count) => Array.from({ length: count }, (_, i) => {
  const day = new Date(from + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + i); return day.toISOString().slice(0, 10);
});
function week(from, actual = [510, 90, 0, 525, 0, 0, 0], valued = [510, 384, 384, 525, 0, 0, 0]) {
  const days = dates(from, 7);
  return buildComparison({ dates: days, employees: [{ personnel_number: '419', full_name: 'Testperson' }],
    shifts: days.slice(0, 4).map(shift_date => ({ employee_number: '419', shift_date, raw_minutes: 540, break_minutes: 30 })),
    imports: [{ employee_number: '419', import_id: from, imported_at: from + 'T20:00:00Z', use_as_actual: 1 }],
    importDays: days.map((work_date, i) => ({ employee_number: '419', import_id: from, work_date,
      actual_minutes: actual[i], valued_minutes: valued[i], absence_code: i === 1 || i === 2 ? 'sick' : '' })), limits });
}

test('partial sickness is counted once: 1.5 h present plus 4.9 h sickness equals 6.4 h', () => {
  const row = week('2026-09-07')[0];
  assert.equal(row.days[1].presenceComparison.actualMinutes, 90);
  assert.equal(row.days[1].valuedComparison.actualMinutes, 384);
  assert.equal(row.days[2].presenceComparison.actualMinutes, 0);
  assert.equal(row.days[2].valuedComparison.actualMinutes, 384);
  assert.equal(row.valuedComparison.actualMinutes, 1803);
  assert.equal(row.valuedComparison.differenceMinutes, -237);
  assert.equal(row.valuedComparison.severity, 'yellow');
  assert.equal(row.presenceComparison.actualMinutes, 1125);
  assert.equal(row.presenceComparison.differenceMinutes, -915);
});

test('valued plan uses existing shift bonuses; presence excludes bonuses and planning credits', () => {
  const row = buildComparison({ dates: ['2026-09-19'], employees: [{ personnel_number: '419' }],
    shifts: [{ employee_number: '419', shift_date: '2026-09-19', raw_minutes: 300, break_minutes: 0, counted_minutes: 360 }],
    planCredits: [{ employeeNumber: '419', date: '2026-09-19', minutes: 60, label: 'Schulung' }],
    imports: [{ employee_number: '419', import_id: 'one' }],
    importDays: [{ employee_number: '419', import_id: 'one', work_date: '2026-09-19', actual_minutes: 300, valued_minutes: 420 }], limits })[0];
  assert.equal(row.valuedComparison.plannedMinutes, 420);
  assert.equal(row.valuedComparison.differenceMinutes, 0);
  assert.equal(row.presenceComparison.plannedMinutes, 300);
  assert.equal(row.presenceComparison.differenceMinutes, 0);
});

test('a custom period combines multiple imports and clips both boundary weeks', () => {
  const row = combineComparisons([week('2026-09-07'), week('2026-09-14')], dates('2026-09-08', 8), limits)[0];
  assert.equal(row.days.length, 8);
  assert.equal(row.imports.length, 2);
  assert.equal(row.coveredDays, 8);
  assert.equal(row.valuedComparison.actualMinutes, 2187);
  assert.equal(row.actualMinutes, 1215);
  assert.equal(row.plannedMinutes, 2550);
  assert.equal(row.importState, 'complete');
});

test('missing middle weeks remain unknown, not zeros or misleading negative totals', () => {
  const row = combineComparisons([week('2026-09-07'), week('2026-09-21')], dates('2026-09-07', 21), limits)[0];
  assert.equal(row.coveredDays, 14);
  assert.equal(row.totalDays, 21);
  assert.equal(row.importState, 'incomplete');
  assert.equal(row.valuedComparison.actualMinutes, null);
  assert.equal(row.valuedComparison.percent, null);
  assert.equal(row.presenceComparison.actualMinutes, null);
  assert.equal(row.days[7].actualMinutes, null);
  assert.equal(row.days[0].valuedComparison.actualMinutes, 510);
});

test('scope mismatch in any selected week suppresses the period comparison', () => {
  const first = week('2026-09-07'), second = week('2026-09-14');
  second[0].days.forEach(day => { day.scopeMismatch = true; });
  const row = combineComparisons([first, second], dates('2026-09-07', 14), limits)[0];
  assert.equal(row.valuedComparison.severity, 'scope');
  assert.equal(row.presenceComparison.percent, null);
});

const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(name) {
  const start = app.indexOf(`function ${name}(`), end = app.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end + 3);
}
function controls() {
  const context = vm.createContext({});
  vm.runInContext(['toIsoDate', 'getMonday', 'addDays', 'xoffiPeriodRange', 'xoffiShiftedRange', 'xoffiDisplayComparison'].map(extract).join('\n'), context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('period presets and navigation cover leap years, quarters, and custom single days', () => {
  const c = controls();
  assert.deepEqual(plain(c.xoffiPeriodRange('week', '2027-01-01')), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(plain(c.xoffiPeriodRange('month', '2028-02-20')), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(plain(c.xoffiPeriodRange('quarter', '2026-09-24')), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(plain(c.xoffiShiftedRange({ from: '2026-10-01', to: '2026-12-31' }, 'quarter', 1)), { from: '2027-01-01', to: '2027-03-31' });
  assert.deepEqual(plain(c.xoffiShiftedRange({ from: '2026-09-08', to: '2026-09-08' }, 'range', 1)), { from: '2026-09-09', to: '2026-09-09' });
  assert.deepEqual(plain(c.xoffiShiftedRange({ from: '2026-10-24', to: '2026-10-26' }, 'range', 1)), { from: '2026-10-27', to: '2026-10-29' });
});

test('switching views changes totals and deviation without modifying the imported data', () => {
  const c = controls(), row = week('2026-09-07')[0], original = JSON.stringify(row);
  c.xoffiComparisonMode = 'valued';
  assert.equal(c.xoffiDisplayComparison(row).actualMinutes, 1803);
  assert.equal(c.xoffiDisplayComparison(row).differenceMinutes, -237);
  c.xoffiComparisonMode = 'presence';
  assert.equal(c.xoffiDisplayComparison(row).actualMinutes, 1125);
  assert.equal(c.xoffiDisplayComparison(row).differenceMinutes, -915);
  assert.equal(JSON.stringify(row), original);
});

test('a partial month shows the known subtotal with coverage, but no full-period deviation', () => {
  const c = controls(); c.xoffiComparisonMode = 'valued';
  const row = combineComparisons([week('2026-09-07')], dates('2026-09-01', 30), limits)[0];
  const shown = c.xoffiDisplayComparison(row);
  assert.equal(shown.actualMinutes, 1803);
  assert.equal(shown.partial, true);
  assert.equal(shown.coveredDays, 7);
  assert.equal(shown.totalDays, 30);
  assert.equal(shown.differenceMinutes, null);
  assert.equal(shown.percent, null);
  assert.equal(shown.severity, 'missing');
});
