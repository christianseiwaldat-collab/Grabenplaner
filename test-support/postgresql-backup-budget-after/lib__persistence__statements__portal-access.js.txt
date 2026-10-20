"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id) {
  return definePersistenceStatement({
    id: `portal-access.${id}`,
    operation: "queryOne",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function queryAll(id) {
  return definePersistenceStatement({
    id: `portal-access.${id}`,
    operation: "queryAll",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function execute(id) {
  return definePersistenceStatement({
    id: `portal-access.${id}`,
    operation: "execute",
    parameters: JSON_PARAMETER,
  });
}

const PORTAL_ACCESS_STATEMENTS = Object.freeze({
  getBackupAdminUser: queryOne("backup-admin-user.get"),
  insertNotification: execute("notification.insert"),
  getNotificationByDedupe: queryOne("notification.get-by-dedupe"),
  reactivateNotification: execute("notification.reactivate"),
  listHrReviewerRecipients: queryAll("reviewer.list-hr"),
  listLocalReviewerRecipients: queryAll("reviewer.list-local"),
  resolveReviewNotifications: execute("notification.resolve-review"),

  getEmployeeSessionByToken: queryOne("employee-session.get-by-token"),
  getReportPrincipal: queryOne("report-principal.get"),
  touchEmployeeSession: execute("employee-session.touch"),
  getOrganizationSessionByToken: queryOne("organization-session.get-by-token"),
  touchOrganizationSession: execute("organization-session.touch"),

  getEmployeeLogin: queryOne("employee-login.get"),
  getOrganizationLogin: queryOne("organization-login.get"),
  updateEmployeeLoginFailure: execute("employee-login.failure"),
  updateOrganizationLoginFailure: execute("organization-login.failure"),
  purgeExpiredOrganizationSessions: execute("organization-session.purge-expired"),
  revokeOrganizationSessionsForAccount: execute("organization-session.revoke-for-account"),
  insertOrganizationSession: execute("organization-session.insert"),
  markOrganizationLoginSuccess: execute("organization-login.success"),
  purgeExpiredEmployeeSessions: execute("employee-session.purge-expired"),
  revokeEmployeeSessionsForEmployee: execute("employee-session.revoke-for-employee"),
  insertEmployeeSession: execute("employee-session.insert"),
  markEmployeeLoginSuccess: execute("employee-login.success"),
  revokeOrganizationSessionById: execute("organization-session.revoke-by-id"),
  revokeEmployeeSessionById: execute("employee-session.revoke-by-id"),
  listPasswordResetCandidates: queryAll("password-reset.list-candidates"),
  countRecentPasswordResetTokens: queryOne("password-reset.count-recent"),
  purgePasswordResetTokens: execute("password-reset.purge"),
  revokePasswordResetTokensForEmployee: execute("password-reset.revoke-for-employee"),
  insertPasswordResetToken: execute("password-reset.insert"),
  revokePasswordResetTokenById: execute("password-reset.revoke-by-id"),
  getPasswordResetTokenByHash: queryOne("password-reset.get-by-hash"),
  consumePasswordResetToken: execute("password-reset.consume"),
  updatePasswordFromReset: execute("password-reset.password-update"),
  revokeMobileSessionsForPasswordReset: execute("password-reset.revoke-mobile-sessions"),
  getActiveHrAccount: queryOne("workflow.active-hr.get"),
  getConfiguredAdmin: queryOne("configured-admin.get"),
  listUsbCreatorCandidates: queryAll("usb-creator.list-candidates"),
  getUsbCreator: queryOne("usb-creator.get"),
});

module.exports = {
  PORTAL_ACCESS_STATEMENTS,
};
