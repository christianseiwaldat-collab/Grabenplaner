"use strict";

const BACKUP_RETENTION_DAYS = 20;
const BACKUP_RETENTION_POLICY = 'daily-calendar-v1';
const zone = 'Europe/Vienna';
const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
function calendarDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('BACKUP_RETENTION_TIME_INVALID');
  const parts = Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Twenty calendar dates including today. Missing days do not extend the window.
// Keep the latest complete point per day and always the newest available point.
// Callers supply only verified, explicitly managed snapshots, never loose files.
function planDailyBackups(points, { days = BACKUP_RETENTION_DAYS, now = new Date() } = {}) {
  if (!Array.isArray(points) || !Number.isInteger(days) || days < 1 || days > 1000) throw new Error('BACKUP_RETENTION_INPUT_INVALID');
  const today = calendarDay(now);
  const cutoff = new Date(`${today}T12:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const seen = new Set();
  const ordered = points.map(point => {
    if (typeof point?.id !== 'string' || !point.id || seen.has(point.id)) throw new Error('BACKUP_RETENTION_ID_INVALID');
    seen.add(point.id);
    const day = calendarDay(point.time), timestamp = Date.parse(point.time);
    if (day > today) throw new Error('BACKUP_RETENTION_FUTURE_POINT');
    return { ...point, day, timestamp };
  }).sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  const daily = new Set(), retainedIds = [], removeIds = [];
  for (const point of ordered) {
    if (retainedIds.length === 0 || (point.day >= cutoffDay && !daily.has(point.day))) {
      daily.add(point.day); retainedIds.push(point.id);
    } else removeIds.push(point.id);
  }
  return Object.freeze({ policy: BACKUP_RETENTION_POLICY, days, timeZone: zone, asOf: new Date(now).toISOString(),
    today, cutoffDay, retainedIds: Object.freeze(retainedIds), removeIds: Object.freeze(removeIds) });
}
module.exports = { BACKUP_RETENTION_DAYS, BACKUP_RETENTION_POLICY, calendarDay, planDailyBackups };
