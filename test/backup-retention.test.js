"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const { planDailyBackups, calendarDay } = require('../lib/backup-retention');
test('twenty calendar dates retain one complete daily point despite repeated restarts', () => {
  const points = Array.from({ length: 40 }, (_, day) => [0, 1, 2].map(hour => ({
    id: `${day}-${hour}`, time: new Date(Date.UTC(2026, 7, day + 1, hour + 12)).toISOString() }))).flat();
  const plan = planDailyBackups(points, { now: '2026-09-09T20:00:00Z' });
  assert.equal(plan.cutoffDay, '2026-08-21'); assert.equal(plan.retainedIds.length, 20);
  assert.equal(plan.removeIds.length, 100); assert.ok(plan.retainedIds.every(id => id.endsWith('-2')));
  assert.equal(new Set([...plan.retainedIds, ...plan.removeIds]).size, points.length);
});
test('missing days do not extend the window; a stopped installation keeps its last complete point', () => {
  const points = [{ id: 'old', time: '2026-07-01T12:00:00Z' }, { id: 'recent', time: '2026-09-05T12:00:00Z' }];
  assert.deepEqual(planDailyBackups(points, { now: '2026-09-06T12:00:00Z' }).retainedIds, ['recent']);
  assert.deepEqual(planDailyBackups(points, { now: '2026-12-06T12:00:00Z' }).retainedIds, ['recent']);
  assert.deepEqual(planDailyBackups([], { now: '2026-09-06T12:00:00Z' }).retainedIds, []);
});
test('Vienna midnight and daylight saving use calendar dates rather than 24-hour buckets', () => {
  assert.equal(calendarDay('2026-09-05T22:30:00Z'), '2026-09-06');
  const points = [{ id: 'summer', time: '2026-10-25T00:30:00Z' }, { id: 'winter', time: '2026-10-25T01:30:00Z' }];
  assert.deepEqual(planDailyBackups(points, { now: '2026-10-25T20:00:00Z' }).retainedIds, ['winter']);
  for (const points of [[{ id: 'a', time: 'invalid' }], [{ id: 'a', time: '2099-01-01T00:00:00Z' }], [{ id: 'a', time: '2026-01-01' }, { id: 'a', time: '2026-01-01' }]]) assert.throws(() => planDailyBackups(points), /BACKUP_RETENTION_/);
});
