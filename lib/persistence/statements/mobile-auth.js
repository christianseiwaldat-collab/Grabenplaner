"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id) {
  return definePersistenceStatement({
    id: `mobile-auth.${id}`,
    operation: "queryOne",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function queryAll(id) {
  return definePersistenceStatement({
    id: `mobile-auth.${id}`,
    operation: "queryAll",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function execute(id) {
  return definePersistenceStatement({
    id: `mobile-auth.${id}`,
    operation: "execute",
    parameters: JSON_PARAMETER,
  });
}

const MOBILE_AUTH_STATEMENTS = Object.freeze({
  getSession: queryOne("get-session"),
  getMutationReceipt: queryOne("get-mutation-receipt"),
  getMutationReceiptStatus: queryOne("get-mutation-receipt-status"),
  getPortalPasswordHash: queryOne("get-portal-password-hash"),
  getPortalPasswordMetadata: queryOne("get-portal-password-metadata"),
  listActiveSessionIds: queryAll("list-active-session-ids"),
  refreshTokenWasConsumed: queryOne("refresh-token-was-consumed"),

  touchSession: execute("touch-session"),
  purgeExpiredMutationReceipts: execute("purge-expired-mutation-receipts"),
  finalizeRecoveredMutationReceipt: execute("finalize-recovered-mutation-receipt"),
  insertMutationReceipt: execute("insert-mutation-receipt"),
  finalizeMutationReceipt: execute("finalize-mutation-receipt"),
  deleteInProgressMutationReceipt: execute("delete-in-progress-mutation-receipt"),
  preserveMutationReceiptAction: execute("preserve-mutation-receipt-action"),
  revokeEmployeeMobileSessions: execute("revoke-employee-mobile-sessions"),
  revokeEmployeePortalSessions: execute("revoke-employee-portal-sessions"),
  updateMobilePassword: execute("update-mobile-password"),
  purgeExpiredSessions: execute("purge-expired-sessions"),
  revokeDeviceSessions: execute("revoke-device-sessions"),
  revokeSession: execute("revoke-session"),
  insertSession: execute("insert-session"),
  rememberRefreshToken: execute("remember-refresh-token"),
  rotateSession: execute("rotate-session"),
  revokeRefreshReuse: execute("revoke-refresh-reuse"),
  refreshSession: execute("refresh-session"),
});

module.exports = {
  MOBILE_AUTH_STATEMENTS,
};
