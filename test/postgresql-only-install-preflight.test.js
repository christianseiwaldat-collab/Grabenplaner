"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), test = require("node:test");
const { spawnSync } = require("node:child_process");
const { validatePreparedDocuments, verifyPreparedPair } = require("../server-tools/linux/postgresql/preflight-install");
function documents() {
  const binding = { format: "grabenplaner-postgresql-runtime-binding-v1", profile: "grabenplaner-postgresql-v1",
    clusterId: "7654321234567890123", environmentId: "grabenplaner-pair-12345678-1234-4234-8234-123456789012" };
  const document = { format: "grabenplaner-postgresql-application-v1", productActivation: true, host: "127.0.0.1", port: 55486,
    sourceSha256: "a".repeat(64), applicationSha256: "b".repeat(64), activatedAt: "2026-10-23T00:00:00Z", binding,
    accounts: { gp_core_app: "c".repeat(64), gp_core_reader: "d".repeat(64), gp_sales_app: "e".repeat(64), gp_sales_reader: "f".repeat(64) } };
  const anchor = { format: "grabenplaner-postgresql-pair-v1", ...binding, sourceSha256: document.sourceSha256, applicationSha256: document.applicationSha256 };
  anchor.format = "grabenplaner-postgresql-pair-v1";
  const operations = { format: "grabenplaner-postgresql-operations-v1", mode: "productive", host: document.host, port: document.port, binding,
    clusterId: binding.clusterId, sourceFiles: "/var/lib/grabenplaner", environmentFile: "/etc/grabenplaner/grabenplaner.env", workDirectory: "/var/lib/grabenplaner-postgresql/operations",
    administrator: { role: "gp_migration_admin", password: "x".repeat(64) }, monitor: { role: "gp_operations_monitor", password: "y".repeat(64) },
    recoveryAccounts: { ...document.accounts, gp_core_migrator: "z".repeat(64), gp_sales_migrator: "t".repeat(64), gp_migration_admin: "x".repeat(64), gp_operations_monitor: "y".repeat(64) },
    activationReceipt: { productActivation: true, sourceSha256: document.sourceSha256, applicationSha256: document.applicationSha256 },
    domains: ["core", "sales"].map(domain => ({ domain, database: "grabenplaner_" + domain, role: `gp_${domain}_migrator`, password: (domain === "core" ? "z" : "t").repeat(64), environmentId: binding.environmentId, profile: binding.profile })) };
  const environment = { NODE_ENV: "production", GRABENPLANER_OPERATION_MODE: "server", GRABENPLANER_DEPLOYMENT_KIND: "production", DB_PROVIDER: "postgresql",
    GRABENPLANER_DATA_DIR: "/var/lib/grabenplaner", DB_PATH: "/var/lib/grabenplaner/data/postgresql-pair.json",
    BACKUP_DIR: "/var/backups/grabenplaner-postgresql",
    GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG: "/etc/grabenplaner/postgresql-application.json", GRABENPLANER_BOOTSTRAP_TOKEN: "g".repeat(48) };
  return { document, anchor, operations, environment };
}
function clientFixture(binding, { admin = "1", wrongDomain = false, privileged = false, wrongCluster = false } = {}) {
  const queries = [], connections = [], ended = [];
  class Client {
    constructor(configuration) { this.configuration = configuration; connections.push(configuration); this.url = configuration.connectionString ? new URL(configuration.connectionString) : new URL(`postgresql://${configuration.user}@${configuration.host}:${configuration.port}/${configuration.database}`); }
    async connect() {}
    async end() { ended.push(this.url.username); }
    async query(sql) {
      queries.push(sql);
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: admin }] };
      if (/pg_control_system/.test(sql)) return { rows: [{ database: "grabenplaner_core", username: "gp_operations_monitor", cluster_id: wrongCluster ? "other" : binding.clusterId, monitor_role: true, elevated: false }] };
      if (/pg_roles/.test(sql)) return { rows: [{ database: this.url.pathname.slice(1), username: this.url.username,
        rolsuper: privileged, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
        environment_id: binding.environmentId, profile: binding.profile, domain: wrongDomain ? "other" : this.url.pathname.slice(1).split("_")[1] }] };
      return { rows: [] };
    }
  }
  return { Client, queries, connections, ended };
}
test("PostgreSQL-only install accepts paired documents and rejects SQLite/rehearsal/mismatched evidence", () => {
  const good = documents();
  assert.equal(validatePreparedDocuments(good).resolved.providerId, "postgresql");
  for (const edit of [value => { value.environment.DB_PROVIDER = "sqlite"; }, value => { value.environment.DATABASE_URL = "postgresql://unexpected"; },
    value => { value.environment.GRABENPLANER_POSTGRESQL_REHEARSAL = "activation-12"; }, value => { value.anchor.sourceSha256 = "c".repeat(64); },
    value => { value.operations.activationReceipt.sourceSha256 = "c".repeat(64); }, value => { value.operations.domains[1].environmentId = "other"; }]) {
    const bad = documents(); edit(bad); assert.throws(() => validatePreparedDocuments(bad));
  }
});
test("install preflight checks all four bounded app/reader accounts using read-only transactions", async () => {
  const prepared = validatePreparedDocuments(documents()), fixture = clientFixture(prepared.resolved.binding);
  const result = await verifyPreparedPair(prepared, fixture.Client);
  assert.deepEqual(result, { ok: true, providerId: "postgresql", domains: 2, accountsVerified: 4, monitorAccountVerified: true, clusterVerified: true, readOnly: true, adminConfigured: true });
  assert.equal(fixture.ended.length, 5);
  assert.equal(fixture.queries.filter(sql => sql === "BEGIN READ ONLY").length, 5);
  assert.equal(fixture.queries.filter(sql => sql === "COMMIT").length, 5);
  assert.ok(fixture.connections.every(c => c.connectionTimeoutMillis === 5000 && /default_transaction_read_only=on/.test(c.options)));
  assert.ok(fixture.queries.every(sql => /^(?:BEGIN READ ONLY|SELECT|COMMIT)/.test(sql)));
});
test("install preflight refuses changed environment or overprivileged accounts and always closes connections", async () => {
  const prepared = validatePreparedDocuments(documents());
  for (const settings of [{ wrongDomain: true }, { privileged: true }]) {
    const fixture = clientFixture(prepared.resolved.binding, settings);
    await assert.rejects(verifyPreparedPair(prepared, fixture.Client), { code: "PG_INSTALL_DATABASE_BINDING" });
    assert.equal(fixture.ended.length, 2); assert.equal(fixture.queries.filter(sql => sql === "COMMIT").length, 1);
  }
  const changed = clientFixture(prepared.resolved.binding, { wrongCluster: true });
  await assert.rejects(verifyPreparedPair(prepared, changed.Client), { code: "PG_INSTALL_CLUSTER_BINDING" });
  assert.equal(changed.ended.length, 1); assert.equal(changed.queries.includes("COMMIT"), false);
});
test("an empty prepared pair needs an unconsumed bootstrap token, existing admins do not", async () => {
  const input = documents(); delete input.environment.GRABENPLANER_BOOTSTRAP_TOKEN;
  const prepared = validatePreparedDocuments(input), fixture = clientFixture(prepared.resolved.binding, { admin: "0" });
  await assert.rejects(verifyPreparedPair(prepared, fixture.Client), { code: "PG_INSTALL_BOOTSTRAP_TOKEN_REQUIRED" });
  assert.equal(fixture.ended.length, 5);
  assert.equal((await verifyPreparedPair(prepared, clientFixture(prepared.resolved.binding).Client)).adminConfigured, true);
});
test("Linux install templates have valid shell syntax and pair gates precede persistent installation and swap", { skip: process.platform !== "linux" }, () => {
  const root = path.resolve(__dirname, ".."), installer = path.join(root, "server-tools/linux/install-grabenplaner-server.sh");
  for (const file of [installer, path.join(root, "server-tools/linux/grabenplaner-bootstrap-admin.sh.in")]) {
    const result = spawnSync("bash", ["-n", file], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  const source = fs.readFileSync(installer, "utf8"), structure = source.indexOf('"$STAGE_ROOT/source/server-tools/linux/postgresql/preflight-install.js" documents'), create = source.indexOf('getent group "$SERVICE_GROUP"', structure),
    live = source.indexOf('"$STAGE_ROOT/source/server-tools/linux/postgresql/preflight-install.js" check'), swap = source.indexOf('mv -- "$STAGE_ROOT/source" "$APP_ROOT"');
  assert.ok(structure > 0 && create > structure && live > create && swap > live);
  assert.doesNotMatch(source, /node:sqlite|new DatabaseSync/);
  // Execute the real EXIT cleanup body with command spies. A failed preflight
  // does not own an application or pre-existing maintenance links.
  const cleanup = source.slice(source.indexOf("cleanup() {"), source.indexOf("trap cleanup EXIT"));
  const flags = ["APP_SWAPPED", "APP_UNIT_WRITTEN", "BOOTSTRAP_UNIT_WRITTEN", "MONITOR_UNIT_WRITTEN", "MONITOR_TIMER_WRITTEN", "HOST_CONTROL_SOCKET_WRITTEN",
    "HOST_CONTROL_WORKER_WRITTEN", "HOST_REBOOT_UNIT_WRITTEN", "BOOTSTRAP_COMMAND_WRITTEN", "HOST_CONTROL_MODULE_WRITTEN", "HOST_CONTROL_ROOT_CREATED", "HOST_CONTROL_MEMBERSHIP_ADDED", "HOST_CONTROL_GROUP_CREATED"];
  const probe = flags.map(name => name + "=0").join("\n") + '\nAPP_ROOT=/opt/grabenplaner/app\nUNIT_TEMP=\nHOST_CONTROL_PENDING_UNIT=\nSTAGE_ROOT=\n'
    + 'rollback_caddy_configuration(){ :; }\nrm(){ echo UNEXPECTED_MUTATION; }\nreadlink(){ echo /opt/grabenplaner/app/old-tool; }\nsystemctl(){ echo UNEXPECTED_MUTATION; }\n'
    + cleanup + "\ntrap cleanup EXIT\nfalse\n";
  const negative = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
  assert.equal(negative.status, 1); assert.equal(negative.stdout, ""); assert.equal(negative.stderr, "");
});
