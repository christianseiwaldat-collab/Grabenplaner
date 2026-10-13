"use strict";
const { preferredDayCost } = require("./employee-preferences");
const { createHash, randomUUID, randomBytes } = require("node:crypto");
const { minutes, clock, addDays } = require("./planning-assistant");
const { eligible } = require("./planning-qualifications");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message, status = 409, code = "OPTIMIZER_PLAN_CHANGED") => { throw Object.assign(new Error(message), { status, code }); };
const identity = shift => JSON.stringify([String(shift.employeeNumber), shift.shiftDate, shift.startTime, shift.endTime, Number(shift.departmentId || 0), shift.dutyCode]);
const fromRow = row => ({ employeeNumber: String(row.employee_number), locationId: String(row.location_id), departmentId: Number(row.department_id || 0) || null,
  shiftDate: row.shift_date, startTime: row.start_time, endTime: row.end_time, dutyCode: String(row.duty_code || ""), area: row.area || "", note: row.note || "" });
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function input(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["week", "locationId", "departmentId", "mode", "absentEmployeeNumber"].includes(k))
    || typeof value.week !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.week) || value.week < "2000-01-01" || value.week > "2200-12-24"
    || !Number.isFinite(Date.parse(value.week + "T12:00:00Z")) || new Date(value.week + "T12:00:00Z").toISOString().slice(0, 10) !== value.week
    || typeof value.locationId !== "string" || !value.locationId.trim() || value.locationId.length > 100 || !["optimize", "replacement"].includes(value.mode)
    || value.departmentId != null && (!Number.isSafeInteger(value.departmentId) || value.departmentId < 1)
    || value.absentEmployeeNumber != null && (typeof value.absentEmployeeNumber !== "string" || value.absentEmployeeNumber.length > 80)) fail("Bitte Woche, Bereich und Optimierungsart auswählen.", 400, "OPTIMIZER_INPUT_INVALID");
  return { week: value.week, locationId: value.locationId, departmentId: value.departmentId || null, mode: value.mode, absentEmployeeNumber: value.absentEmployeeNumber || "" };
}
async function buildProblem(snapshot, options, deps, actor) {
  const { facts, schedule, rawShifts } = snapshot, employees = schedule.employees;
  if (!employees.length || employees.length > 100) fail("Bitte einen Bereich mit 1 bis 100 Mitarbeitenden auswählen.", 422, "OPTIMIZER_SCOPE_LIMIT");
  if (facts.optimizationBlockers?.length) fail(facts.optimizationBlockers.join(" "), 409, "OPTIMIZER_CONFIGURATION_INVALID");
  if (!facts.qualifications.available) fail("Die Qualifikationsprüfung muss vor der Optimierung verfügbar sein.", 409, "OPTIMIZER_QUALIFICATIONS_UNAVAILABLE");
  if (options.mode === "replacement" && !employees.some(e => String(e.personnel_number) === options.absentEmployeeNumber)) fail("Bitte eine Person aus dem gewählten Plan auswählen.", 400, "OPTIMIZER_INPUT_INVALID");
  const localRows = rawShifts.filter(r => String(r.location_id) === facts.context.locationId && (!facts.context.departmentId || Number(r.department_id) === facts.context.departmentId));
  const baseline = localRows.map(r => ({ ...fromRow(r), existingId: String(r.id) }));
  const ignored = new Set(localRows.map(r => String(r.id))), templates = new Map();
  const template = item => { const key = JSON.stringify([item.shiftDate, item.startTime, item.endTime, item.departmentId || null, item.dutyCode]); if (!templates.has(key)) templates.set(key, item); };
  for (const row of baseline) template(row);
  if (options.mode === "optimize") for (let date = facts.period.from; date <= facts.period.to; date = addDays(date, 1)) {
    const day = await deps.day(date, schedule.settings, facts.context);
    if (!day?.open || schedule.globalBlockDates.includes(date) || schedule.publicHolidays?.some(h => h.date === date)) continue;
    const start = minutes(day.start), end = minutes(day.end);
    if (start === null || end === null || end <= start) continue;
    const middle = Math.floor((start + end) / 60) * 30;
    const windows = [[start, end], [start, middle], [middle, end]];
    // Candidate lengths come from existing contractual workday targets, not legal constants.
    for (const employee of employees) {
      const target = Math.round(Number(employee.contracted_hours || 0) * 60 / Math.max(1, Number(employee.target_workdays_per_week || 5)) / 30) * 30;
      if (target >= 30 && target < end - start) windows.push([start, start + target], [end - target, end]);
    }
    const departments = [...new Set([facts.context.departmentId || null, ...facts.requirements.filter(r => r.date === date && r.departmentId).map(r => r.departmentId)])];
    for (const departmentId of departments) for (const [a, b] of windows) if (b - a >= 30) template({ shiftDate: date, startTime: clock(a), endTime: clock(b), departmentId, dutyCode: departmentId ? "department" : "general" });
  }
  const candidates = [], sourceKeys = new Set(baseline.map(identity));
  for (const employee of employees) for (const item of templates.values()) {
    deps.checkAbort?.();
    const id = String(employee.personnel_number);
    if (id === options.absentEmployeeNumber || !eligible(facts.qualifications, id, item.shiftDate, item.departmentId)) continue;
    const proposed = { ...item, employeeNumber: id, locationId: facts.context.locationId, area: "", note: "" };
    const original = baseline.find(row => identity(row) === identity(proposed));
    if (options.mode === "replacement" && !original && !baseline.some(row => row.employeeNumber === options.absentEmployeeNumber
      && row.shiftDate === proposed.shiftDate && row.startTime === proposed.startTime && row.endTime === proposed.endTime
      && row.departmentId === proposed.departmentId && row.dutyCode === proposed.dutyCode)) continue;
    if (original) Object.assign(proposed, original);
    if (candidates.length >= 3000) fail("Zu viele mögliche Dienste. Bitte eine kleinere Abteilung auswählen.", 422, "OPTIMIZER_SCOPE_LIMIT");
    let candidate;
    try { candidate = await deps.candidate(proposed, actor, ignored, schedule.settings); }
    catch (error) { if ([400, 404, 409, 423].includes(error.status)) continue; throw error; }
    if (!Number.isSafeInteger(candidate.minutes) || candidate.minutes <= 0) continue;
    if (candidates.some(c => identity(c.shift) === identity(candidate.shift))) continue;
    const preferenceCost = preferredDayCost(employee, weekdays[new Date(item.shiftDate + "T12:00:00Z").getUTCDay()])
      + 4 * Number((schedule.weekOptions || []).some(o => o.soft_pending && String(o.employee_number) === id && o.date_from <= item.shiftDate && o.date_to >= item.shiftDate));
    candidates.push({ ...candidate, originalId: original?.existingId || null, employeeId: id, preferenceCost,
      saturday: Number(new Date(item.shiftDate + "T12:00:00Z").getUTCDay() === 6), baseline: sourceKeys.has(identity(proposed)) });
  }
  const groups = [];
  const push = (indices, minimum, maximum, label) => groups.push({ indices, minimum, maximum, label });
  // Every real interval boundary, including known breaks, participates in coverage.
  for (const requirement of facts.requirements) {
    const a = minutes(requirement.startTime), b = minutes(requirement.endTime);
    const matching = candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.shift.shiftDate === requirement.date
      && (!requirement.departmentId || c.shift.departmentId === requirement.departmentId)
      && (!requirement.positionId || employees.find(e => String(e.personnel_number) === c.employeeId)?.position_id === requirement.positionId)
      && (!requirement.employeeIds?.length || requirement.employeeIds.includes(c.employeeId)));
    const boundaries = [...new Set([a, b, ...matching.flatMap(({ c }) => c.coverage.flatMap(w => [Math.max(a, w.start), Math.min(b, w.end)]).filter(x => x >= a && x <= b))])].sort((x, y) => x - y);
    for (let n = 0; n < boundaries.length - 1; n++) {
      const start = boundaries[n], end = boundaries[n + 1];
      push(matching.filter(({ c }) => c.coverage.some(w => w.start <= start && w.end >= end)).map(({ i }) => i), requirement.minimum, 3000,
        `${requirement.label} · ${requirement.date} ${clock(start)}–${clock(end)}`);
    }
  }
  for (const employee of employees) {
    const entries = candidates.map((c, i) => ({ c, i })).filter(x => x.c.employeeId === String(employee.personnel_number));
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.c.shift.shiftDate === b.c.shift.shiftDate && a.c.shift.startTime < b.c.shift.endTime && b.c.shift.startTime < a.c.shift.endTime) push([a.i, b.i], 0, 1, "Keine Doppelbelegung");
    }
  }
  if (options.mode === "replacement") for (const row of baseline) {
    const matching = candidates.map((c, i) => ({ c, i })).filter(({ c }) => row.employeeNumber === options.absentEmployeeNumber
      ? !c.originalId && c.shift.shiftDate === row.shiftDate && c.shift.startTime === row.startTime && c.shift.endTime === row.endTime && c.shift.departmentId === row.departmentId && c.shift.dutyCode === row.dutyCode
      : c.originalId === row.existingId);
    push(matching.map(x => x.i), 1, 1, `Dienst erhalten · ${row.shiftDate} ${row.startTime}–${row.endTime}`);
  }
  if (groups.length > 12000) fail("Zu viele Planungsvarianten. Bitte eine kleinere Abteilung auswählen.", 422, "OPTIMIZER_SCOPE_LIMIT");
  const history = await deps.history(facts.period.from, employees.map(e => String(e.personnel_number)));
  const workerEmployees = facts.employees.map(e => {
    const originalMinutes = facts.shifts.filter(s => s.visible && s.employeeId === e.id).reduce((sum, s) => sum + Math.max(0, minutes(s.endTime) - minutes(s.startTime) - (s.breaks || []).reduce((v, p) => v + minutes(p.endTime) - minutes(p.startTime), 0) - s.unlocatedBreakMinutes), 0);
    return { id: e.id, targetMinutes: Math.max(0, e.hoursComplete && Number.isFinite(e.targetMinutes) ? e.targetMinutes : originalMinutes),
      creditMinutes: Math.max(0, Math.min(10080, Number(e.creditedMinutes || 0) - originalMinutes)), saturdayHistory: history[e.id] || 0 };
  });
  return { candidates, baseline, problem: { schemaVersion: 2, preferenceCostScale: 4, employees: workerEmployees,
    candidates: candidates.map(({ employeeId, minutes, preferenceCost, saturday }) => ({ employeeId, minutes, preferenceCost, saturday })),
    baselineIndices: candidates.flatMap((c, i) => c.baseline ? [i] : []), groups: groups.map(({ indices, minimum, maximum }) => ({ indices, minimum, maximum })), forbidden: [] }, groups };
}

function createPlanningOptimizer(deps) {
  const proposals = new Map(); let preparing = false;
  const actorKey = actor => hash([actor?.id, actor?.employeeNumber, actor?.accountId, actor?.role, actor?.permissions, actor?.scopes]);
  function sweep() { for (const [id, entry] of proposals) if (entry.expiresAt < Date.now()) proposals.delete(id); }
  async function prepare(actor, body, { signal } = {}) {
    const options = input(body); sweep();
    const deadline = Date.now() + 60000, timed = AbortSignal.timeout(60000), combined = signal ? AbortSignal.any([signal, timed]) : timed;
    const checkAbort = () => {
      if (Date.now() >= deadline) fail("Die Berechnung hat ihr Zeitlimit erreicht. Bitte einen kleineren Bereich auswählen.", 504, "OPTIMIZER_TIMEOUT");
      if (combined.aborted) fail("Die Berechnung wurde abgebrochen.", 499, "OPTIMIZER_CANCELLED");
    };
    if (preparing || proposals.size >= 20) fail("Der Planungsdienst ist ausgelastet. Bitte kurz darauf erneut versuchen.", 429, "OPTIMIZER_BUSY");
    preparing = true;
    try {
      await deps.refresh();
      await deps.authorize(options, actor);
      checkAbort();
      const before = await deps.stamp(options), snapshot = await deps.read(options, actor);
      const prepared = await buildProblem(snapshot, options, { ...deps, checkAbort }, actor), scenarios = [], discarded = [];
      for (const profile of ["stable", "balanced", "wishes"]) {
        for (let attempt = 0; attempt < 4; attempt++) {
          checkAbort();
          const solved = await deps.service.run({ ...prepared.problem, profile }, { signal: combined });
          if (!["OPTIMAL", "FEASIBLE"].includes(solved.status)) { discarded.push({ profile, status: solved.status,
            reasons: (solved.conflictingGroups || []).slice(0, 8).map(i => prepared.groups[i]?.label).filter(Boolean) }); break; }
          if (!Array.isArray(solved.selected) || solved.selected.some(i => !Number.isSafeInteger(i) || !prepared.candidates[i]) || new Set(solved.selected).size !== solved.selected.length) fail("Ungültiges Ergebnis des Planungsdienstes.", 502, "OPTIMIZER_OUTPUT_INVALID");
          prepared.problem.forbidden.push(solved.selected);
          const selected = solved.selected.map(i => prepared.candidates[i]);
          const preview = await deps.validate(snapshot, selected, actor);
          if (!preview.allowed) { discarded.push({ profile, status: "GP_REJECTED", reasons: preview.reasons }); continue; }
          const changes = diff(prepared.baseline, selected);
          scenarios.push({ id: randomUUID(), profile, status: solved.status, engine: solved.engine, engineVersion: solved.engineVersion,
            durationMs: solved.durationMs, metrics: { ...solved.metrics, changedShifts: changes.length }, selected, changes, review: preview.review });
          break;
        }
      }
      if (before !== await deps.stamp(options)) fail("Die Planungsgrundlage wurde während der Berechnung geändert. Bitte erneut berechnen.");
      checkAbort();
      const id = randomUUID(), confirmationToken = randomBytes(24).toString("hex"), expiresAt = Date.now() + 10 * 60 * 1000;
      const entry = { id, options, snapshot, scenarios, sourceStamp: before, actor: actorKey(actor), confirmationToken, expiresAt, applied: null, applying: false };
      if (scenarios.length) proposals.set(id, entry);
      return { id, confirmationToken: scenarios.length ? confirmationToken : null, expiresAt: new Date(expiresAt).toISOString(), inputRevision: snapshot.assessment.inputRevision,
        mode: options.mode, scenarios: scenarios.map(s => publicScenario(s, snapshot.facts.employees)), discarded, confirmationRequired: true };
    } finally { preparing = false; }
  }
  async function apply(actor, body, context) {
    sweep();
    if (!body || Object.keys(body).some(k => !["proposalId", "scenarioId", "confirmationToken", "confirmed"].includes(k)) || body.confirmed !== true) fail("Bitte den angezeigten Vorschlag ausdrücklich bestätigen.", 400, "OPTIMIZER_CONFIRMATION_REQUIRED");
    const entry = proposals.get(body.proposalId);
    if (!entry || entry.actor !== actorKey(actor) || entry.confirmationToken !== body.confirmationToken) fail("Dieser Vorschlag ist nicht mehr bestätigbar.", 409, "OPTIMIZER_PROPOSAL_EXPIRED");
    const scenario = entry.scenarios.find(s => s.id === body.scenarioId);
    if (!scenario) fail("Der gewählte Vorschlag ist nicht vorhanden.", 400, "OPTIMIZER_INPUT_INVALID");
    if (entry.applied) { if (entry.applied.scenarioId !== scenario.id) fail("Für diesen Vergleich wurde bereits ein anderer Vorschlag übernommen."); return entry.applied; }
    if (entry.applying) fail("Die Übernahme läuft bereits.", 409, "OPTIMIZER_APPLY_IN_PROGRESS");
    entry.applying = true;
    try {
      await deps.refresh();
      if (await deps.stamp(entry.options) !== entry.sourceStamp) fail("Dienstplan, Abwesenheiten oder Regeln wurden geändert. Bitte neue Vorschläge berechnen.");
      const snapshot = await deps.read(entry.options, actor), preview = await deps.validate(snapshot, scenario.selected, actor);
      if (!preview.allowed) fail("Der Vorschlag besteht die aktuelle GP-Prüfung nicht mehr.", 409, "OPTIMIZER_REVALIDATION_FAILED");
      entry.applied = { ...await deps.commit(entry, scenario, preview, actor, context), scenarioId: scenario.id };
      return entry.applied;
    } finally { entry.applying = false; }
  }
  return { prepare, apply };
}
function diff(baseline, selected) {
  const keep = new Set(selected.map(c => c.originalId).filter(Boolean));
  return [...baseline.filter(s => !keep.has(s.existingId)).map(s => ({ kind: "remove", shift: s })), ...selected.filter(c => !c.originalId).map(c => ({ kind: "add", shift: c.shift }))];
}
function publicScenario(scenario, employees) {
  const publicShift = s => ({ employeeId: s.employeeNumber, employeeName: employees.find(e => e.id === s.employeeNumber)?.label || s.employeeNumber,
    date: s.shiftDate, startTime: s.startTime, endTime: s.endTime, departmentId: s.departmentId, dutyCode: s.dutyCode });
  return { id: scenario.id, profile: scenario.profile, status: scenario.status, engine: scenario.engine, engineVersion: scenario.engineVersion,
    metrics: scenario.metrics, durationMs: scenario.durationMs, review: scenario.review,
    shifts: scenario.selected.map(c => publicShift(c.shift)), changes: scenario.changes.map(c => ({ kind: c.kind, ...publicShift(c.shift) })) };
}
module.exports = { buildProblem, createPlanningOptimizer, diff, fromRow, identity, hash, input };
