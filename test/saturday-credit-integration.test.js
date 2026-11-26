"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { SQLITE_SATURDAY_CREDIT_CATALOG } = require('../lib/persistence/sqlite/saturday-credit-catalog');
const { ensureSqliteSaturdayCreditSchema } = require('../lib/persistence/sqlite/operations/saturday-credit-schema');
const { createSaturdayCreditService } = require('../lib/persistence/repositories/saturday-credit');
const { compilePostgresqlDialectEntry } = require('../lib/persistence/postgresql/dialect-compiler');
const input = { employeeNumber: '419', workDate: '2026-09-12', source: 'actual',
  segments: [{ startMinute: 600, endMinute: 750, workClassification: 'normal' }, { startMinute: 780, endMinute: 1020, workClassification: 'normal' }],
  dayComplete: true, breaksResolved: true, publicHoliday: false,
  legacy: { workedMinutes: 390, saturdayBonusMinutes: 120, valuedMinutes: 510 } };
test('Saturday credit persistence retains portable bound statements', () => {
  for (const entry of SQLITE_SATURDAY_CREDIT_CATALOG) assert.ok(compilePostgresqlDialectEntry(entry));
});
