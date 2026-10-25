"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Module } = require("node:module"), { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, ".."), restore = require("../lib/persistence/postgresql/operations/restore-authentication");
function fixture(fail = "") {
  const events = [], state = { changed: 0 };
  const client = { async query(sql, values) {
    events.push(sql);
    if (sql === fail) throw Error("SYNTHETIC_RESTORE_FAILURE");
    if (sql === "ROLLBACK") state.changed = 0;
    if (sql.startsWith("UPDATE ")) { assert.deepEqual(values, ["2026-10-25T12:00:00.000Z"]); state.changed++; }
    return { rowCount: sql.startsWith("UPDATE ") ? 2 : 0 };
  } };
  const file = path.join(ROOT, "lib/persistence/postgresql/operations/restore-authentication.js"), instance = new Module(file, module);
  instance.filename = file; instance.paths = Module._nodeModulePaths(path.dirname(file)); const original = instance.require.bind(instance);
  instance.require = name => name === "../core/environment" ? { verifyEnvironment: async (value, options) => {
    assert.equal(value, client); assert.equal(options.purpose, "migrator"); events.push("environment");
    if (fail === "environment") throw Error("SYNTHETIC_ENVIRONMENT_FAILURE");
  } } : name === "../boundary/migrate" ? { verifyCoreSchema: async (value, options) => {
    assert.equal(value, client); assert.deepEqual(options, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
    events.push("schema"); if (fail === "schema") throw Error("SYNTHETIC_SCHEMA_FAILURE");
  } } : original(name);
  instance._compile(fs.readFileSync(file, "utf8"), file);
  return { subject: instance.exports, client, events, state, run: () => instance.exports.invalidateRestoredAuthentication(client,
    { scope: restore.SCOPE, now: "2026-10-25T12:00:00.000Z" }) };
}
test("explicit restore invalidation covers every copied authenticator in one verified transaction and never changes a password", async () => {
  const f = fixture(), result = await f.run(); assert.equal(result.passwordsChanged, false);
  assert.equal(result.scope, restore.SCOPE); assert.equal(f.events.at(-1), "COMMIT"); assert.equal(f.state.changed, 7);
  assert.deepEqual(Object.keys(result.revoked), restore.statements.map(([name]) => name));
  assert.equal(f.events[0], "environment"); assert.match(f.events[1], /^BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert(f.events.indexOf("schema") < f.events.findIndex(sql => sql.startsWith("UPDATE ")));
  assert(restore.statements.every(([, sql]) => !/password_hash\s*=/i.test(sql)));
});
test("unbound restore calls and invalid timestamps are rejected before any database access", async () => {
  for (const options of [{}, { scope: "migration" }, { scope: restore.SCOPE, now: "bad" }, { scope: restore.SCOPE, now: "2026-02-30T12:00:00.000Z" }]) {
    const f = fixture(); await assert.rejects(f.subject.invalidateRestoredAuthentication(f.client, options), /PG_RESTORE_AUTHENTICATION_SCOPE/);
    assert.deepEqual(f.events, []);
  }
});
test("failed authority, schema or any invalidation statement cannot publish a partial restoration", async () => {
  for (const fault of ["environment", "schema", ...restore.statements.map(([, sql]) => sql), "COMMIT"]) {
    const f = fixture(fault); await assert.rejects(f.run()); assert.equal(f.state.changed, 0);
    if (fault !== "environment") assert.equal(f.events.at(-1), "ROLLBACK");
  }
});
test("release/export inventory includes passkey implementation and its separate operations ledger", () => {
  const required = ["lib/passkey-protocol.js", "lib/passkey-management.js", "lib/passkey-authentication.js",
    "lib/persistence/statements/passkeys.js", "lib/persistence/repositories/passkeys.js", "lib/persistence/postgresql/core/passkeys.js",
    "lib/persistence/postgresql/core/passkeys-catalog.js", "lib/persistence/postgresql/contracts/passkeys-catalog-v1.json",
    "lib/persistence/postgresql/operations/restore-authentication.js", "server-tools/linux/lib/session-security-migrate.js",
    "public/passkeys.html", "public/passkeys.js", "public/passkeys.css", "public/passkey-auth.js", "public/passkey-auth.css"];
  const verifier = fs.readFileSync(path.join(ROOT, "server-tools/linux/lib/verify-package.js"), "utf8");
  const builder = fs.readFileSync(path.join(ROOT, "server-tools/package/New-GrabenplanerLinuxServerPackage.ps1"), "utf8");
  for (const file of required) { assert(verifier.includes("'" + file + "'"), file); assert(builder.includes("'" + file.replaceAll("/", "\\") + "'"), file); }
  const { OPERATIONS_ONLY_TABLES } = require("../lib/persistence/postgresql/operations/application-export");
  assert(OPERATIONS_ONLY_TABLES.core.includes("gp.passkeys_migration_history"));
  assert(!OPERATIONS_ONLY_TABLES.core.includes("gp.passkey_subjects")); assert(!OPERATIONS_ONLY_TABLES.core.includes("gp.passkey_credentials"));
});
test("old-fixture bootstrap is explicit and cannot be combined with any normal CI/test run", () => {
  const file = path.join(ROOT, "test-support/postgresql-migration/ci-stock-import-delete.js");
  for (const [args, expected] of [[[], /Old passkeys fixture preparation requires unsharded bootstrap-only/],
    [["--full"], /Old passkeys fixture preparation requires unsharded bootstrap-only/],
    [["--diagnostic-api", "sales"], /Old passkeys fixture preparation requires unsharded bootstrap-only/],
    [["--full", "--application-shard", "1\/3"], /Old passkeys fixture preparation requires unsharded bootstrap-only/],
    [["--passkeys-browser"], /Passkeys browser qualification requires explicit full shard 1\/3/]]) {
    const result = spawnSync(process.execPath, [file, "--bootstrap-before-passkeys", ...args], { cwd: ROOT, encoding: "utf8", timeout: 10000,
      env: { ...process.env, TEST_POSTGRESQL_URL: "" } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
  }
  // No endpoint is supplied: reaching URL validation proves this exact fixture
  // combination was accepted without risking a database connection locally.
  const accepted = spawnSync(process.execPath, [file, "--bootstrap-before-passkeys", "--bootstrap-only"], { cwd: ROOT, encoding: "utf8", timeout: 10000,
    env: { ...process.env, TEST_POSTGRESQL_URL: "" } });
  assert.notEqual(accepted.status, 0); assert.match(accepted.stderr, /ERR_INVALID_URL/);
  assert.doesNotMatch(accepted.stderr, /unsharded bootstrap-only/);
});
