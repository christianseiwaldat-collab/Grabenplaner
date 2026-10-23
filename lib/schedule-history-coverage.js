'use strict';
const DAY = 86400000;
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new TypeError('Invalid planning date');
  const result = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new TypeError('Invalid planning date');
  return result;
}
const iso = value => value.toISOString().slice(0, 10);
function monday(value) {
  const result = date(value);
  result.setUTCDate(result.getUTCDate() - (result.getUTCDay() + 6) % 7);
  return iso(result);
}
function add(value, days) { return iso(new Date(date(value).getTime() + days * DAY)); }
function weekIdentity(value) {
  const thursday = date(add(monday(value), 3)), year = thursday.getUTCFullYear();
  const first = date(monday(year + '-01-04'));
  return { week: Math.round((date(monday(value)) - first) / (DAY * 7)) + 1, year };
}
function planningHistoryCoverage({ weekStart, shifts = [], options = [], dayBlocks = [] }) {
  const selected = monday(weekStart), weeks = [];
  for (let offset = -12; offset < 0; offset++) {
    const start = add(selected, offset * 7), end = add(start, 6);
    // Presence is based on stored planning data, never on Saturday participation
    // or a time-account import. A recorded absence is also planning evidence.
    const shift = shifts.some(row => row.shift_date >= start && row.shift_date <= end);
    const option = options.some(row => row.date_from <= end && row.date_to >= start);
    const fullyBlocked = Array.from({length: 6}, (_, i) => add(start, i))
      .every(day => dayBlocks.some(row => row.block_date === day || row.date === day));
    weeks.push({ weekStart: start, weekEnd: end, ...weekIdentity(start), present: shift || option || fullyBlocked });
  }
  return { basis: 'stored_schedule_shifts_options_and_day_blocks', weekStart: selected, weeks, missing: weeks.filter(week => !week.present) };
}
module.exports = { planningHistoryCoverage, monday, add, weekIdentity };
