"use strict";

const DEFAULT_THRESHOLDS = Object.freeze({ greenMax: 5, yellowMax: 15 });

function thresholds(value = DEFAULT_THRESHOLDS) {
  const { greenMax, yellowMax } = value;
  if (typeof greenMax !== 'number' || typeof yellowMax !== 'number'
      || !Number.isFinite(greenMax) || !Number.isFinite(yellowMax)
      || greenMax < 0 || yellowMax <= greenMax || yellowMax > 1000) {
    throw new Error('Bitte gültige Grenzen wählen: 0 ≤ Grün bis < Gelb bis ≤ 1000 %.');
  }
  return { greenMax, yellowMax };
}

function deviation(planned, actual, limits) {
  if (actual === null) return { differenceMinutes: null, percent: null, severity: 'missing' };
  const differenceMinutes = actual - planned;
  if (planned === 0 && actual !== 0) return { differenceMinutes, percent: null, severity: 'unplanned' };
  const percent = planned === 0 ? 0 : differenceMinutes / planned * 100;
  const magnitude = Math.abs(percent);
  return { differenceMinutes, percent,
    severity: magnitude <= limits.greenMax ? 'green' : magnitude <= limits.yellowMax ? 'yellow' : 'red' };
}

function buildComparison({ dates, employees, shifts, imports, importDays, limits, departmentId = null }) {
  limits = thresholds(limits);
  const people = new Map(employees.map(e => [String(e.personnel_number), {
    employeeNumber: String(e.personnel_number), fullName: e.full_name,
  }]));
  for (const shift of shifts) {
    const number = String(shift.employee_number);
    if (!people.has(number)) people.set(number, { employeeNumber: number, fullName: shift.full_name || number });
  }
  const selected = new Map();
  for (const entry of imports) {
    const number = String(entry.employee_number);
    // Branch-wide imports must not reveal other departments to a scoped reader.
    if (departmentId && !entry.department_id && !people.has(number)) continue;
    if (!people.has(number)) people.set(number, { employeeNumber: number, fullName: entry.source_name || number });
    if (!selected.has(number)) selected.set(number, entry);
  }
  const plan = new Map(), actual = new Map();
  for (const shift of shifts) {
    const key = `${shift.employee_number}|${shift.shift_date}`;
    plan.set(key, (plan.get(key) || 0) + Math.max(0, Number(shift.raw_minutes) - Number(shift.break_minutes)));
  }
  for (const day of importDays) {
    if (selected.get(String(day.employee_number))?.import_id !== day.import_id) continue;
    actual.set(`${day.employee_number}|${day.work_date}`, day);
  }
  return [...people.values()].map(person => {
    const source = selected.get(person.employeeNumber);
    const sourceScopes = new Set(imports.filter(entry => String(entry.employee_number) === person.employeeNumber)
      .map(entry => Number(entry.department_id || 0)));
    const ambiguous = !departmentId && [...sourceScopes].filter(Boolean).length > 1;
    const scopeMismatch = source && Number(source.department_id || 0) !== Number(departmentId || 0);
    const days = dates.map(date => {
      const key = `${person.employeeNumber}|${date}`, day = actual.get(key);
      const plannedMinutes = plan.get(key) || 0;
      const actualMinutes = day ? Number(day.actual_minutes) : null;
      let intervals = [];
      try { intervals = JSON.parse(day?.intervals_json || '[]'); } catch { /* historical OCR import */ }
      return { date, plannedMinutes, actualMinutes,
        intervals: Array.isArray(intervals) ? intervals.filter(v => typeof v === 'string') : [],
        valuedMinutes: day ? Number(day.valued_minutes) : null,
        absence: day?.absence_code || "",
        ...deviation(plannedMinutes, actualMinutes, limits),
        ...(scopeMismatch || ambiguous ? { differenceMinutes: null, percent: null, severity: 'scope' } : {}) };
    });
    const plannedMinutes = days.reduce((sum, day) => sum + day.plannedMinutes, 0);
    const complete = Boolean(source) && days.every(day => day.actualMinutes !== null);
    const actualMinutes = complete ? days.reduce((sum, day) => sum + day.actualMinutes, 0) : null;
    return { ...person, days, plannedMinutes, actualMinutes,
      valuedMinutes: complete ? days.reduce((sum, day) => sum + day.valuedMinutes, 0) : null,
      importId: source?.import_id || null, importedAt: source?.imported_at || null,
      useAsActual: source ? Number(source.use_as_actual) === 1 : false,
      importState: !source ? 'missing' : ambiguous ? 'ambiguous' : complete ? 'complete' : 'incomplete',
      scopeMismatch: Boolean(scopeMismatch || ambiguous),
      ...deviation(plannedMinutes, actualMinutes, limits),
      ...(scopeMismatch || ambiguous ? { differenceMinutes: null, percent: null, severity: 'scope' } : {}) };
  }).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, 'de', { numeric: true }));
}

module.exports = { DEFAULT_THRESHOLDS, thresholds, deviation, buildComparison };
