"use strict";

const { createHash } = require("node:crypto");
const { schemaFingerprint } = require("./fingerprint");

const HISTORY_TABLE = "session_security_migration_history";
const { COLUMNS, REVOKE_SQL, MIGRATION_ID } = require("../../sqlite/operations/session-security-schema");
const LOCK_KEY = 9261274;
const rollbackBoundary = Object.freeze({
  automaticRollback: false,
  afterCommit: "verified-pre-migration-pair-restore-only-before-new-writes-or-forward-fix",
  afterNewWrites: "forward-fix-or-explicit-recovery-with-preservation-of-new-data",
  destructiveColumnDrop: false,
});
const statements = Object.freeze([
  ...COLUMNS.map(column => "ALTER TABLE gp." + column.table + " ADD COLUMN " + column.name + " " + column.definition.replace(/^TEXT/, 'TEXT COLLATE "C"')),
  ...REVOKE_SQL.map(sql => sql.replace(/^UPDATE /, "UPDATE gp.")),
  "INSERT INTO gp.schema_migrations(id,app_version) VALUES('" + MIGRATION_ID + "','0.92.90-beta') ON CONFLICT(id) DO NOTHING",
  "CREATE TABLE gp.session_security_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)",
  "REVOKE ALL ON gp.session_security_migration_history FROM PUBLIC,gp_core_app,gp_core_reader",
  "GRANT SELECT ON gp.session_security_migration_history TO gp_core_app,gp_core_reader",
]);
const digest = createHash("sha256").update(JSON.stringify(statements)).digest("hex");
const fingerprintPattern = /^[a-f0-9]{64}$/;

async function readLedger(client) {
  if (!(await client.query("SELECT to_regclass('gp.session_security_migration_history') name")).rows[0].name) return null;
  const rows = (await client.query("SELECT version,plan_sha256,base_target_sha256,target_sha256 FROM gp.session_security_migration_history")).rows;
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].plan_sha256 !== digest
    || !fingerprintPattern.test(rows[0].base_target_sha256 || "")
    || !fingerprintPattern.test(rows[0].target_sha256 || "")) {
    throw new Error("PG_SESSION_SECURITY_MIGRATION_CONTRACT");
  }
  return rows[0];
}

async function target(client, base, { required = false } = {}) {
  const ledger = await readLedger(client);
  if (!ledger) {
    if (required) throw new Error("PG_SESSION_SECURITY_MIGRATION_REQUIRED");
    return base;
  }
  if (ledger.base_target_sha256 !== base) throw new Error("PG_SESSION_SECURITY_MIGRATION_CONTRACT");
  return ledger.target_sha256;
}

async function migrate(client, { binding } = {}) {
  await require("./environment").verifyEnvironment(client, { purpose: "migrator", binding });
  await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp");
    transactionStarted = true;
    // The baseline and every preceding extension must match before any DDL.
    // The new extension is optional here, so the same check also permits repeat.
    await require("../boundary/migrate").verifyCoreSchema(client, { requireVocationalSchool: true });
    if (await readLedger(client)) {
      await client.query("COMMIT"); transactionStarted = false;
      return { applied: false, digest, rollbackBoundary };
    }
    const base = await schemaFingerprint(client);
    // No IF NOT EXISTS: unrecorded columns are drift. All existing credentials
    // are revoked once; legacy hashes and their unverified policy state remain.
    for (const sql of statements) await client.query(sql);
    const after = await schemaFingerprint(client);
    await client.query("INSERT INTO gp.session_security_migration_history VALUES(1,$1,$2,$3)", [digest, base, after]);
    await client.query("COMMIT"); transactionStarted = false;
    return { applied: true, digest, target: after, rollbackBoundary };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
  }
}

module.exports = { HISTORY_TABLE, COLUMNS, LOCK_KEY, statements, digest, rollbackBoundary, readLedger, target, migrate };
