"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `integration-runtime.${id}`,
    operation: "queryOne",
    parameters,
    columns: JSON_ROW,
  });
}

function queryAll(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `integration-runtime.${id}`,
    operation: "queryAll",
    parameters,
    columns: JSON_ROW,
  });
}

function execute(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `integration-runtime.${id}`,
    operation: "execute",
    parameters,
  });
}

const INTEGRATION_RUNTIME_STATEMENTS = Object.freeze({
  listConnections: queryAll("list-connections"),
  getConnection: queryOne("get-connection"),
  locationForCostCenter: queryOne("location-for-cost-center"),
  listProfiles: queryAll("list-profiles"),
  getProfile: queryOne("get-profile"),
  getEmployeeImportRow: queryOne("get-employee-import-row"),
  listEmployeeImportRowsCaseInsensitive: queryAll("list-employee-import-rows-case-insensitive"),
  listPayrollAbsencesForDay: queryAll("list-payroll-absences-for-day"),
  listPayrollEmployees: queryAll("list-payroll-employees"),
  hasPayrollDepartmentActivity: queryOne("has-payroll-department-activity"),
  getPayrollCorrectionState: queryOne("get-payroll-correction-state"),
  listSendingDeliveryIds: queryAll("list-sending-delivery-ids", Object.freeze({})),
  listPayrollHandoffEmployees: queryAll("list-payroll-handoff-employees"),
  listRuns: queryAll("list-runs"),
  listDeliveries: queryAll("list-deliveries"),
  getDeliveryByIdempotencyKey: queryOne("get-delivery-by-idempotency-key"),
  getDelivery: queryOne("get-delivery"),
  getDeliveryStatus: queryOne("get-delivery-status"),

  insertRun: execute("insert-run"),
  insertEmployee: execute("insert-employee"),
  updateEmployee: execute("update-employee"),
  deactivateImportedPortalUser: execute("deactivate-imported-portal-user"),
  revokeImportedPortalSessions: execute("revoke-imported-portal-sessions"),
  revokeImportedMobileSessions: execute("revoke-imported-mobile-sessions"),
  markDeliveryInterrupted: execute("mark-delivery-interrupted"),
  insertConnection: execute("insert-connection"),
  updateConnection: execute("update-connection"),
  disableConnection: execute("disable-connection"),
  recordConnectionTest: execute("record-connection-test"),
  insertProfile: execute("insert-profile"),
  updateProfile: execute("update-profile"),
  deleteProfile: execute("delete-profile"),
  insertDelivery: execute("insert-delivery"),
  claimDelivery: execute("claim-delivery"),
  completeDelivery: execute("complete-delivery"),
  failDelivery: execute("fail-delivery"),
});

module.exports = {
  INTEGRATION_RUNTIME_STATEMENTS,
};
