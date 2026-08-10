const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("Developer-Rolle erhält dauerhaft den vollständigen bekannten App-Rechtekatalog", () => {
  assert.match(serverSource, /if \(String\(role \|\| ""\) === "developer"\) return true/);
  assert.match(
    serverSource,
    /addBuiltinRolePermissions\(\s*"developer",\s*delegablePortalPermissionCatalog\.map\(\(permission\) => permission\.id\)/,
  );
  assert.doesNotMatch(
    serverSource,
    /addBuiltinRolePermissions\(\s*"(?:it_admin|admin|hr)",\s*delegablePortalPermissionCatalog\.map/,
  );
});

test("Developer-Rolle wird nur offline gebunden und dauerhaft geschützt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-developer-role-"));
  const databasePath = path.join(root, "dienstplan.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL
    );
    CREATE TABLE portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      role_locked INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE portal_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO employees (personnel_number, full_name) VALUES ('252', 'Christian Test'), ('253', 'Andere Person');
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password)
      VALUES ('252', 'vorhandener-hash', 'admin', 1, 0);
    INSERT INTO portal_sessions (id, employee_number) VALUES ('session-1', '252');
  `);
  database.close();

  try {
    const script = path.join(__dirname, "..", "scripts", "set-developer.js");
    const missingPortalAccount = spawnSync(process.execPath, [script, "--employee-number", "253", "--database", databasePath], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(missingPortalAccount.status, 0);
    assert.match(missingPortalAccount.stderr, /Portal-Zugang mit Passwort/i);

    const result = spawnSync(process.execPath, [script, "--employee-number", "252", "--database", databasePath], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    const user = verified.prepare("SELECT role, role_locked, active, password_hash FROM portal_users WHERE employee_number = '252'").get();
    assert.deepEqual({ ...user }, { role: "developer", role_locked: 1, active: 1, password_hash: "vorhandener-hash" });
    assert.ok(verified.prepare("SELECT revoked_at FROM portal_sessions WHERE id = 'session-1'").get().revoked_at);
    assert.ok(verified.prepare("SELECT 1 FROM audit_log WHERE action = 'portal.developer.bind' AND entity_id = '252'").get());
    verified.close();
    assert.equal(fs.readdirSync(root).filter((name) => name.startsWith("developer-binding-backup-") && name.endsWith(".db")).length, 1);

    const secondDeveloper = spawnSync(process.execPath, [script, "--employee-number", "253", "--database", databasePath], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(secondDeveloper.status, 0);
    assert.match(secondDeveloper.stderr, /bereits ein Developer-Zugang/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
