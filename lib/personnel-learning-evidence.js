"use strict";

// Shared projection for the learning matrix and schedule checks. No new skill
// records or independent interpretation of revisions/validity are introduced.
async function learningEvidence(employeeNumbers, deps, moduleBundles) {
  const bundles = new Map((moduleBundles || await deps.bundles()).map(b => [b.module.id, b]));
  const data = await deps.repository.teamData(employeeNumbers);
  const group = (rows, key) => { const result = new Map(); for (const row of rows) { const list = result.get(row[key]) || []; list.push(row); result.set(row[key], list); } return result; };
  const competencyRevisions = group(data.teamCompetencyRevisions, "competencyId");
  const assignmentRevisions = group(data.teamAssignmentRevisions, "assignmentId"), progressRevisions = group(data.teamProgressRevisions, "assignmentId");
  const competencies = data.teamCompetencies.map(c => {
    const state = deps.competencyState(c, competencyRevisions.get(c.id) || []);
    return { employeeNumber: c.employeeNumber, moduleId: c.skillModuleId, active: state.active, level: state.current.competencyLevel,
      version: state.current.skillVersionNumber, changedAt: state.current.changedAt };
  });
  const trainings = data.teamAssignments.map(a => {
    const state = deps.assignmentState(a, assignmentRevisions.get(a.id) || []);
    const version = bundles.get(a.processModuleId)?.versions.find(v => v.versionNumber === state.current.processVersionNumber);
    if (!version) throw Object.assign(new Error("Die gebundene Schulungsfassung ist nicht vollständig verfügbar."), { status: 503, code: "PERSONNEL_LEARNING_EVIDENCE_UNAVAILABLE" });
    const progress = deps.progressState(progressRevisions.get(a.id) || [], version.content.steps);
    return { employeeNumber: a.learnerEmployeeNumber, moduleId: a.processModuleId, active: state.active, version: version.versionNumber,
      result: progress.finalized ? progress.result : "pending", changedAt: progress.current?.changedAt || state.current.changedAt };
  });
  return { competencies, trainings };
}
module.exports = { learningEvidence };
