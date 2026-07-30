"use strict";

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  return database;
}

function createSqliteAuditLogOperations(database) {
  const connection = assertDatabase(database);
  let insertAuditEntry = null;
  return Object.freeze({
    record({
      actor = "",
      action,
      entityType = "",
      entityId = "",
      detail = "",
    } = {}) {
      const normalizedAction = String(action || "").trim();
      if (!normalizedAction || normalizedAction.includes("\0")) {
        throw new TypeError("Eine gültige Audit-Aktion wird benötigt.");
      }
      if (!insertAuditEntry) {
        insertAuditEntry = connection.prepare(`
          INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
          VALUES (?, ?, ?, ?, ?)
        `);
      }
      return Number(insertAuditEntry.run(
        String(actor || ""),
        normalizedAction,
        String(entityType || ""),
        String(entityId || ""),
        String(detail || "").slice(0, 2000),
      ).changes || 0);
    },
  });
}

module.exports = {
  createSqliteAuditLogOperations,
};
