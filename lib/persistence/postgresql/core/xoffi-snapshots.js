"use strict";
const crypto = require("node:crypto");
const { compileCoreEntry } = require("./catalog");
const { schemaFingerprint } = require("./fingerprint");
const { trigger } = require("./schema");
const { TRIGGERS } = require("../../sqlite/operations/xoffi-snapshots-schema");
const qualify = (sql) => sql.replace(/(?<![."a-z_])xoffi_time_snapshots\b/g, "gp.xoffi_time_snapshots");
const CATALOG = require("../../sqlite/xoffi-snapshots-catalog").CATALOG.map((entry) => {
  const compiled = compileCoreEntry(entry).providerEntry;
  return { ...compiled, sql: qualify(compiled.sql) };
});
const statements = [
  // Preserve the source schema's deferred self-reference: supersede the old
  // active import, then insert its successor in the same atomic transaction.
  "ALTER TABLE gp.xoffi_time_imports ALTER CONSTRAINT fk_xoffi_time_imports_0 DEFERRABLE INITIALLY DEFERRED",
  `CREATE TABLE gp.xoffi_time_snapshots(employee_row_id BIGINT PRIMARY KEY REFERENCES gp.xoffi_time_employee_rows(id)
    ON UPDATE CASCADE ON DELETE RESTRICT, snapshot_json TEXT COLLATE "C" NOT NULL CHECK(jsonb_typeof(snapshot_json::jsonb)='object'))`,
  "REVOKE ALL ON gp.xoffi_time_snapshots FROM PUBLIC,gp_core_app,gp_core_reader",
  "GRANT SELECT,INSERT ON gp.xoffi_time_snapshots TO gp_core_app",
  "GRANT SELECT ON gp.xoffi_time_snapshots TO gp_core_reader",
];
for (const item of TRIGGERS) {
  const compiled = trigger({ name: item.name, sql: item.sql.replace("IF NOT EXISTS ", ""), table_name: "xoffi_time_snapshots" });
  for (const entry of compiled) {
    statements.push(qualify(entry.sql));
    const fn = /^CREATE FUNCTION (gp\."[^"]+")\(\)/.exec(entry.sql);
    if (fn) statements.push(`REVOKE ALL ON FUNCTION ${fn[1]}() FROM PUBLIC`, `GRANT EXECUTE ON FUNCTION ${fn[1]}() TO gp_core_app`);
  }
}
statements.push(
  "CREATE TABLE gp.xoffi_snapshots_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)",
  "REVOKE ALL ON gp.xoffi_snapshots_migration_history FROM PUBLIC,gp_core_app,gp_core_reader",
  "GRANT SELECT ON gp.xoffi_snapshots_migration_history TO gp_core_app,gp_core_reader",
);
const digest = crypto.createHash("sha256").update(JSON.stringify(statements)).digest("hex");
async function target(client, base) {
  if (!(await client.query("SELECT to_regclass('gp.xoffi_snapshots_migration_history') name")).rows[0].name) return base;
  const rows = (await client.query("SELECT * FROM gp.xoffi_snapshots_migration_history")).rows;
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].plan_sha256 !== digest || rows[0].base_target_sha256 !== base) throw new Error("Xoffi snapshots migration contract mismatch");
  return rows[0].target_sha256;
}
async function migrate(client, { binding } = {}) {
  await require("./environment").verifyEnvironment(client, { purpose: "migrator", binding });
  await client.query("SELECT pg_advisory_lock(9261257)");
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp");
    await require("../boundary/migrate").verifyCoreSchema(client);
    if ((await client.query("SELECT to_regclass('gp.xoffi_snapshots_migration_history') name")).rows[0].name) {
      await client.query("COMMIT"); return { applied: false, digest };
    }
    const base = await schemaFingerprint(client);
    for (const sql of statements) await client.query(sql);
    const after = await schemaFingerprint(client);
    await client.query("INSERT INTO gp.xoffi_snapshots_migration_history VALUES(1,$1,$2,$3)", [digest, base, after]);
    await client.query("COMMIT"); return { applied: true, digest, target: after };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.query("SELECT pg_advisory_unlock(9261257)"); }
}
module.exports = { CATALOG, statements, digest, target, migrate };
