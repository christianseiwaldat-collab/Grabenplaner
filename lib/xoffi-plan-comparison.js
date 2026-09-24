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

function buildComparison({ dates, employees, shifts, planCredits = [], imports, importDays, limits, departmentId = null }) {
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
  const plan = new Map(), presencePlan = new Map(), valuedPlan = new Map(), actual = new Map(), credits = new Map();
  for (const shift of shifts) {
    const key = `${shift.employee_number}|${shift.shift_date}`;
    const net = Math.max(0, Number(shift.raw_minutes) - Number(shift.break_minutes));
    plan.set(key, (plan.get(key) || 0) + net);
    presencePlan.set(key, (presencePlan.get(key) || 0) + net);
    valuedPlan.set(key, (valuedPlan.get(key) || 0) + Number(shift.counted_minutes ?? net));
  }
  for (const credit of planCredits) {
    if (!people.has(String(credit.employeeNumber)) || !dates.includes(credit.date)
      || !Number.isFinite(credit.minutes) || credit.minutes <= 0) continue;
    const key = `${credit.employeeNumber}|${credit.date}`;
    plan.set(key, (plan.get(key) || 0) + credit.minutes);
    valuedPlan.set(key, (valuedPlan.get(key) || 0) + credit.minutes);
    if (!credits.has(key)) credits.set(key, []);
    credits.get(key).push({ label: credit.label, minutes: credit.minutes });
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
      const valuedMinutes = day ? Number(day.valued_minutes ?? day.actual_minutes) : null;
      const scope = Boolean(scopeMismatch || ambiguous);
      return { date, plannedMinutes, actualMinutes, planCredits: credits.get(key) || [],
        plannedPresenceMinutes: presencePlan.get(key) || 0, plannedValuedMinutes: valuedPlan.get(key) || 0,
        intervals: Array.isArray(intervals) ? intervals.filter(v => typeof v === 'string') : [],
        valuedMinutes, scopeMismatch: scope,
        importId: day ? source.import_id : null, importedAt: day ? source.imported_at : null,
        useAsActual: day ? Number(source.use_as_actual) === 1 : false,
        valuedComparison: modeComparison(valuedPlan.get(key) || 0, valuedMinutes, limits, scope),
        presenceComparison: modeComparison(presencePlan.get(key) || 0, actualMinutes, limits, scope),
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
      ...periodMetrics(days, limits),
      ...deviation(plannedMinutes, actualMinutes, limits),
      ...(scopeMismatch || ambiguous ? { differenceMinutes: null, percent: null, severity: 'scope' } : {}) };
  }).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, 'de', { numeric: true }));
}

function modeComparison(plannedMinutes, actualMinutes, limits, scopeMismatch = false) {
  return { plannedMinutes, actualMinutes, ...deviation(plannedMinutes, actualMinutes, limits),
    ...(scopeMismatch ? { differenceMinutes: null, percent: null, severity: 'scope' } : {}) };
}

function periodMetrics(days, limits) {
  const complete = days.every(day => day.actualMinutes !== null);
  const sum = field => days.reduce((total, day) => total + Number(day[field] || 0), 0);
  const scope = days.some(day => day.scopeMismatch);
  return {
    plannedPresenceMinutes: sum('plannedPresenceMinutes'), plannedValuedMinutes: sum('plannedValuedMinutes'),
    knownActualMinutes: sum('actualMinutes'), knownValuedMinutes: sum('valuedMinutes'),
    coveredDays: days.filter(day => day.actualMinutes !== null).length, totalDays: days.length,
    valuedComparison: modeComparison(sum('plannedValuedMinutes'), complete ? sum('valuedMinutes') : null, limits, scope),
    presenceComparison: modeComparison(sum('plannedPresenceMinutes'), complete ? sum('actualMinutes') : null, limits, scope),
  };
}

// Each week is scoped independently before merging. Clip boundary weeks before
// summing, and keep missing imports unknown rather than inventing zero hours.
function combineComparisons(weeks, dates, limits = DEFAULT_THRESHOLDS) {
  const people = new Map();
  for (const rows of weeks) for (const row of rows) {
    if (!people.has(row.employeeNumber)) people.set(row.employeeNumber, { ...row, byDate: new Map() });
    for (const day of row.days) people.get(row.employeeNumber).byDate.set(day.date, day);
  }
  return [...people.values()].map(({ byDate, ...person }) => {
    const days = dates.map(date => byDate.get(date) || {
      date, plannedMinutes: 0, plannedPresenceMinutes: 0, plannedValuedMinutes: 0,
      actualMinutes: null, valuedMinutes: null, planCredits: [], intervals: [], absence: '',
      importId: null, importedAt: null, useAsActual: false, scopeMismatch: false,
      ...deviation(0, null, limits),
      valuedComparison: modeComparison(0, null, limits), presenceComparison: modeComparison(0, null, limits),
    });
    const imports = [...new Map(days.filter(day => day.importId).map(day => [day.importId, {
      importId: day.importId, importedAt: day.importedAt, useAsActual: day.useAsActual,
    }])).values()].sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
    const metrics = periodMetrics(days, limits);
    const scopeMismatch = days.some(day => day.scopeMismatch);
    const complete = metrics.coveredDays === dates.length;
    const plannedMinutes = days.reduce((total, day) => total + day.plannedMinutes, 0);
    const actualMinutes = metrics.presenceComparison.actualMinutes;
    return { employeeNumber: person.employeeNumber, fullName: person.fullName, days, imports,
      plannedMinutes, actualMinutes, valuedMinutes: metrics.valuedComparison.actualMinutes, ...metrics,
      importId: imports[0]?.importId || null, importedAt: imports[0]?.importedAt || null,
      useAsActual: imports.length > 0 && imports.every(source => source.useAsActual),
      importState: !imports.length ? 'missing' : complete ? 'complete' : 'incomplete', scopeMismatch,
      ...modeComparison(plannedMinutes, actualMinutes, limits, scopeMismatch),
    };
  }).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, 'de', { numeric: true }));
}

module.exports = { DEFAULT_THRESHOLDS, thresholds, deviation, buildComparison, combineComparisons };
