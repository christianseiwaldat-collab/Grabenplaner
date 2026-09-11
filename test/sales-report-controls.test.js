'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { periodRange, previousYear } = require('../public/sales-report-controls');
test('month, quarter and year shortcuts preserve calendar boundaries and clamp running periods to today', () => {
  assert.deepEqual(periodRange('month', 2024, 2, '2026-09-10'), { from: '2024-02-01', to: '2024-02-29', partial: false });
  assert.deepEqual(periodRange('quarter', 2025, 4, '2026-09-10'), { from: '2025-10-01', to: '2025-12-31', partial: false });
  assert.deepEqual(periodRange('quarter', 2026, 3, '2026-09-10'), { from: '2026-07-01', to: '2026-09-10', partial: true });
  assert.deepEqual(periodRange('year', 2026, 1, '2026-09-10'), { from: '2026-01-01', to: '2026-09-10', partial: true });
  assert.equal(periodRange('month', 2026, 10, '2026-09-10'), null);
  assert.equal(periodRange('quarter', 2026, 5, '2026-09-10'), null);
  assert.equal(periodRange('year', '', 1, '2026-09-10'), null);
  assert.equal(previousYear('2024-02-29'), '2023-02-28');
});
