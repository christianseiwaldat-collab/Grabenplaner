"use strict";

const {
  assertPersistenceAccess,
} = require("../contract");
const {
  RUNTIME_RECOVERY_STATEMENTS,
} = require("../statements/runtime-recovery");

function createRuntimeRecoveryRepository(access) {
  assertPersistenceAccess(access);
  return Object.freeze({
    async protectedDocumentCounts() {
      const [amu, personnel] = await Promise.all([
        access.queryOne(RUNTIME_RECOVERY_STATEMENTS.amuDocumentCount),
        access.queryOne(RUNTIME_RECOVERY_STATEMENTS.personnelDocumentCount),
      ]);
      return Object.freeze({
        amuDocuments: amu?.count || 0,
        personnelDocuments: personnel?.count || 0,
      });
    },
    markInterruptedNotifications() {
      return access.execute(RUNTIME_RECOVERY_STATEMENTS.markInterruptedNotifications);
    },
  });
}

module.exports = {
  createRuntimeRecoveryRepository,
};
