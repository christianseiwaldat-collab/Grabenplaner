"use strict";

function ensureSqlitePortalPermissionDefaultsSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(portal_roles)").all().map(row => row.name));
  if (!columns.has("permissions_customized")) db.exec("ALTER TABLE portal_roles ADD COLUMN permissions_customized INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("permissions_revision")) db.exec("ALTER TABLE portal_roles ADD COLUMN permissions_revision INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_position_permission_defaults (
      position_id TEXT PRIMARY KEY REFERENCES positions(id),
      permissions TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIEW IF NOT EXISTS portal_user_roles AS
      SELECT u.employee_number, r.id, r.name, r.description, r.builtin, r.sort_order,
        CASE WHEN u.role = 'developer' THEN r.permissions
          ELSE COALESCE(p.permissions, r.permissions) END AS permissions
      FROM portal_users u
      JOIN employees e ON e.personnel_number = u.employee_number
      LEFT JOIN portal_roles r ON r.id = u.role
      LEFT JOIN portal_position_permission_defaults p ON p.position_id = e.position_id;
  `);
  // Upgrade only the exact previous assignment guards. Unrelated schema drift
  // remains a failure for the existing integrity inspection.
  const definitions = [
    ...require('./personnel-lifecycle-offboarding-schema').PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
    ...require('./personnel-workflow-instance-schema').PERSONNEL_WORKFLOW_INSTANCE_TRIGGER_DEFINITIONS,
  ].filter(item => item.sql.includes('JOIN portal_user_roles portal_role'));
  const normalize = sql => sql.toLowerCase().replace('create trigger if not exists ', 'create trigger ').replace(/\s+/g,' ').trim().replace(/;$/, '');
  for (const expected of definitions) {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(expected.name);
    if (!current?.sql || normalize(current.sql) === normalize(expected.sql)) continue;
    const predecessor = expected.sql.replace(/JOIN portal_user_roles portal_role\s+ON portal_role\.employee_number = portal_user\.employee_number/g,
      'JOIN portal_roles portal_role ON portal_role.id = portal_user.role');
    if (normalize(current.sql) !== normalize(predecessor)) continue;
    db.exec('SAVEPOINT permission_defaults_assignment_guard');
    try {
      db.exec(`DROP TRIGGER "${expected.name}"`);
      db.exec(expected.sql);
      db.exec('RELEASE SAVEPOINT permission_defaults_assignment_guard');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT permission_defaults_assignment_guard');
      db.exec('RELEASE SAVEPOINT permission_defaults_assignment_guard');
      throw error;
    }
  }
}

module.exports = { ensureSqlitePortalPermissionDefaultsSchema };
