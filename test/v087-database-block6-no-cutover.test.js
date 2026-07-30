"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  IMPLEMENTED_PERSISTENCE_PROVIDER_IDS,
  resolvePersistenceConfiguration,
} = require("../lib/persistence/configuration");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/errors");
const {
  OPERATIONAL_CAPABILITY_KEYS,
  createOperationalCapabilityReport,
} = require("../lib/persistence/operations/contract");
const {
  POSTGRESQL_CAPABILITIES,
} = require("../lib/persistence/postgresql/provider");
const {
  POSTGRESQL_OPERATIONAL_PROFILE,
  createPostgresqlToolPolicy,
} = require("../lib/persistence/postgresql/operations/tools");
const {
  REQUIRED_ACCESS_POLICY,
  createPostgresqlOperationsMonitor,
} = require("../lib/persistence/postgresql/operations/monitor");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function javascriptFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(directory.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) return javascriptFiles(relativePath);
      return entry.isFile() && entry.name.endsWith(".js") ? [relativePath] : [];
    });
}

function unavailableCapability() {
  return {
    implemented: false,
    configured: false,
    verified: false,
    reasonCode: "DEVELOPMENT_ONLY",
    lastVerifiedAt: null,
    maximumAgeHours: null,
  };
}

test("DB Block 6 No-Cutover: ausschliesslich SQLite bleibt als Produktprovider aktiv", () => {
  assert.deepEqual([...IMPLEMENTED_PERSISTENCE_PROVIDER_IDS], ["sqlite"]);
  assert.throws(
    () => resolvePersistenceConfiguration({
      environment: { DB_PROVIDER: "postgresql" },
      defaultSqlitePath: path.join(root, "data", "dienstplan.db"),
    }),
    (error) => error?.code === PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE,
  );
});

test("DB Block 6 No-Cutover: PostgreSQL-Produktfaehigkeiten bleiben geschlossen", () => {
  for (const capability of [
    "multipleAppInstances",
    "databaseBackup",
    "restore",
    "integrityCheck",
    "recoveryAssurance",
    "systemCenterStatus",
    "pairedDocumentBackup",
    "pointInTimeRecovery",
  ]) {
    assert.equal(
      POSTGRESQL_CAPABILITIES.features[capability],
      false,
      `${capability} darf vor abgeschlossener Block-7-Installationsfreigabe nicht aktiviert werden`,
    );
  }
});

test("DB Block 6 No-Cutover: Operationsprofile und Reports bleiben Development-only", async () => {
  assert.equal(POSTGRESQL_OPERATIONAL_PROFILE, "development-contract");
  const policy = createPostgresqlToolPolicy({
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    pgDumpPath: path.join(root, "pg_dump"),
    pgRestorePath: path.join(root, "pg_restore"),
  });
  assert.equal(policy.profile, "development-contract");
  assert.equal(policy.productActivation, false);

  const capabilities = Object.fromEntries(
    OPERATIONAL_CAPABILITY_KEYS.map((key) => [key, unavailableCapability()]),
  );
  const capabilityReport = createOperationalCapabilityReport({
    providerId: "postgresql",
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    backupMethod: policy.backupMethod,
    restoreMethod: policy.restoreMethod,
    artifactFormat: "grabenplaner-backup-bundle-v2",
    generatedAt: "2026-07-30T12:00:00.000Z",
    capabilities,
  });
  assert.equal(capabilityReport.profile, "development-contract");
  assert.equal(capabilityReport.productActivation, false);
  for (const capability of Object.values(capabilityReport.capabilities)) {
    assert.equal(capability.effective, false);
  }

  const monitor = createPostgresqlOperationsMonitor({
    operationsQuery: async () => ({
      rows: [{
        server_version_num: "180001",
        in_recovery: false,
        transaction_read_only: true,
        database_bytes: "1",
        connections_total: "1",
        connections_active: "0",
        connections_idle_in_transaction: "0",
        connections_waiting: "0",
        commits: "0",
        rollbacks: "0",
        deadlocks: "0",
        identity_matches_session: true,
        role_superuser: false,
        role_createdb: false,
        role_createrole: false,
        role_replication: false,
        role_bypassrls: false,
        role_monitor_membership: true,
        role_unexpected_memberships: "0",
      }],
    }),
    accessPolicy: { ...REQUIRED_ACCESS_POLICY },
    now: () => "2026-07-30T12:00:00.000Z",
  });
  const monitoringReport = await monitor.read({ capabilityReport });
  assert.equal(monitoringReport.profile, "development-contract");
  assert.equal(monitoringReport.productActivation, false);
  assert.notEqual(monitoringReport.state, "supported");
});

test("DB Block 6 No-Cutover: server.js oeffnet keinen PostgreSQL-Produktpfad", () => {
  const server = read("server.js");
  assert.match(server, /require\("\.\/lib\/persistence\/sqlite\/provider"\)/);
  assert.match(server, /openSqliteApplicationPersistence\(/);
  assert.doesNotMatch(server, /require\(["']\.\/lib\/persistence\/postgresql\//);
  assert.doesNotMatch(server, /require\(["']pg["']\)/);
  assert.doesNotMatch(server, /\bcreatePostgresql(?:Persistence)?Provider\s*\(/);
  assert.doesNotMatch(server, /\bcreatePostgresqlOperationsMonitor\s*\(/);
});

test("DB Block 6 No-Cutover: README und Produktoberflaeche melden keinen PostgreSQL-Support", () => {
  const readme = read("README.md");
  assert.match(readme, /SQLite ist der aktuell unterst\S+tzte Produktprovider\./);
  assert.match(
    readme,
    /PostgreSQL besitzt eine nicht produktive Entwicklungs- und Nachweisgrundlage,[\s\S]*noch nicht f\S+r Installation oder Migration freigegeben\./,
  );

  const productSurface = [
    read("public/index.html"),
    read("public/app.js"),
    read("public/styles.css"),
  ].join("\n");
  assert.doesNotMatch(productSurface, /\bPostgreSQL\b|\bpostgresql\b/i);
});

test("DB Block 6 No-Cutover: neue Betriebsdateien aktivieren weder Cutover noch VPS oder Auto-Migration", () => {
  const operationalFiles = [
    "lib/backup-bundle.js",
    ...javascriptFiles("lib/persistence/operations"),
    ...javascriptFiles("lib/persistence/postgresql/operations"),
  ];
  const operationalSource = operationalFiles
    .map((file) => `\n/* ${file} */\n${read(file)}`)
    .join("\n");

  for (const forbidden of [
    /\bcutover\b/i,
    /\bVPS\b/,
    /\b(?:ssh|scp|systemctl)\b/i,
    /\bgrabenplaner\.service\b/i,
    /\bauto(?:matic)?[-_ ]?migrat/i,
    /\bDB_PROVIDER\s*=/,
    /\bDATABASE_URL\s*=/,
  ]) {
    assert.doesNotMatch(operationalSource, forbidden);
  }

  const postgresqlOperationalSource = javascriptFiles("lib/persistence/postgresql/operations")
    .map(read)
    .join("\n");
  assert.doesNotMatch(postgresqlOperationalSource, /productActivation\s*:\s*true/);
  assert.doesNotMatch(postgresqlOperationalSource, /profile\s*:\s*["']supported["']/);

  const packageMetadata = JSON.parse(read("package.json"));
  const packageCommands = Object.values(packageMetadata.scripts || {}).join("\n");
  assert.doesNotMatch(packageCommands, /\b(?:cutover|deploy|vps)\b|postgresql.*migrat/i);
});

test("DB Block 7 Startpruefung: Installationsmigration bleibt dokumentiert auf NO-GO", () => {
  const operationsContract = read("docs/DATENBANK-POSTGRESQL-BETRIEB-UND-RECOVERY.md");
  assert.match(operationsContract, /Block-7-Startpr\S+fung am 30\.07\.2026/);
  assert.match(operationsContract, /Ergebnis ist\s+\*\*NO-GO\*\*/);
  assert.match(operationsContract, /keine konkrete Zielinstallation/);
  assert.match(operationsContract, /keine Installation, keinen VPS, keine\s+Produktkonfiguration/);
  assert.match(operationsContract, /SQLite der einzige unterst\S+tzte und produktive\s+Datenbankprovider/);
});
