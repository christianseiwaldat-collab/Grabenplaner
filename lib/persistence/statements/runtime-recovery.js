"use strict";

const { definePersistenceStatement } = require("../contract");

const RUNTIME_RECOVERY_STATEMENTS = Object.freeze({
  amuDocumentCount: definePersistenceStatement({
    id: "runtime-recovery.amu-document-count",
    operation: "queryOne",
    columns: { count: "safe_integer" },
  }),
  personnelDocumentCount: definePersistenceStatement({
    id: "runtime-recovery.personnel-document-count",
    operation: "queryOne",
    columns: { count: "safe_integer" },
  }),
  markInterruptedNotifications: definePersistenceStatement({
    id: "runtime-recovery.mark-interrupted-notifications",
    operation: "execute",
  }),
});

module.exports = {
  RUNTIME_RECOVERY_STATEMENTS,
};
