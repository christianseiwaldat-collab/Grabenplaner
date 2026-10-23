"use strict";
const T = require("./personnel-learning-team");
const { learningEvidence } = require("./personnel-learning-evidence");
const { addDays } = require("./work-rules/calendar");

function createQualificationReader(deps) {
  return async (schedule, session, { departmentIds = [schedule.context.departmentId || null] } = {}) => {
    const actor = await deps.actor(session), employees = schedule.employees;
    if (!actor.access.canWriteAssignments) return { available: false, checks: [], reason: "Für die Qualifikationsprüfung fehlt der Zugriff auf die bestehende Lern-Teamübersicht." };
    const permitted = employees.filter(e => deps.employeeAllowed(actor, e));
    const [revisions, evidence, users] = await Promise.all([
      deps.repository.listRequirements(), learningEvidence(permitted.map(e => String(e.personnel_number)), deps), deps.roles(permitted.map(e => String(e.personnel_number))),
    ]);
    const rules = T.rules(revisions).filter(rule => rule.payload.active);
    const roleByEmployee = new Map(users.map(user => [String(user.employee_number ?? user.employeeNumber), String(user.role || "")]));
    const checks = [];
    for (const employee of employees) {
      const id = String(employee.personnel_number), allowed = permitted.includes(employee);
      for (let date = schedule.weekStart; date <= schedule.weekEnd; date = addDays(date, 1)) {
        if (!allowed) { checks.push({ employeeId: id, date, status: "unknown", title: "Qualifikation nicht freigegeben" }); continue; }
        for (const departmentId of departmentIds) for (const rule of rules) {
          const person = { employeeNumber: id, positionId: employee.position_id, roleId: roleByEmployee.get(id), locationId: schedule.context.locationId, departmentId };
          const cell = T.cell(rule, person, { ...evidence, today: date });
          if (cell.status === "notApplicable") continue;
          // The team matrix describes current evidence. A later correction must
          // never be claimed as proof for a historical duty without reconstruction.
          const laterEvidence = (rule.payload.type === "skill" ? evidence.competencies : evidence.trainings)
            .some(e => e.employeeNumber === id && e.moduleId === rule.payload.moduleId && String(e.changedAt).slice(0, 10) > date);
          checks.push({ employeeId: id, date, departmentId, requirementId: rule.id, revision: rule.revision, receipt: rule.receiptSha256,
            title: rule.payload.title, status: laterEvidence ? "unknown" : cell.status, validUntil: cell.until || null });
        }
      }
    }
    return { available: true, checks, requirementCount: rules.length };
  };
}
function eligible(qualifications, employeeId, date, departmentId = null) {
  return qualifications?.available === true && !qualifications.checks.some(c => c.employeeId === employeeId && c.date === date
    && (c.departmentId === undefined || (c.departmentId || null) === (departmentId || null)) && !["fulfilled", "dueSoon"].includes(c.status));
}
module.exports = { createQualificationReader, eligible };
