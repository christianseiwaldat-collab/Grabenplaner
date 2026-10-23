"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), { randomBytes } = require("node:crypto");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const sqliteMigration = require("../lib/persistence/sqlite/operations/session-security-schema");
const postgresMigration = require("../lib/persistence/postgresql/core/session-security");
const BASE = [
  "CREATE TABLE portal_users(employee_number TEXT PRIMARY KEY,password_hash TEXT NOT NULL)",
  "CREATE TABLE portal_organization_accounts(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL)",
  "CREATE TABLE portal_sessions(id TEXT PRIMARY KEY,revoked_at TEXT)",
  "CREATE TABLE portal_organization_sessions(id TEXT PRIMARY KEY,revoked_at TEXT)",
  "CREATE TABLE mobile_sessions(id TEXT PRIMARY KEY,revoked_at TEXT,revoked_reason TEXT,updated_at TEXT)",
  "CREATE TABLE portal_password_reset_tokens(id TEXT PRIMARY KEY,revoked_at TEXT,used_at TEXT)",
  "CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,app_version TEXT NOT NULL)",
  "INSERT INTO portal_users VALUES('synthetic-person','unchanged-synthetic-legacy-hash')",
  "INSERT INTO portal_sessions VALUES('synthetic-session',NULL)",
];

function stoppedInTransaction() {
  fs.writeFileSync(process.env.GP_P2_CRASH_READY, "uncommitted-ddl-and-revocation");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (process.env.GP_P2_CRASH_CHILD) {
  (async () => {
    if (process.env.GP_P2_CRASH_CHILD === "sqlite") {
      const database = openSqliteLegacyDatabase(process.env.GP_P2_CRASH_DB);
      const wrapper = {
        prepare: sql => database.prepare(sql),
        exec(sql) {
          database.exec(sql);
          if (sql === sqliteMigration.REVOKE_SQL[0]) stoppedInTransaction();
        },
      };
      sqliteMigration.ensureSqliteSessionSecuritySchema(wrapper);
    } else {
      const { Client } = require("pg"), schema = process.env.GP_P2_CRASH_SCHEMA;
      assert.match(schema, /^session_crash_[a-f0-9]{16}$/);
      const client = new Client({ connectionString: process.env.GP_CORE_MIGRATOR_URL });
      await client.connect();
      await client.query("BEGIN; SET LOCAL ROLE gp_core_owner");
      for (const sql of postgresMigration.statements.slice(0, 7)) {
        await client.query(sql.replace(/\bgp\./g, schema + "."));
      }
      stoppedInTransaction();
    }
    throw Error("Crash barrier was not reached");
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  async function terminateAfterUncommittedWrite(t, variables) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-p2-crash-marker-"));
    const ready = path.join(directory, "ready");
    const environment = { ...process.env, ...variables, GP_P2_CRASH_READY: ready };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [__filename], {
      env: environment, cwd: path.resolve(__dirname, ".."), windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { output += value; });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(ready), output || "Uncommitted migration barrier did not become ready");
    assert.equal(fs.readFileSync(ready, "utf8"), "uncommitted-ddl-and-revocation");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
  }

  test("SQLite: killed migration recovers its journal; verified pre-upgrade backup retains old schema and hashes", { timeout: 45000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-p2-sqlite-crash-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "source.sqlite"), backup = path.join(directory, "pre-upgrade.sqlite");
    let database = openSqliteLegacyDatabase(filename);
    BASE.forEach(sql => database.exec(sql));
    database.close();
    fs.copyFileSync(filename, backup);
    const verifiedBackup = fs.readFileSync(backup);
    await terminateAfterUncommittedWrite(t, { GP_P2_CRASH_CHILD: "sqlite", GP_P2_CRASH_DB: filename });
    database = openSqliteLegacyDatabase(filename);
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("PRAGMA table_info(portal_sessions)").all().some(c => c.name === "authenticated_at"), false);
      assert.equal(database.prepare("SELECT revoked_at FROM portal_sessions").get().revoked_at, null);
      assert.equal(database.prepare("SELECT count(*) n FROM schema_migrations").get().n, 0);
      assert.equal(sqliteMigration.ensureSqliteSessionSecuritySchema(database).applied, true);
      assert.ok(database.prepare("SELECT revoked_at FROM portal_sessions").get().revoked_at);
      assert.equal(database.prepare("SELECT password_hash FROM portal_users").get().password_hash, "unchanged-synthetic-legacy-hash");
    } finally { database.close(); }
    // A rollback restores the verified old database; it does not drop new columns in place.
    assert.deepEqual(fs.readFileSync(backup), verifiedBackup);
    const restored = path.join(directory, "restored.sqlite");
    fs.copyFileSync(backup, restored);
    database = openSqliteLegacyDatabase(restored);
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("PRAGMA table_info(portal_sessions)").all().some(c => c.name === "authenticated_at"), false);
      assert.equal(database.prepare("SELECT revoked_at FROM portal_sessions").get().revoked_at, null);
      assert.equal(database.prepare("SELECT password_hash FROM portal_users").get().password_hash, "unchanged-synthetic-legacy-hash");
      assert.equal(sqliteMigration.ensureSqliteSessionSecuritySchema(database).applied, true);
    } finally { database.close(); }
  });

  test("PostgreSQL: killed migration connection rolls back DDL and revocations; retry is consistent", {
    skip: !process.env.GP_CORE_MIGRATOR_URL, timeout: 45000,
  }, async t => {
    const { Client } = require("pg"), url = new URL(process.env.GP_CORE_MIGRATOR_URL);
    assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/gp_migration_core");
    const client = new Client({ connectionString: url.href });
    const schema = "session_crash_" + randomBytes(8).toString("hex");
    let owned = false;
    try {
      await client.connect();
      await require("../lib/persistence/postgresql/core/environment").verifyEnvironment(client, { purpose: "migrator" });
      await client.query("SET ROLE gp_core_owner; CREATE SCHEMA " + schema); owned = true;
      await client.query("SET search_path=" + schema + ",pg_catalog");
      for (const sql of BASE) await client.query(sql);
      await terminateAfterUncommittedWrite(t, { GP_P2_CRASH_CHILD: "postgresql", GP_P2_CRASH_SCHEMA: schema });
      assert.equal((await client.query("SELECT revoked_at FROM portal_sessions")).rows[0].revoked_at, null);
      assert.equal((await client.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema=$1 AND column_name='authenticated_at'", [schema])).rows[0].n, "0");
      assert.equal((await client.query("SELECT count(*) n FROM schema_migrations")).rows[0].n, "0");
      await client.query("BEGIN");
      for (const sql of postgresMigration.statements) await client.query(sql.replace(/\bgp\./g, schema + "."));
      await client.query("COMMIT");
      assert.ok((await client.query("SELECT revoked_at FROM portal_sessions")).rows[0].revoked_at);
      assert.equal((await client.query("SELECT password_hash,password_policy_version FROM portal_users")).rows[0].password_hash, "unchanged-synthetic-legacy-hash");
      assert.equal((await client.query("SELECT password_policy_version FROM portal_users")).rows[0].password_policy_version, 0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      if (owned) {
        const owner = (await client.query("SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1", [schema])).rows;
        assert.deepEqual(owner, [{ owner: "gp_core_owner" }]);
        await client.query("DROP SCHEMA " + schema + " CASCADE");
      }
      await client.end();
    }
  });
}
