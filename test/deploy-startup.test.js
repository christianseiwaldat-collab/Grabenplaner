"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openSqliteLegacyDatabase: DatabaseSync } = require("../lib/persistence/sqlite/provider");

test("organization integrity is checked once per migration state and a failed scan is retried", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-startup-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "dienstplan.db");
  const environment = { ...process.env, DB_PATH: file, BACKUP_DIR: path.join(root, "backups"),
    GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_DEMO_PROFILE: "sporthandel",
    GRABENPLANER_TEST_AMU_SCANNER: "clean", NODE_ENV: "test", GRABENPLANER_HOST: "127.0.0.1" };
  function start(failScan = false) {
    const source = `
const org = require('./lib/persistence/sqlite/operations/organization-schema-migrations');
const original = org.runSqliteOrganizationSchemaMigrations;
const scans = [];
org.runSqliteOrganizationSchemaMigrations = (database, options) => original(new Proxy({}, { get(_target, key) {
  const target = database;
  if (key === 'prepare') return sql => {
    if (/^PRAGMA (foreign_key_check|quick_check)$/i.test(sql.trim())) {
      scans.push(sql.trim());
      if (${JSON.stringify(failScan)} && /foreign_key_check/.test(sql)) return { all: () => [{ table: 'synthetic', rowid: 1 }] };
    }
    return target.prepare(sql);
  };
  const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
} }), options);
try { const app = require('./server'); app.db.close(); app.releaseInstanceLockForTests(); console.log('SCAN_RESULT=' + JSON.stringify({ ok: true, scans })); }
catch (error) { console.log('SCAN_RESULT=' + JSON.stringify({ ok: false, scans, error: error.stack })); process.exitCode = 2; }
`;
    const result = spawnSync(process.execPath, ["-e", source], { cwd: path.resolve(__dirname, ".."), env: environment, encoding: "utf8", timeout: 60000 });
    const line = String(result.stdout).split(/\r?\n/).find(row => row.startsWith("SCAN_RESULT="));
    assert.ok(line, result.stderr || result.error?.message);
    return JSON.parse(line.slice(12));
  }
  const first = start(); assert.equal(first.ok, true, first.error); assert.equal(first.scans.length, 2);
  // Some startup migrations run after organization initialization. Their
  // first completed startup is validated too; subsequent starts must be cheap.
  assert.equal(start().ok, true);
  const stable = start(); assert.equal(stable.ok, true); assert.deepEqual(stable.scans, []);
  let database = new DatabaseSync(file);
  database.prepare("DELETE FROM schema_migrations WHERE id LIKE 'organization-integrity-verified-v1:%'").run(); database.close();
  const failed = start(true); assert.equal(failed.ok, false); assert.equal(failed.scans.length, 1);
  database = new DatabaseSync(file, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id LIKE 'organization-integrity-verified-v1:%'").get().n, 0); database.close();
  const retried = start(); assert.equal(retried.ok, true); assert.equal(retried.scans.length, 2);
  assert.deepEqual(start().scans, []);
});
