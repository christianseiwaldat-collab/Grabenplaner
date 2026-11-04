"use strict";
// Read-only install/first-admin gate. This tool never provisions or migrates a DB.
const fs = require("node:fs");
const { parseEnv } = require("node:util");
const application = require("../../../lib/persistence/postgresql/productive-configuration");
const { verifyEnvironment } = require("../../../lib/persistence/postgresql/core/environment");
const ENVIRONMENT = "/etc/grabenplaner/grabenplaner.env";
const OPERATIONS = "/etc/grabenplaner/postgresql-operations.json";
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validatePreparedDocuments({ environment, document, anchor, operations }) {
  const resolved = application.resolveDocument(document, anchor);
  if (environment.NODE_ENV !== "production" || environment.GRABENPLANER_OPERATION_MODE !== "server"
    || environment.GRABENPLANER_DEPLOYMENT_KIND !== "production" || environment.DB_PROVIDER !== "postgresql"
    || environment.GRABENPLANER_DATA_DIR !== "/var/lib/grabenplaner" || environment.DB_PATH !== application.ANCHOR
    || environment.BACKUP_DIR !== "/var/backups/grabenplaner-postgresql"
    || environment.GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG !== application.FILE
    || environment.DATABASE_URL || environment.GRABENPLANER_POSTGRESQL_REHEARSAL || environment.GRABENPLANER_RESTORE_ROOT) fail("PG_INSTALL_ENVIRONMENT");
  if (operations?.format !== "grabenplaner-postgresql-operations-v1" || operations.mode !== "productive"
    || operations.host !== document.host || operations.port !== document.port
    || ["format", "profile", "environmentId", "clusterId"].some(key => operations.binding?.[key] !== document.binding[key])
    || operations.activationReceipt?.productActivation !== true
    || operations.activationReceipt.sourceSha256 !== document.sourceSha256
    || operations.activationReceipt.applicationSha256 !== document.applicationSha256
    || operations.clusterId !== document.binding.clusterId
    || operations.sourceFiles !== "/var/lib/grabenplaner" || operations.environmentFile !== ENVIRONMENT
    || operations.workDirectory !== "/var/lib/grabenplaner-postgresql/operations"
    || operations.administrator?.role !== "gp_migration_admin" || operations.monitor?.role !== "gp_operations_monitor"
    || Object.keys(operations.recoveryAccounts || {}).sort().join(",") !== ["gp_migration_admin", "gp_operations_monitor", ...["core", "sales"].flatMap(domain => ["app", "reader", "migrator"].map(purpose => `gp_${domain}_${purpose}`))].sort().join(",")
    || Object.values(operations.recoveryAccounts || {}).some(secret => typeof secret !== "string" || secret.length < 24)
    || operations.recoveryAccounts?.gp_migration_admin !== operations.administrator.password
    || operations.recoveryAccounts?.gp_operations_monitor !== operations.monitor.password
    || Object.keys(document.accounts).some(name => operations.recoveryAccounts?.[name] !== document.accounts[name])
    || operations.domains?.map(domain => domain.domain).join(",") !== "core,sales"
    || operations.domains.some(domain => domain.database !== "grabenplaner_" + domain.domain
      || domain.role !== `gp_${domain.domain}_migrator` || operations.recoveryAccounts?.[domain.role] !== domain.password
      || domain.environmentId !== document.binding.environmentId || domain.profile !== document.binding.profile)) fail("PG_INSTALL_OPERATIONS_BINDING");
  return { resolved, environment, operations };
}
function readPreparedDocuments() {
  if (process.platform !== "linux" || process.getuid() !== 0) fail("PG_INSTALL_ROOT_REQUIRED");
  const info = fs.lstatSync(ENVIRONMENT);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o777) !== 0o600 || fs.realpathSync(ENVIRONMENT) !== ENVIRONMENT) fail("PG_INSTALL_ENVIRONMENT_PERMISSIONS");
  const source = fs.readFileSync(ENVIRONMENT, "utf8"), seen = new Set();
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || seen.has(match[1])) fail("PG_INSTALL_ENVIRONMENT_DUPLICATE");
    seen.add(match[1]);
  }
  const serviceGroups = fs.readFileSync("/etc/group", "utf8").split("\n").map(line => line.split(":"))
    .filter(fields => fields[0] === "grabenplaner" && /^[1-9][0-9]*$/.test(fields[2] || ""));
  if (serviceGroups.length !== 1) fail("PG_INSTALL_SERVICE_GROUP_REQUIRED");
  const gid = Number(serviceGroups[0][2]);
  const configDirectory = fs.lstatSync("/etc/grabenplaner");
  if (!configDirectory.isDirectory() || configDirectory.isSymbolicLink() || configDirectory.uid !== 0
    || configDirectory.gid !== gid || (configDirectory.mode & 0o777) !== 0o750
    || fs.realpathSync("/etc/grabenplaner") !== "/etc/grabenplaner") fail("PG_INSTALL_CONFIGURATION_DIRECTORY_READABILITY");
  for (const file of [application.FILE, application.ANCHOR]) {
    const stat = fs.lstatSync(file);
    if ((stat.mode & 0o777) !== 0o640 || stat.gid !== gid) fail("PG_INSTALL_APPLICATION_CONFIG_READABILITY");
  }
  const operationsInfo = fs.lstatSync(OPERATIONS);
  if ((operationsInfo.mode & 0o777) !== 0o600 || operationsInfo.gid !== 0) fail("PG_INSTALL_OPERATIONS_PERMISSIONS");
  const document = application.readProtectedJson(application.FILE, { gid }), anchor = application.readProtectedJson(application.ANCHOR, { gid }),
    operations = application.readProtectedJson(OPERATIONS);
  for (const directory of [operations.backupDirectory, operations.workDirectory]) {
    require("../../../lib/persistence/postgresql/operations/paired-bundle").safeRoot(directory);
    if (fs.statSync(directory).uid !== 0) fail("PG_INSTALL_OPERATIONS_DIRECTORY_OWNER");
  }
  return validatePreparedDocuments({ environment: parseEnv(source), document, anchor, operations });
}
async function verifyPreparedPair({ resolved, environment, operations }, Client) {
  let adminConfigured = false;
  if (operations) {
    const monitor = new Client({ host: operations.host, port: operations.port, database: "grabenplaner_core",
      user: operations.monitor.role, password: operations.monitor.password, connectionTimeoutMillis: 5000,
      application_name: "gp-postgresql-only-install-monitor", options: "-c default_transaction_read_only=on -c statement_timeout=10000" });
    try {
      await monitor.connect(); await monitor.query("BEGIN READ ONLY");
      const identity = (await monitor.query("SELECT current_database() AS database, current_user AS username, (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id, pg_has_role(current_user,'pg_monitor','MEMBER') AS monitor_role, (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows;
      if (identity.length !== 1 || identity[0].database !== "grabenplaner_core" || identity[0].username !== "gp_operations_monitor"
        || identity[0].cluster_id !== resolved.binding.clusterId || identity[0].monitor_role !== true || identity[0].elevated !== false) fail("PG_INSTALL_CLUSTER_BINDING");
      await monitor.query("COMMIT");
    } finally { await monitor.end(); }
  }
  for (const domain of ["core", "sales"]) {
    for (const purpose of ["app", "reader"]) {
      const configuration = purpose === "reader" ? resolved.readers : resolved;
      const client = new Client({ connectionString: configuration[domain + "Url"], connectionTimeoutMillis: 5000,
        application_name: "gp-postgresql-only-install-preflight", options: "-c default_transaction_read_only=on -c statement_timeout=10000" });
      try {
        await client.connect(); await client.query("BEGIN READ ONLY");
        try { await verifyEnvironment(client, { domain, purpose, binding: resolved.binding }); }
        catch { fail("PG_INSTALL_DATABASE_BINDING"); }
        if (domain === "core" && purpose === "reader") {
          const row = (await client.query("SELECT COUNT(*)::text AS count FROM gp.portal_users WHERE active = 1 AND role IN ('developer','it_admin','admin')")).rows[0];
          if (!/^\d+$/.test(row?.count || "")) fail("PG_INSTALL_ADMIN_QUERY");
          adminConfigured = Number(row.count) > 0;
        }
        await client.query("COMMIT");
      } finally { await client.end(); }
    }
  }
  if (environment && !adminConfigured && !/^[A-Za-z0-9+/_=-]{32,256}$/.test(environment.GRABENPLANER_BOOTSTRAP_TOKEN || "")) fail("PG_INSTALL_BOOTSTRAP_TOKEN_REQUIRED");
  return { ok: true, providerId: "postgresql", domains: 2, accountsVerified: 4, monitorAccountVerified: Boolean(operations), clusterVerified: Boolean(operations), readOnly: true, adminConfigured };
}
async function hasAdmin(Client) {
  const document = application.readProtectedJson(application.FILE), anchor = application.readProtectedJson(application.ANCHOR);
  return verifyPreparedPair({ resolved: application.resolveDocument(document, anchor) }, Client);
}
if (require.main === module) Promise.resolve().then(async () => {
  const mode = process.argv[2];
  if (!['documents', 'check', 'has-admin'].includes(mode) || process.argv.length !== 3) fail("PG_INSTALL_ARGUMENTS");
  if (mode === "has-admin") {
    const result = await hasAdmin(require("pg").Client);
    if (!result.adminConfigured) process.exitCode = 1;
    return result;
  }
  const prepared = readPreparedDocuments();
  if (mode === "documents") return { ok: true, providerId: "postgresql", databasePairPrepared: true, liveConnectionsChecked: false };
  return verifyPreparedPair(prepared, require("pg").Client);
}).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stderr.write(JSON.stringify({ ok: false, code: /^PG_(?:INSTALL|APPLICATION|RUNTIME)_/.test(error.code || error.message) ? error.code || error.message : "PG_INSTALL_PREFLIGHT_FAILED" }) + "\n"); process.exitCode = 1; });
module.exports = { validatePreparedDocuments, readPreparedDocuments, verifyPreparedPair, hasAdmin };
