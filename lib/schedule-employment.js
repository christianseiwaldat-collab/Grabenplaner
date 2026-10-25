'use strict';

// The protected employment date is an input to this server-only projection.
// Only days within the requested planning period leave it on employee rows.
function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function startDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (!isoDate(value)) throw Object.assign(new Error('Die Beschäftigungsgrundlage ist nicht verlässlich auswertbar.'), {
    status: 503, code: 'SCHEDULE_EMPLOYMENT_UNAVAILABLE',
  });
  return value;
}
function assertEmploymentDate(value, date) {
  const start = startDate(value);
  if (!isoDate(date)) throw new TypeError('A valid planning date is required');
  if (start && date < start) throw Object.assign(new Error('Vor dem Firmeneintritt kann kein Dienst zugewiesen werden.'), {
    status: 409, code: 'SHIFT_BEFORE_EMPLOYMENT',
  });
}
function employmentProjection(rows, from, to, starts) {
  if (!isoDate(from) || !isoDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new TypeError('A bounded planning period is required');
  const dates = [];
  for (let stamp = Date.parse(from); stamp <= Date.parse(to); stamp += 86400000) dates.push(new Date(stamp).toISOString().slice(0, 10));
  const knownStarts = new Map(), employees = [];
  for (const row of rows) {
    const id = String(row.personnel_number), start = startDate(starts.get(id));
    knownStarts.set(id, start);
    const planningDates = dates.filter(date => !start || date >= start);
    if (planningDates.length) employees.push({ ...row, planningDates });
  }
  const employeeByNumber = new Map(employees.map(row => [String(row.personnel_number), row]));
  function allows(number, date) { return employeeByNumber.get(String(number))?.planningDates.includes(date) === true; }
  function eligibleOnDate(number, date) {
    const id = String(number), start = knownStarts.get(id);
    return employeeByNumber.has(id) && isoDate(date) && (!start || date >= start);
  }
  function clip(input, { employeeKey = 'employee_number', dateKey = 'shift_date', fromKey = 'date_from', toKey = 'date_to' } = {}) {
    return input.flatMap(row => {
      const number = String(row[employeeKey]);
      if (!employeeByNumber.has(number)) return [];
      if (row[dateKey] !== undefined) return allows(number, row[dateKey]) ? [{ ...row }] : [];
      const start = knownStarts.get(number), originalFrom = row[fromKey], end = row[toKey];
      if (!isoDate(originalFrom) || !isoDate(end)) return [];
      const eligibleFrom = start && originalFrom < start ? start : originalFrom;
      if (eligibleFrom > end || eligibleFrom > to || end < from) return [];
      return [{ ...row, [fromKey]: eligibleFrom }];
    });
  }
  return { employees, employeeByNumber, allows, eligibleOnDate, clip };
}
module.exports = { employmentProjection, assertEmploymentDate };
