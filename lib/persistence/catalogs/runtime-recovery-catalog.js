"use strict";

const {
  RUNTIME_RECOVERY_STATEMENTS,
} = require("../statements/runtime-recovery");

const SQLITE_RUNTIME_RECOVERY_CATALOG = Object.freeze([
  Object.freeze({
    statement: RUNTIME_RECOVERY_STATEMENTS.amuDocumentCount,
    sql: `
      SELECT COUNT(*) AS count
      FROM amu_documents
      WHERE status <> 'purged'
    `,
    returning: false,
  }),
  Object.freeze({
    statement: RUNTIME_RECOVERY_STATEMENTS.personnelDocumentCount,
    sql: `
      SELECT COUNT(*) AS count
      FROM personnel_record_documents
      WHERE status <> 'purged'
    `,
    returning: false,
  }),
  Object.freeze({
    statement: RUNTIME_RECOVERY_STATEMENTS.markInterruptedNotifications,
    sql: `
      UPDATE outbound_notification_jobs
      SET
        status = 'unknown',
        last_error_code = 'INTERRUPTED_DELIVERY',
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_RUNTIME_RECOVERY_CATALOG,
};
