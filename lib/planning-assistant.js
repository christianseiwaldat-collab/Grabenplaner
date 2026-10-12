"use strict";

const crypto = require("node:crypto");
const { addDays } = require("./work-rules/calendar");
const SCHEMA_VERSION = 1;
const RULES = Object.freeze({
  overlap: { title: "Doppelbelegung", constraint: "hard" },
  unavailable: { title: "Dienst trotz Nichtverfügbarkeit", constraint: "hard" },
  staffing: { title: "Mindestbesetzung", constraint: "hard" },
  position: { title: "Erforderliche Position", constraint: "hard" },
  key_person: { title: "Schlüsselperson", constraint: "hard" },
  break_coverage: { title: "Pausenabdeckung", constraint: "review" },
  weekly_target: { title: "Vertragliche Wochenstunden", constraint: "preference" },
  work_rules: { title: "Arbeitszeitregeln", constraint: "review" },
  supervision: { title: "Filialaufsicht", constraint: "review" },
  qualifications: { title: "Fachliche Qualifikationen", constraint: "review" },
  input: { title: "Datengrundlage", constraint: "review" },
});
const minutes = time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(time))
  ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : time === "24:00" ? 1440 : null;
const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const overlap = (a, b) => a.start < b.end && b.start < a.end;
function subtract(intervals, masks) {
  return masks.reduce((parts, mask) => parts.flatMap(part => !overlap(part, mask) ? [part] : [
    ...(part.start < mask.start ? [{ start: part.start, end: mask.start }] : []),
    ...(part.end > mask.end ? [{ start: mask.end, end: part.end }] : []),
  ]), intervals);
}
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function normalizeInterval(item) { return { ...item, start: minutes(item.startTime), end: minutes(item.endTime) }; }
function validInterval(item) { return item.start !== null && item.end !== null && item.start < item.end; }

// Pure read-only evaluation of projected GP facts. Calendar/legal/payroll facts
// are supplied by existing GP services; this module cannot write a plan.
function assessPlanning(facts) {
  const findings = [], employees = new Map(facts.employees.map(item => [item.id, item]));
  const add = (rule, severity, message, suggestion, extra = {}) => {
    const entry = { ruleId: `gp.planning.${rule}`, title: RULES[rule].title, constraint: RULES[rule].constraint,
      severity, message, suggestion, employeeIds: [], ...extra };
    entry.people = entry.employeeIds.map(id => ({ id, label: employees.get(id)?.label || id }));
    entry.id = digest(entry).slice(0, 24); findings.push(entry);
  };
  const valid = [], invalidEmployees = new Set();
  for (const row of facts.shifts) {
    const item = normalizeInterval(row);
    if (!validInterval(item)) {
      invalidEmployees.add(row.employeeId);
      add("input", "unknown", "Ein Dienst hat keine auswertbare Anfangs- und Endzeit.", "Dienstzeiten im bestehenden Dienstplan prüfen.", { date: row.date, employeeIds: [row.employeeId] });
    } else valid.push(item);
  }
  const absence = facts.unavailable.map(normalizeInterval).filter(validInterval);
  const conflicts = new Map(), departmentConflicts = new Map();
  for (const shift of valid) { conflicts.set(shift.id, []); departmentConflicts.set(shift.id, []); }
  for (let i = 0; i < valid.length; i++) {
    const a = valid[i];
    for (let j = i + 1; j < valid.length; j++) {
      const b = valid[j];
      if (a.employeeId !== b.employeeId || a.date !== b.date || !overlap(a, b)) continue;
      const intersection = { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
      // An employee cannot contribute to the local count while scheduled elsewhere.
      invalidEmployees.add(a.employeeId);
      if (a.locationId !== b.locationId) {
        conflicts.get(a.id).push(intersection); conflicts.get(b.id).push(intersection);
      } else if (a.departmentId !== b.departmentId) {
        departmentConflicts.get(a.id).push(intersection); departmentConflicts.get(b.id).push(intersection);
      }
      if (!a.visible && !b.visible) continue;
      add("overlap", "error", "Eine Person ist gleichzeitig mehreren Diensten zugeordnet.",
        `Die Einteilung zwischen ${clock(intersection.start)} und ${clock(intersection.end)} in der Dienstplanung abgleichen.`,
        { date: a.date, startTime: clock(intersection.start), endTime: clock(intersection.end), employeeIds: [a.employeeId],
          shiftIds: [a, b].filter(item => item.visible).map(item => item.id), otherAssignment: !a.visible || !b.visible });
    }
  }
  const available = [];
  for (const shift of valid) {
    const masks = absence.filter(item => item.employeeId === shift.employeeId && item.date === shift.date && overlap(shift, item));
    if (shift.visible) for (const item of masks) add("unavailable", "error",
      `Der Dienst überschneidet sich mit „${item.label || "Nicht verfügbar"}“.`,
      "Dienst oder hinterlegte Nichtverfügbarkeit im zuständigen GP-Bereich prüfen; einen offenen Antrag getrennt entscheiden.",
      { date: shift.date, startTime: clock(Math.max(shift.start, item.start)), endTime: clock(Math.min(shift.end, item.end)), employeeIds: [shift.employeeId], shiftIds: [shift.id] });
    const pauses = (shift.breaks || []).map(normalizeInterval).filter(validInterval);
    const pieces = subtract([{ start: shift.start, end: shift.end }], [...masks, ...pauses, ...conflicts.get(shift.id)]);
    available.push(...pieces.map(piece => ({ ...shift, ...piece })));
  }
  for (const requirement of facts.requirements) {
    const window = normalizeInterval(requirement);
    if (!validInterval(window)) {
      add("input", "unknown", "Ein Besetzungsfenster ist ungültig.", "Öffnungs- und Besetzungszeiten in den Filialeinstellungen prüfen.", { date: requirement.date }); continue;
    }
    const candidates = available.filter(shift => shift.date === requirement.date && shift.locationId === facts.context.locationId
      && (!requirement.departmentId || shift.departmentId === requirement.departmentId) && overlap(shift, window))
      .flatMap(shift => requirement.departmentId
        ? subtract([{ start: shift.start, end: shift.end }], departmentConflicts.get(shift.id)).map(part => ({ ...shift, ...part })) : [shift]);
    const boundaries = [...new Set([window.start, window.end, ...candidates.flatMap(shift => [Math.max(window.start, shift.start), Math.min(window.end, shift.end)])])].sort((a, b) => a - b);
    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i], end = boundaries[i + 1];
      const active = candidates.filter(shift => shift.start <= start && shift.end >= end);
      const people = new Set(active.filter(shift => (!requirement.positionId || employees.get(shift.employeeId)?.positionId === requirement.positionId)
        && (!requirement.employeeIds?.length || requirement.employeeIds.includes(shift.employeeId))).map(shift => shift.employeeId));
      const unknownBreaks = new Set(active.filter(shift => people.has(shift.employeeId) && shift.unlocatedBreakMinutes > 0).map(shift => shift.employeeId));
      const shortfall = requirement.minimum - people.size;
      const uncertain = shortfall <= 0 && people.size - unknownBreaks.size < requirement.minimum;
      if (shortfall <= 0 && !uncertain) continue;
      const ids = [...people].sort(), signature = JSON.stringify([shortfall, uncertain, ids]);
      const previous = segments.at(-1);
      if (previous?.signature === signature && previous.end === start) previous.end = end;
      else segments.push({ start, end, shortfall, uncertain, ids, signature });
    }
    for (const segment of segments) {
      const rule = segment.uncertain ? "break_coverage" : requirement.kind;
      add(rule, segment.uncertain ? "unknown" : "warning", segment.uncertain
        ? `Die Besetzung für „${requirement.label}“ ist ohne konkrete Pausenlage nicht gesichert.`
        : `Für „${requirement.label}“ fehlen ${segment.shortfall} Personen (erforderlich: ${requirement.minimum}, verfügbar: ${segment.ids.length}).`,
      segment.uncertain ? "Pausen konkret abstimmen und die Abdeckung erneut prüfen. Eine pauschale Pausendauer legt keinen Pausenzeitpunkt fest."
        : `Zwischen ${clock(segment.start)} und ${clock(segment.end)} ${segment.shortfall} geeignete Personen zusätzlich einteilen oder Dienste nach berechtigter Prüfung verlagern.`,
      { date: requirement.date, startTime: clock(segment.start), endTime: clock(segment.end), employeeIds: segment.ids,
        required: requirement.minimum, available: segment.ids.length, requirement: requirement.label });
    }
  }
  for (const employee of facts.employees) {
    if (employee.hoursComplete === false || invalidEmployees.has(employee.id) || !Number.isFinite(employee.targetMinutes) || !Number.isFinite(employee.creditedMinutes)) {
      add("weekly_target", "unknown", "Der vollständige Wochenvergleich ist in diesem Ausschnitt nicht belastbar.",
        "Gesamtplan der Stammfiliale, Vertragsstunden und Gutschriften prüfen.", { employeeIds: [employee.id] }); continue;
    }
    const difference = employee.creditedMinutes - employee.targetMinutes;
    if (Math.abs(difference) <= facts.configuration.weeklyToleranceMinutes) continue;
    const hours = (Math.abs(difference) / 60).toLocaleString("de-AT", { maximumFractionDigits: 2 });
    add("weekly_target", "info", `${hours} Stunden ${difference > 0 ? "über" : "unter"} dem vertraglichen Wochensoll (Plan und GP-Gutschriften).`,
      difference > 0 ? "Mehrstunden und allfälligen Ausgleich mit der zuständigen Leitung prüfen. Dies ist keine rechtliche Überstundenbewertung."
        : "Verbleibende Dienste, Abwesenheiten und Gutschriften in der Wochenübersicht prüfen.",
      { employeeIds: [employee.id], actualMinutes: employee.creditedMinutes, targetMinutes: employee.targetMinutes, differenceMinutes: difference });
  }
  if (!facts.workRuleAssessment) add("work_rules", "unknown", "Die vorhandene Arbeitsregelprüfung ist für diesen Zugang nicht verfügbar.", "Freigabe für Arbeitsregelprüfungen prüfen lassen.");
  else for (const item of facts.workRuleAssessment.findings || []) {
    if (["pass"].includes(item.state) || item.resultState === "pass") continue;
    if (item.employeeNumber && !employees.has(item.employeeNumber)) continue;
    add("work_rules", item.resultState === "unknown" || item.state === "manual_review" ? "unknown" : item.state === "blocked" ? "error" : "warning",
      item.message, "Das zugeordnete Regelprofil und den markierten Zeitraum in der bestehenden Arbeitsregelprüfung prüfen.",
      { title: item.title || "Arbeitszeitregel", sourceRuleId: item.ruleId, sourceFindingId: item.id || null,
        constraint: item.effectiveEnforcement === "block" ? "hard" : "review", employeeIds: item.employeeNumber ? [item.employeeNumber] : [],
        date: item.scope?.date || item.scope?.dates?.[0] || null, source: "gp-work-rules" });
  }
  const supervision = facts.supervision;
  if (supervision?.mode === "off") add("supervision", "unknown", "Die bestehende Filialaufsichtsprüfung ist ausgeschaltet.", "Prüfmodus und Grenzwerte bei den Planungs-Grundeinstellungen festlegen.");
  else if (supervision) for (const item of supervision.issues || []) add("supervision", supervision.mode === "block" ? "error" : "warning",
    item.reasons.join("; "), "Verfügbarkeit von Filialleitung, Stellvertretung und Abteilungsleitung für die betroffenen Zeiten prüfen.",
    { date: item.date, source: "gp-branch-supervision", constraint: supervision.mode === "block" ? "hard" : "review" });
  for (const gap of facts.gaps || []) add(gap.rule || "input", "unknown", gap.message, gap.suggestion);
  // Existing learning competencies have no scoped scheduling-requirement adapter.
  add("qualifications", "unknown", "Gültigkeitsbezogene Fachnachweise sind noch nicht an diese Dienstplanprüfung angebunden. Positionen werden separat geprüft.",
    "Erforderliche Fachnachweise fachlich prüfen; die spätere Anbindung verwendet den bestehenden Personal- und Lernbereich.");
  const rank = { error: 0, warning: 1, unknown: 2, info: 3 };
  const unique = [...new Map(findings.map(item => [item.id, item])).values()].sort((a, b) => rank[a.severity] - rank[b.severity] || String(a.date || "").localeCompare(String(b.date || "")) || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(Object.keys(rank).map(key => [key, unique.filter(item => item.severity === key).length]));
  return { schemaVersion: SCHEMA_VERSION, period: facts.period, context: facts.context, timeZone: "Europe/Vienna",
    inputRevision: digest(facts), evaluatedAt: new Date().toISOString(), mode: "read_only", counts,
    outcome: counts.error ? "conflict" : counts.warning ? "attention" : counts.unknown ? "incomplete" : "clear",
    findings: unique, checks: Object.entries(RULES).map(([id, value]) => ({ id, ...value,
      findingCount: unique.filter(item => item.ruleId === `gp.planning.${id}`).length })),
    optimization: { available: false, contractVersion: 1, confirmationRequired: true } };
}

// Versioned local adapter boundary for a future CP-SAT process. No transport,
// execution or apply endpoint exists in phase 1. Private labels are omitted.
function optimizationProblem(facts) {
  return { schemaVersion: 1, inputRevision: digest(facts), timeZone: "Europe/Vienna", period: facts.period,
    employees: facts.employees.map(({ id, positionId, targetMinutes }) => ({ id, positionId, targetMinutes })),
    shifts: facts.shifts.map(({ id, employeeId, date, startTime, endTime, locationId, departmentId, breaks, unlocatedBreakMinutes }) =>
      ({ id, employeeId, date, startMinute: minutes(startTime), endMinute: minutes(endTime), locationId, departmentId, breaks, unlocatedBreakMinutes })),
    unavailable: facts.unavailable.map(({ employeeId, date, startTime, endTime }) => ({ employeeId, date, startMinute: minutes(startTime), endMinute: minutes(endTime) })),
    constraints: facts.requirements.map(item => ({ ...item, constraint: "hard" })),
    legalRules: { source: "existing-gp-rule-profiles", revalidationRequired: true },
    preferences: { weeklyToleranceMinutes: facts.configuration.weeklyToleranceMinutes, minimizeChanges: true },
    status: "not_solved", applyAllowed: false };
}

module.exports = { SCHEMA_VERSION, RULES, assessPlanning, optimizationProblem, subtract, minutes, clock, addDays };
