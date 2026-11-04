"use strict";
const { MIGRATION_ID, COLUMNS, REVOKE_SQL } = require("../../schema-definitions/session-security");

function ensureSqliteSessionSecuritySchema(database) {
  database.exec("SAVEPOINT session_security_upgrade");
  try {
    const applied = database.prepare("SELECT id FROM schema_migrations WHERE id=?").get(MIGRATION_ID);
    for (const column of COLUMNS) {
      const existing = database.prepare(`PRAGMA table_info(${column.table})`).all().find(row => row.name === column.name);
      if (!existing) {
        if (applied) throw new Error("SQLITE_SESSION_SECURITY_SCHEMA_DRIFT");
        database.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.definition}`);
      } else if (existing.type.toUpperCase() !== column.definition.split(" ")[0]
        || (column.name === "password_policy_version" && (!existing.notnull || Number(existing.dflt_value) !== 0))) {
        throw new Error("SQLITE_SESSION_SECURITY_SCHEMA_DRIFT");
      }
    }
    if (!applied) {
      for (const sql of REVOKE_SQL) database.exec(sql);
      database.prepare("INSERT INTO schema_migrations(id,app_version) VALUES(?,?)").run(MIGRATION_ID, "0.92.90-beta");
    }
    database.exec("RELEASE SAVEPOINT session_security_upgrade");
    return { applied: !applied };
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT session_security_upgrade");
    database.exec("RELEASE SAVEPOINT session_security_upgrade");
    throw error;
  }
}

module.exports = { MIGRATION_ID, COLUMNS, REVOKE_SQL, ensureSqliteSessionSecuritySchema };
