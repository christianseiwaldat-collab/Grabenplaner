"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  ORGANIZATION_PERSONNEL_STATEMENTS: S,
} = require("../statements/organization-personnel");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function record(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  return value;
}

function text(value) {
  return String(value ?? "");
}

function requiredText(value, operation) {
  const normalized = text(value).trim();
  if (!normalized || normalized.includes("\0")) throw invalidInput(operation);
  return normalized;
}

function nullableText(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function safeInteger(value, operation) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw invalidInput(operation);
  return number;
}

function nullableSafeInteger(value, operation) {
  if (value === null || value === undefined || value === "") return null;
  return safeInteger(value, operation);
}

function boolean(value) {
  return Boolean(value);
}

function employeeParameters(value, operation) {
  const employee = record(value, operation);
  return {
    personnelNumber: text(employee.personnelNumber),
    fullName: text(employee.fullName),
    nickname: text(employee.nickname),
    color: text(employee.color),
    contractedHours: String(employee.contractedHours),
    targetWorkdaysPerWeek: safeInteger(employee.targetWorkdaysPerWeek, operation),
    preferredDayOff: nullableText(employee.preferredDayOff),
    fixedWorkdays: text(employee.fixedWorkdays),
    positionId: text(employee.positionId),
    timeConfirmationLevel: text(employee.timeConfirmationLevel),
    sicknessWithoutAumEnabled: boolean(employee.sicknessWithoutAumEnabled),
    homeLocationId: nullableText(employee.homeLocationId),
    preferredDepartmentId: nullableSafeInteger(employee.preferredDepartmentId, operation),
    costCenterId: nullableText(employee.costCenterId),
    active: boolean(employee.active),
  };
}

function locationParameters(value, operation) {
  const location = record(value, operation);
  return {
    id: text(location.id),
    name: text(location.name),
    costCenterId: text(location.costCenterId),
    minStaff: safeInteger(location.minStaff, operation),
    daySettingsJson: text(location.daySettingsJson),
    timeTrackingEnabled: boolean(location.timeTrackingEnabled),
    timeTrackingAccessMode: text(location.timeTrackingAccessMode),
    timeTrackingAllowedNetworks: text(location.timeTrackingAllowedNetworks),
    timeTrackingVarianceMinutes: safeInteger(location.timeTrackingVarianceMinutes, operation),
    active: boolean(location.active),
  };
}

function normalizedEmployeeRow(row) {
  if (!row) return row;
  return {
    ...row,
    contracted_hours: Number(row.contracted_hours),
  };
}

function executorMethods(access) {
  return Object.freeze({
    getScheduleNote(locationId, departmentKey, weekStart) {
      return access.queryOne(S.getScheduleNote, {
        locationId: text(locationId),
        departmentKey: text(departmentKey),
        weekStart: text(weekStart),
      });
    },
    getPersonnelSensitiveRecord(employeeNumber) {
      return access.queryOne(S.getPersonnelSensitiveRecord, {
        employeeNumber: text(employeeNumber),
      });
    },
    listCostCenterTypes(includeInactive = true) {
      return access.queryAll(S.listCostCenterTypes, {
        includeInactive: boolean(includeInactive),
      });
    },
    listCostCenterTypePositions() {
      return access.queryAll(S.listCostCenterTypePositions, {});
    },
    listCostCenters(includeInactive = true) {
      return access.queryAll(S.listCostCenters, {
        includeInactive: boolean(includeInactive),
      });
    },
    listPositions() {
      return access.queryAll(S.listPositions, {});
    },
    listLocations(includeInactive = true) {
      return access.queryAll(S.listLocations, {
        includeInactive: boolean(includeInactive),
      });
    },
    listDepartments(includeInactive = true) {
      return access.queryAll(S.listDepartments, {
        includeInactive: boolean(includeInactive),
      });
    },
    getPortalAccessProjection(employeeNumber) {
      return access.queryOne(S.getPortalAccessProjection, {
        employeeNumber: text(employeeNumber),
      });
    },
    listPortalPermissionGrants(employeeNumber) {
      return access.queryAll(S.listPortalPermissionGrants, {
        employeeNumber: text(employeeNumber),
      }).then((rows) => rows.map((row) => row.permission));
    },
    listPortalPermissionDenials(employeeNumber) {
      return access.queryAll(S.listPortalPermissionDenials, {
        employeeNumber: text(employeeNumber),
      }).then((rows) => rows.map((row) => row.permission));
    },
    getPersonnelLearningPermissionDenialAuthority(employeeNumber, permission) {
      return access.queryOne(S.getPersonnelLearningPermissionDenialAuthority, {
        employeeNumber: requiredText(
          employeeNumber,
          "getPersonnelLearningPermissionDenialAuthority",
        ),
        permission: requiredText(
          permission,
          "getPersonnelLearningPermissionDenialAuthority",
        ),
      });
    },
    listPortalAccessScopes(employeeNumber) {
      return access.queryAll(S.listPortalAccessScopes, {
        employeeNumber: text(employeeNumber),
      });
    },
    listPortalPermissionScopeGrants(employeeNumber) {
      return access.queryAll(S.listPortalPermissionScopeGrants, {
        employeeNumber: requiredText(employeeNumber, "listPortalPermissionScopeGrants"),
      });
    },
    listPortalRoles() {
      return access.queryAll(S.listPortalRoles, {});
    },
    listPortalUsersForAdmin() {
      return access.queryAll(S.listPortalUsersForAdmin, {});
    },
    portalRoleExists(id) {
      return access.queryOne(S.portalRoleExists, { id: text(id) }).then(Boolean);
    },
    getPortalRoleProjection(id) {
      return access.queryOne(S.getPortalRoleProjection, { id: text(id) });
    },
    getPortalMutationTarget(employeeNumber) {
      return access.queryOne(S.getPortalMutationTarget, {
        employeeNumber: text(employeeNumber),
      });
    },
    getEmployeeScopeProjection(employeeNumber) {
      return access.queryOne(S.getEmployeeScopeProjection, {
        employeeNumber: text(employeeNumber),
      });
    },
    getEmployeeProfileOverviewProjection(employeeNumber) {
      return access.queryOne(S.getEmployeeProfileOverviewProjection, {
        employeeNumber: requiredText(employeeNumber, "getEmployeeProfileOverviewProjection"),
      });
    },
    employeeExists(employeeNumber) {
      return access.queryOne(S.employeeExists, {
        employeeNumber: text(employeeNumber),
      }).then(Boolean);
    },
    getPortalUserAccountProjection(employeeNumber) {
      return access.queryOne(S.getPortalUserAccountProjection, {
        employeeNumber: text(employeeNumber),
      });
    },
    getPortalScopeAssignmentTarget(employeeNumber) {
      return access.queryOne(S.getPortalScopeAssignmentTarget, {
        employeeNumber: text(employeeNumber),
      });
    },
    listOrganizationAccounts() {
      return access.queryAll(S.listOrganizationAccounts, {});
    },
    getOrganizationAccount(accountId) {
      return access.queryOne(S.getOrganizationAccount, {
        accountId: text(accountId),
      });
    },
    organizationAccountLoginCollision(loginName) {
      return access.queryOne(S.organizationAccountLoginCollision, {
        loginName: text(loginName),
      }).then(Boolean);
    },
    listPersonnelFieldPermissions(role) {
      return access.queryAll(S.listPersonnelFieldPermissions, {
        role: text(role),
      });
    },
    activeDepartmentManagerDelegation(employeeNumber, locationId, date) {
      return access.queryOne(S.activeDepartmentManagerDelegation, {
        employeeNumber: text(employeeNumber),
        locationId: text(locationId),
        date: text(date),
      }).then(Boolean);
    },
    activeLocationManagerPresent(locationId, date) {
      return access.queryOne(S.activeLocationManagerPresent, {
        locationId: text(locationId),
        date: text(date),
      }).then(Boolean);
    },
    listApprovalDelegations() {
      return access.queryAll(S.listApprovalDelegations, {});
    },
    eligibleDepartmentManagerForLocation(employeeNumber, locationId) {
      return access.queryOne(S.eligibleDepartmentManagerForLocation, {
        employeeNumber: text(employeeNumber),
        locationId: text(locationId),
      }).then(Boolean);
    },
    upsertScheduleNote(note) {
      const value = record(note, "upsertScheduleNote");
      return access.execute(S.upsertScheduleNote, {
        locationId: text(value.locationId),
        departmentKey: text(value.departmentKey),
        weekStart: text(value.weekStart),
        noteText: text(value.noteText),
        noteHtml: text(value.noteHtml),
        fontSize: text(value.fontSize),
        bold: boolean(value.bold),
        italic: boolean(value.italic),
        underline: boolean(value.underline),
      });
    },
    deleteScheduleNote(locationId, departmentKey, weekStart) {
      return access.execute(S.deleteScheduleNote, {
        locationId: text(locationId),
        departmentKey: text(departmentKey),
        weekStart: text(weekStart),
      });
    },
    findCostCenterIdByCode(code) {
      return access.queryOne(S.findCostCenterIdByCode, { code: text(code) });
    },
    costCenterIdExists(id) {
      return access.queryOne(S.costCenterIdExists, { id: text(id) })
        .then(Boolean);
    },
    insertAutomaticBranchCostCenter(value) {
      const center = record(value, "insertAutomaticBranchCostCenter");
      return access.execute(S.insertAutomaticBranchCostCenter, {
        id: text(center.id),
        code: text(center.code),
        name: text(center.name),
        sortOrder: safeInteger(center.sortOrder, "insertAutomaticBranchCostCenter"),
        actor: text(center.actor),
      });
    },
    insertLocation(location) {
      return access.execute(S.insertLocation, locationParameters(location, "insertLocation"));
    },
    updateLocation(location) {
      return access.execute(S.updateLocation, locationParameters(location, "updateLocation"));
    },
    insertAccessScopeIgnore(scope) {
      const value = record(scope, "insertAccessScopeIgnore");
      return access.execute(S.insertAccessScopeIgnore, {
        employeeNumber: text(value.employeeNumber),
        locationId: text(value.locationId),
        departmentId: safeInteger(value.departmentId, "insertAccessScopeIgnore"),
        assignedBy: text(value.assignedBy),
      });
    },
    insertAccessScope(scope) {
      const value = record(scope, "insertAccessScope");
      return access.execute(S.insertAccessScope, {
        employeeNumber: text(value.employeeNumber),
        locationId: text(value.locationId),
        departmentId: safeInteger(value.departmentId, "insertAccessScope"),
        assignedBy: text(value.assignedBy),
      });
    },
    nextDepartmentSortOrder(locationId) {
      return access.queryOne(S.nextDepartmentSortOrder, { locationId: text(locationId) })
        .then((row) => row.next);
    },
    async insertDepartment(department, sortOrder) {
      const value = record(department, "insertDepartment");
      const result = await access.execute(S.insertDepartment, {
        locationId: text(value.locationId),
        name: text(value.name),
        minStaff: safeInteger(value.minStaff, "insertDepartment"),
        active: boolean(value.active),
        sortOrder: safeInteger(sortOrder, "insertDepartment"),
      });
      const id = result.returnedRows[0]?.id;
      if (!Number.isSafeInteger(id)) throw invalidInput("insertDepartment");
      return id;
    },
    countDepartmentShifts(id) {
      return access.queryOne(S.countDepartmentShifts, {
        id: safeInteger(id, "countDepartmentShifts"),
      }).then((row) => row.count);
    },
    countDepartmentLearningModuleVersionScopes(id) {
      return access.queryOne(S.countDepartmentLearningModuleVersionScopes, {
        id: safeInteger(id, "countDepartmentLearningModuleVersionScopes"),
      }).then((row) => row.count);
    },
    updateDepartment(department, id) {
      const value = record(department, "updateDepartment");
      return access.execute(S.updateDepartment, {
        id: safeInteger(id, "updateDepartment"),
        locationId: text(value.locationId),
        name: text(value.name),
        minStaff: safeInteger(value.minStaff, "updateDepartment"),
        active: boolean(value.active),
      });
    },
    costCenterAssignments(id) {
      return access.queryOne(S.costCenterAssignments, { id: text(id) });
    },
    insertCostCenterType(id, value, actor) {
      const type = record(value, "insertCostCenterType");
      return access.execute(S.insertCostCenterType, {
        id: text(id),
        code: text(type.code),
        name: text(type.name),
        description: text(type.description),
        isBranch: boolean(type.isBranch),
        active: boolean(type.active),
        sortOrder: safeInteger(type.sortOrder, "insertCostCenterType"),
        actor: text(actor),
      });
    },
    getCostCenterType(id) {
      return access.queryOne(S.getCostCenterType, { id: text(id) });
    },
    listCostCenterTypePositionIds(id) {
      return access.queryAll(S.listCostCenterTypePositionIds, { id: text(id) })
        .then((rows) => rows.map((row) => row.position_id));
    },
    updateCostCenterType(id, value, actor) {
      const type = record(value, "updateCostCenterType");
      return access.execute(S.updateCostCenterType, {
        id: text(id),
        name: text(type.name),
        description: text(type.description),
        isBranch: boolean(type.isBranch),
        active: boolean(type.active),
        sortOrder: safeInteger(type.sortOrder, "updateCostCenterType"),
        actor: text(actor),
      });
    },
    archiveCostCenterType(id, actor) {
      return access.execute(S.archiveCostCenterType, { id: text(id), actor: text(actor) });
    },
    async replaceCostCenterTypePositions(id, positionIds) {
      if (!Array.isArray(positionIds)) throw invalidInput("replaceCostCenterTypePositions");
      await access.execute(S.deleteCostCenterTypePositions, { id: text(id) });
      for (let index = 0; index < positionIds.length; index += 1) {
        await access.execute(S.insertCostCenterTypePosition, {
          id: text(id),
          positionId: text(positionIds[index]),
          sortOrder: index + 1,
        });
      }
    },
    insertCostCenter(id, value, actor) {
      const center = record(value, "insertCostCenter");
      return access.execute(S.insertCostCenter, {
        id: text(id),
        code: text(center.code),
        name: text(center.name),
        type: text(center.type),
        costCenterTypeId: text(center.costCenterTypeId),
        description: text(center.description),
        active: boolean(center.active),
        sortOrder: safeInteger(center.sortOrder, "insertCostCenter"),
        actor: text(actor),
      });
    },
    getCostCenter(id) {
      return access.queryOne(S.getCostCenter, { id: text(id) });
    },
    costCenterHasEmployee(id) {
      return access.queryOne(S.costCenterHasEmployee, { id: text(id) }).then(Boolean);
    },
    costCenterHasLocation(id) {
      return access.queryOne(S.costCenterHasLocation, { id: text(id) }).then(Boolean);
    },
    updateCostCenter(id, value, actor) {
      const center = record(value, "updateCostCenter");
      return access.execute(S.updateCostCenter, {
        id: text(id),
        code: text(center.code),
        name: text(center.name),
        type: text(center.type),
        costCenterTypeId: text(center.costCenterTypeId),
        description: text(center.description),
        active: boolean(center.active),
        sortOrder: safeInteger(center.sortOrder, "updateCostCenter"),
        actor: text(actor),
      });
    },
    archiveCostCenter(id, actor) {
      return access.execute(S.archiveCostCenter, { id: text(id), actor: text(actor) });
    },
    listPersonnelDirectory() {
      return access.queryAll(S.listPersonnelDirectory, {})
        .then((rows) => rows.map(normalizedEmployeeRow));
    },
    nextPositionSortOrder() {
      return access.queryOne(S.nextPositionSortOrder, {}).then((row) => row.next);
    },
    insertPosition(position, sortOrder) {
      const value = record(position, "insertPosition");
      return access.execute(S.insertPosition, {
        id: text(value.id),
        name: text(value.name),
        sortOrder: safeInteger(sortOrder, "insertPosition"),
      });
    },
    getPosition(id) {
      return access.queryOne(S.getPosition, { id: text(id) });
    },
    updatePosition(id, name) {
      return access.execute(S.updatePosition, { id: text(id), name: text(name) });
    },
    countPositionTypeAssignments(id) {
      return access.queryOne(S.countPositionTypeAssignments, { id: text(id) })
        .then((row) => row.count);
    },
    reassignEmployeesFromPosition(id) {
      return access.execute(S.reassignEmployeesFromPosition, { id: text(id) });
    },
    deletePosition(id) {
      return access.execute(S.deletePosition, { id: text(id) });
    },
    listEmployees() {
      return access.queryAll(S.listEmployees, {})
        .then((rows) => rows.map(normalizedEmployeeRow));
    },
    insertEmployee(employee) {
      return access.execute(S.insertEmployee, employeeParameters(employee, "insertEmployee"));
    },
    getEmployeeForUpdate(personnelNumber) {
      return access.queryOne(S.getEmployeeForUpdate, { personnelNumber: text(personnelNumber) });
    },
    updateEmployee(employee) {
      return access.execute(S.updateEmployee, employeeParameters(employee, "updateEmployee"));
    },
    getEmployeeDisplay(personnelNumber) {
      return access.queryOne(S.getEmployeeDisplay, { personnelNumber: text(personnelNumber) });
    },
    getEmployeeIdentity(personnelNumber) {
      return access.queryOne(S.getEmployeeIdentity, { personnelNumber: text(personnelNumber) });
    },
    updateEmployeeDisplay(personnelNumber, color, nickname) {
      return access.execute(S.updateEmployeeDisplay, {
        personnelNumber: text(personnelNumber),
        color: text(color),
        nickname: text(nickname),
      });
    },
    getEmployeeActivation(personnelNumber) {
      return access.queryOne(S.getEmployeeActivation, { personnelNumber: text(personnelNumber) });
    },
    deactivateEmployee(personnelNumber) {
      return access.execute(S.deactivateEmployee, { personnelNumber: text(personnelNumber) });
    },
    countOtherSystemOwners(employeeNumber) {
      return access.queryOne(S.countOtherSystemOwners, { employeeNumber: text(employeeNumber) })
        .then((row) => row.count);
    },
    upsertPortalUserRole(employeeNumber, role) {
      return access.execute(S.upsertPortalUserRole, {
        employeeNumber: text(employeeNumber),
        role: text(role),
      });
    },
    deletePermissionGrants(employeeNumber) {
      return access.execute(S.deletePermissionGrants, { employeeNumber: text(employeeNumber) });
    },
    deletePermissionDenials(employeeNumber) {
      return access.execute(S.deletePermissionDenials, { employeeNumber: text(employeeNumber) });
    },
    insertPermissionGrant(employeeNumber, permission, actor) {
      return access.execute(S.insertPermissionGrant, {
        employeeNumber: text(employeeNumber),
        permission: text(permission),
        actor: text(actor),
      });
    },
    deletePermissionGrant(employeeNumber, permission) {
      return access.execute(S.deletePermissionGrant, {
        employeeNumber: text(employeeNumber),
        permission: text(permission),
      });
    },
    deletePermissionScopeGrants(employeeNumber, permission) {
      return access.execute(S.deletePermissionScopeGrants, {
        employeeNumber: requiredText(employeeNumber, "deletePermissionScopeGrants"),
        permission: requiredText(permission, "deletePermissionScopeGrants"),
        all: 1,
        locationId: "",
        departmentId: 0,
      });
    },
    deletePermissionScopeGrant(value) {
      const scope = record(value, "deletePermissionScopeGrant");
      const departmentId = safeInteger(scope.departmentId, "deletePermissionScopeGrant");
      if (departmentId < 0) throw invalidInput("deletePermissionScopeGrant");
      return access.execute(S.deletePermissionScopeGrants, {
        employeeNumber: requiredText(scope.employeeNumber, "deletePermissionScopeGrant"),
        permission: requiredText(scope.permission, "deletePermissionScopeGrant"),
        all: 0,
        locationId: requiredText(scope.locationId, "deletePermissionScopeGrant"),
        departmentId,
      });
    },
    insertPermissionScopeGrant(value) {
      const scope = record(value, "insertPermissionScopeGrant");
      const departmentId = safeInteger(scope.departmentId, "insertPermissionScopeGrant");
      if (departmentId < 0) throw invalidInput("insertPermissionScopeGrant");
      return access.execute(S.insertPermissionScopeGrant, {
        employeeNumber: requiredText(scope.employeeNumber, "insertPermissionScopeGrant"),
        permission: requiredText(scope.permission, "insertPermissionScopeGrant"),
        locationId: requiredText(scope.locationId, "insertPermissionScopeGrant"),
        departmentId,
        approvedBy: requiredText(scope.approvedBy, "insertPermissionScopeGrant"),
      });
    },
    insertPermissionDenial(employeeNumber, permission, actor) {
      return access.execute(S.insertPermissionDenial, {
        employeeNumber: text(employeeNumber),
        permission: text(permission),
        actor: text(actor),
      });
    },
    deletePermissionDenial(employeeNumber, permission) {
      return access.execute(S.deletePermissionDenial, {
        employeeNumber: text(employeeNumber),
        permission: text(permission),
      });
    },
    upsertPersonnelLearningPermissionDenialAuthority(value) {
      const authority = record(
        value,
        "upsertPersonnelLearningPermissionDenialAuthority",
      );
      const employeeNumber = requiredText(
        authority.employeeNumber,
        "upsertPersonnelLearningPermissionDenialAuthority",
      );
      const permission = requiredText(
        authority.permission,
        "upsertPersonnelLearningPermissionDenialAuthority",
      );
      const authorityLevel = requiredText(
        authority.authorityLevel,
        "upsertPersonnelLearningPermissionDenialAuthority",
      );
      const scopeLocationId = text(authority.scopeLocationId).trim();
      const actor = requiredText(
        authority.actor,
        "upsertPersonnelLearningPermissionDenialAuthority",
      );
      if (permission !== "personnel:learning:cross_location:assign"
        || !["pl_plus", "manager"].includes(authorityLevel)
        || (authorityLevel === "pl_plus" && scopeLocationId)
        || (authorityLevel === "manager" && !scopeLocationId)) {
        throw invalidInput("upsertPersonnelLearningPermissionDenialAuthority");
      }
      return access.execute(S.upsertPersonnelLearningPermissionDenialAuthority, {
        employeeNumber,
        permission,
        authorityLevel,
        scopeLocationId,
        actor,
      });
    },
    deletePersonnelLearningPermissionDenialAuthority(employeeNumber, permission) {
      return access.execute(S.deletePersonnelLearningPermissionDenialAuthority, {
        employeeNumber: requiredText(
          employeeNumber,
          "deletePersonnelLearningPermissionDenialAuthority",
        ),
        permission: requiredText(
          permission,
          "deletePersonnelLearningPermissionDenialAuthority",
        ),
      });
    },
    deleteAccessScopes(employeeNumber) {
      return access.execute(S.deleteAccessScopes, {
        employeeNumber: text(employeeNumber),
        all: 1,
        locationId: "",
        departmentId: 0,
      });
    },
    deleteAccessScope(value) {
      const scope = record(value, "deleteAccessScope");
      const departmentId = safeInteger(scope.departmentId, "deleteAccessScope");
      if (departmentId < 0) throw invalidInput("deleteAccessScope");
      return access.execute(S.deleteAccessScopes, {
        employeeNumber: requiredText(scope.employeeNumber, "deleteAccessScope"),
        all: 0,
        locationId: requiredText(scope.locationId, "deleteAccessScope"),
        departmentId,
      });
    },
    upsertPortalUserAccount(value) {
      const user = record(value, "upsertPortalUserAccount");
      return access.execute(S.upsertPortalUserAccount, {
        employeeNumber: text(user.employeeNumber),
        passwordHash: text(user.passwordHash),
        role: text(user.role),
        active: boolean(user.active),
        mustChangePassword: boolean(user.mustChangePassword),
        passwordChanged: boolean(user.passwordChanged),
      });
    },
    unlockPortalUser(employeeNumber) {
      return access.execute(S.unlockPortalUser, {
        employeeNumber: text(employeeNumber),
      });
    },
    updatePortalUserPassword(employeeNumber, passwordHash) {
      return access.execute(S.updatePortalUserPassword, {
        employeeNumber: text(employeeNumber),
        passwordHash: text(passwordHash),
      });
    },
    insertOrganizationAccount(value) {
      const account = record(value, "insertOrganizationAccount");
      return access.execute(S.insertOrganizationAccount, {
        accountId: text(account.accountId),
        loginName: text(account.loginName),
        displayName: text(account.displayName),
        accountType: text(account.accountType),
        passwordHash: text(account.passwordHash),
        active: boolean(account.active),
        mustChangePassword: boolean(account.mustChangePassword),
        passwordChanged: boolean(account.passwordChanged),
        actor: text(account.actor),
      });
    },
    updateOrganizationAccount(value) {
      const account = record(value, "updateOrganizationAccount");
      return access.execute(S.updateOrganizationAccount, {
        accountId: text(account.accountId),
        displayName: text(account.displayName),
        accountType: text(account.accountType),
        passwordHash: text(account.passwordHash),
        active: boolean(account.active),
        passwordChanged: boolean(account.passwordChanged),
        actor: text(account.actor),
      });
    },
    unlockOrganizationAccount(accountId, actor) {
      return access.execute(S.unlockOrganizationAccount, {
        accountId: text(accountId),
        actor: text(actor),
      });
    },
    updateOrganizationAccountPassword(accountId, passwordHash, actor) {
      return access.execute(S.updateOrganizationAccountPassword, {
        accountId: text(accountId),
        passwordHash: text(passwordHash),
        actor: text(actor),
      });
    },
    deleteOrganizationAccountPermissions(accountId) {
      return access.execute(S.deleteOrganizationAccountPermissions, {
        accountId: text(accountId),
      });
    },
    insertOrganizationAccountPermission(accountId, permission, actor) {
      return access.execute(S.insertOrganizationAccountPermission, {
        accountId: text(accountId),
        permission: text(permission),
        actor: text(actor),
      });
    },
    deleteOrganizationAccountScopes(accountId) {
      return access.execute(S.deleteOrganizationAccountScopes, {
        accountId: text(accountId),
      });
    },
    insertOrganizationAccountScope(accountId, locationId, actor) {
      return access.execute(S.insertOrganizationAccountScope, {
        accountId: text(accountId),
        locationId: text(locationId),
        actor: text(actor),
      });
    },
    revokeOrganizationSessions(accountId) {
      return access.execute(S.revokeOrganizationSessions, {
        accountId: text(accountId),
      });
    },
    deletePersonnelFieldPermissions(role) {
      return access.execute(S.deletePersonnelFieldPermissions, {
        role: text(role),
      });
    },
    insertPersonnelFieldPermission(role, fieldKey, accessLevel, actor) {
      return access.execute(S.insertPersonnelFieldPermission, {
        role: text(role),
        fieldKey: text(fieldKey),
        accessLevel: text(accessLevel),
        actor: text(actor),
      });
    },
    upsertManagerAmuDefault(enabled) {
      return access.execute(S.upsertManagerAmuDefault, {
        enabled: boolean(enabled),
      });
    },
    deleteManagerAmuOverrides() {
      return access.execute(S.deleteManagerAmuOverrides, {});
    },
    insertManagerAmuOverride(employeeNumber, accessMode, actor) {
      return access.execute(S.insertManagerAmuOverride, {
        employeeNumber: text(employeeNumber),
        accessMode: text(accessMode),
        actor: text(actor),
      });
    },
    insertApprovalDelegation(value) {
      const delegation = record(value, "insertApprovalDelegation");
      return access.execute(S.insertApprovalDelegation, {
        locationId: text(delegation.locationId),
        employeeNumber: text(delegation.employeeNumber),
        dateFrom: text(delegation.dateFrom),
        dateTo: text(delegation.dateTo),
        note: text(delegation.note),
        actor: text(delegation.actor),
      });
    },
    deleteApprovalDelegation(id) {
      return access.execute(S.deleteApprovalDelegation, {
        id: safeInteger(id, "deleteApprovalDelegation"),
      });
    },
    disablePortalUser(employeeNumber) {
      return access.execute(S.disablePortalUser, { employeeNumber: text(employeeNumber) });
    },
    revokePortalSessions(employeeNumber) {
      return access.execute(S.revokePortalSessions, { employeeNumber: text(employeeNumber) });
    },
    revokeMobileSessions(employeeNumber, reason) {
      return access.execute(S.revokeMobileSessions, {
        employeeNumber: text(employeeNumber),
        reason: text(reason).slice(0, 80),
      });
    },
    upsertPersonnelSensitiveRecord(value) {
      const prepared = record(value, "upsertPersonnelSensitiveRecord");
      return access.execute(S.upsertPersonnelSensitiveRecord, {
        employeeNumber: text(prepared.employeeNumber),
        socialSecurityLookup: text(prepared.socialSecurityLookup),
        protectedPayload: text(prepared.protectedPayload),
        actor: text(prepared.actor),
      });
    },
    insertAudit(actor, action, entityType = "", entityId = "", detail = "") {
      return access.execute(S.insertAudit, {
        actor: text(actor),
        action: text(action),
        entityType: text(entityType),
        entityId: text(entityId),
        detail: text(detail).slice(0, 2000),
      });
    },
    async applyAccessProfile(actor, profile, before = null) {
      if (!profile) return;
      const employeeNumber = text(profile.employeeNumber);
      const desiredPermissions = new Set((profile.permissions || []).map(text).filter(Boolean));
      const currentPermissions = new Set(await this.listPortalPermissionGrants(employeeNumber));
      const currentDenials = await this.listPortalPermissionDenials(employeeNumber);
      const currentScopes = await this.listPortalAccessScopes(employeeNumber);
      const desiredScopes = ["location_planner", "manager", "department_manager"].includes(profile.role)
        ? [{
          locationId: text(profile.homeLocationId),
          departmentId: profile.role === "department_manager"
            ? safeInteger(profile.preferredDepartmentId, "applyAccessProfile")
            : 0,
        }]
        : [];
      const scopeKey = (scope) => [
        text(scope.locationId ?? scope.location_id),
        safeInteger(scope.departmentId ?? scope.department_id ?? 0, "applyAccessProfile"),
      ].join("\0");
      const currentScopeKeys = new Set(currentScopes.map(scopeKey));
      const desiredScopeKeys = new Set(desiredScopes.map(scopeKey));

      await this.upsertPortalUserRole(employeeNumber, profile.role);
      for (const permission of desiredPermissions) {
        if (!currentPermissions.has(permission)) {
          await this.insertPermissionGrant(employeeNumber, permission, actor.employeeNumber);
        }
      }
      for (const permission of currentPermissions) {
        if (!desiredPermissions.has(permission)) {
          await this.deletePermissionGrant(employeeNumber, permission);
        }
      }
      for (const permission of currentDenials) {
        if (permission === "personnel:learning:cross_location:assign") {
          continue;
        }
        await this.deletePermissionDenial(employeeNumber, permission);
      }
      for (const scope of desiredScopes) {
        if (currentScopeKeys.has(scopeKey(scope))) continue;
        await this.insertAccessScope({
          employeeNumber,
          locationId: scope.locationId,
          departmentId: scope.departmentId,
          assignedBy: actor.employeeNumber,
        });
      }
      for (const scope of currentScopes) {
        if (desiredScopeKeys.has(scopeKey(scope))) continue;
        await this.deleteAccessScope({
          employeeNumber,
          locationId: scope.location_id,
          departmentId: safeInteger(scope.department_id || 0, "applyAccessProfile"),
        });
      }
      await this.insertAudit(
        actor.employeeNumber,
        "employee.access-profile.update",
        "portal_user",
        employeeNumber,
        JSON.stringify({
          roleBefore: before?.role || null,
          roleAfter: profile.role,
          grantsBefore: before?.grantedPermissions || [],
          grantsAfter: profile.permissions || [],
        }),
      );
      await this.revokePortalSessions(employeeNumber);
      await this.revokeMobileSessions(employeeNumber, "access_profile_changed");
    },
    async deactivatePortalAccess(employeeNumber, reason = "employee_deactivated") {
      await this.disablePortalUser(employeeNumber);
      await this.revokePortalSessions(employeeNumber);
      await this.revokeMobileSessions(employeeNumber, reason);
    },
  });
}

function createOrganizationPersonnelRepository(access) {
  assertPersistenceAccess(access);
  const methods = executorMethods(access);
  const repository = Object.freeze({
    ...methods,
    ...(typeof access.transaction === "function" ? {
      transaction(work, options) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => work(executorMethods(executor)), options);
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertOrganizationPersonnelRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Organisations- und Personal-Repository wird benoetigt.");
  }
  return repository;
}

module.exports = {
  assertOrganizationPersonnelRepository,
  createOrganizationPersonnelRepository,
};
