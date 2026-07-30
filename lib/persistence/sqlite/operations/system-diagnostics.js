"use strict";

const ALLOWED_PRAGMAS = new Set([
  "busy_timeout",
  "foreign_keys",
  "journal_mode",
  "synchronous",
]);

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  return database;
}

function createSqliteSystemDiagnosticsOperations(database) {
  const connection = assertDatabase(database);
  return Object.freeze({
    sqliteVersion() {
      return String(connection.prepare("SELECT sqlite_version() AS version").get()?.version || "");
    },
    pragmaValue(name) {
      const pragma = String(name || "").trim().toLowerCase();
      if (!ALLOWED_PRAGMAS.has(pragma)) {
        throw new TypeError("Das SQLite-Diagnose-Pragma ist nicht freigegeben.");
      }
      const row = connection.prepare(`PRAGMA ${pragma}`).get();
      return row ? Object.values(row)[0] : null;
    },
    latestMigration() {
      return connection.prepare(`
        SELECT id, app_version, applied_at
        FROM schema_migrations
        ORDER BY applied_at DESC, id DESC
        LIMIT 1
      `).get() || null;
    },
    protectedIntegrationConnectionCount() {
      return Number(connection.prepare(`
        SELECT COUNT(*) AS count
        FROM integration_connections
        WHERE protected_credentials <> '' AND active = 1
      `).get()?.count || 0);
    },
    lockedPortalAccountCount() {
      return Number(connection.prepare(`
        SELECT COUNT(*) AS count
        FROM portal_users
        WHERE locked_until > CURRENT_TIMESTAMP
      `).get()?.count || 0);
    },
    activePortalSessionCount() {
      return Number(connection.prepare(`
        SELECT COUNT(*) AS count
        FROM portal_sessions
        WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      `).get()?.count || 0);
    },
    latestAuditActionCreatedAt(action) {
      if (typeof action !== "string" || !action.trim()) {
        throw new TypeError("Eine Audit-Aktion wird benötigt.");
      }
      return connection.prepare(`
        SELECT created_at
        FROM audit_log
        WHERE action = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(action.trim())?.created_at || null;
    },
  });
}

module.exports = {
  createSqliteSystemDiagnosticsOperations,
};
