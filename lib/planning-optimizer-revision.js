"use strict";
const { hash } = require("./planning-optimizer");
const { addDays } = require("./work-rules/calendar");
// Read through the same repository contract both before validation and inside
// the serializable commit. Only the digest leaves this function. No raw private
// records are sent to the solver, browser, audit or proposal store.
async function sourceRevision(r, context, weekStart) {
  const weekEnd = addDays(weekStart, 6), query = { ...context, weekStart, weekEnd };
  const employees = await r.planningSettings.listScheduleEmployees(query), ids = employees.map(e => String(e.personnel_number));
  const [base, personal] = await Promise.all([
    Promise.all([
      r.planningSettings.listSettings(), r.planningSettings.listPortalSettings(), r.planningSettings.listGlobalDayBlocks(),
      r.planningSettings.listWorkRuleShiftsForRange({ dateFrom: addDays(weekStart, -112), dateTo: addDays(weekEnd, 14) }),
      r.planningSettings.listScheduleLendings(query), r.organizationPersonnel.listLocations(true), r.organizationPersonnel.listDepartments(true), r.organizationPersonnel.listPositions(),
      r.organizationPersonnel.getScheduleManualLock(context.locationId, weekStart),
      r.workRules.listAssignments(true), r.workRules.listProfiles(), r.workRules.listExceptions(),
      r.workRuleGovernance.assignmentRevisionsWithProfile(), r.workRuleGovernance.listGovernanceEvents(),
      r.collectiveAgreements.listAgreements(), r.collectiveAgreements.listVersions(), r.collectiveAgreements.listAssignments(),
      r.collectiveAgreements.listBusinessUnits(true), r.collectiveAgreements.listBusinessUnitScopes(), r.collectiveAgreements.listAssignmentGovernanceEvents(),
      r.personnelLearning.listRequirements(), r.personnelLearning.listAllVersions(), r.personnelLearning.listAllEvents(), r.personnelLearning.teamData(ids),
      r.sicknessAmuManagement.listAllSicknessCases({}),
      r.timeTracking.listActiveXoffiWeekRows({ ...query, filterDepartment: Boolean(context.departmentId) }),
      r.timeTracking.listActiveXoffiWeekDays({ ...query, filterDepartment: Boolean(context.departmentId) }),
    ]),
    Promise.all(ids.map(async id => [await r.organizationPersonnel.getPersonnelSensitiveRecord(id),
      await r.organizationPersonnel.getPortalUserAccountProjection(id),
      await r.planningSettings.listOverlappingWeekOptions({ employeeNumber: id, dateFrom: addDays(weekStart, -112), dateTo: addDays(weekEnd, 14), existingId: 0, excludedGroupId: null })])),
  ]);
  return hash([employees, base, personal]);
}
module.exports = { sourceRevision };
