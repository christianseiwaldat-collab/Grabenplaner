"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { __internalTestOnly, assertFrozenTree } = require("./recovery-metadata.js");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(message); }
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function regular(file, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) {
    fail("Eine Recovery-Pruefdatei ist unzulaessig.");
  }
  return stat;
}

function readJson(file, options) {
  regular(file, options);
  const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Recovery-Metadaten sind ungueltig.");
  return value;
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(temporary, 0o400);
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") {
    const directoryHandle = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  }
}

function runNode(script, args) {
  regular(script, { maximumBytes: 4 * 1024 * 1024 });
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) fail("Eine isolierte Recovery-Pruefung ist fehlgeschlagen.");
  return String(result.stdout || "");
}

function parseSemver(value) {
  const match = String(value || "").match(SEMVER);
  if (!match) fail("Eine App-Version im Recovery-Sicherungspunkt ist nicht vergleichbar.");
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : null };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const compared = compareIdentifiers(left.pre[index], right.pre[index]);
    if (compared) return compared;
  }
  return 0;
}

function readEnvironment(file, internalPolicy) {
  const stat = regular(file, { maximumBytes: 64 * 1024 });
  const requireRootOwner = process.platform === "linux"
    && internalPolicy !== __internalTestOnly.nonRootOwnershipPolicy;
  if (process.platform === "linux" && ((requireRootOwner && stat.uid !== 0) || (stat.mode & 0o077) !== 0)) {
    fail("Die Recovery-Schluesseldatei ist unzulaessig.");
  }
  const values = new Map();
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) fail("Die Recovery-Schluesseldatei enthaelt eine ungueltige Zeile.");
    if (values.has(match[1])) fail("Die Recovery-Schluesseldatei enthaelt doppelte Werte.");
    values.set(match[1], match[2]);
  }
  return values;
}

function encryptionConfiguration(environment) {
  const amuKeyId = String(environment.get("GRABENPLANER_AMU_KEY_ID") || "");
  const amuKey = String(environment.get("GRABENPLANER_AMU_KEY") || "");
  const integrationKeyId = String(environment.get("GRABENPLANER_INTEGRATION_KEY_ID") || "");
  const integrationKey = String(environment.get("GRABENPLANER_INTEGRATION_KEY") || "");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(amuKeyId) || !/^[A-Za-z0-9+/_=-]{32,256}$/.test(amuKey)) {
    fail("Der AMU-Wiederherstellungsschluessel fehlt oder ist ungueltig.");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(integrationKeyId) || !/^[A-Za-z0-9+/_=-]{32,256}$/.test(integrationKey)) {
    fail("Der Integrations-Wiederherstellungsschluessel fehlt oder ist ungueltig.");
  }
  const integrationKeys = { [integrationKeyId]: integrationKey };
  const keyRing = String(environment.get("GRABENPLANER_INTEGRATION_KEYS") || "");
  if (keyRing) {
    const parsed = JSON.parse(keyRing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Der Integrationsschluesselring ist ungueltig.");
    for (const [keyId, key] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof key !== "string") fail("Der Integrationsschluesselring ist ungueltig.");
      integrationKeys[keyId] = key;
    }
  }
  return { amuKeyId, amuKey, integrationKeyId, integrationKeys };
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function rowsIf(database, table, requiredColumns, statement) {
  if (!tableExists(database, table)) return [];
  const available = columns(database, table);
  if (requiredColumns.some((column) => !available.has(column))) fail("Eine geschuetzte Datenbanktabelle ist nicht kompatibel.");
  return database.prepare(statement).all();
}

function protectedJson(storage, value, context, { allowLegacy = true } = {}) {
  const text = storage.unprotectRecord(value, context, { allowLegacy });
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Ein geschuetzter Datensatz ist ungueltig.");
}

function verifyProtectedRecords(database, storage) {
  let verified = 0;
  for (const row of rowsIf(database, "personnel_sensitive_records", ["employee_number", "protected_payload"],
    "SELECT employee_number, protected_payload FROM personnel_sensitive_records ORDER BY employee_number")) {
    protectedJson(storage, row.protected_payload, { namespace: "personnel-sensitive-record", recordId: String(row.employee_number), field: "payload", employeeNumber: String(row.employee_number) }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "personnel_record_documents", ["id", "employee_number", "protected_payload"],
    "SELECT id, employee_number, protected_payload FROM personnel_record_documents ORDER BY employee_number, id")) {
    protectedJson(storage, row.protected_payload, { namespace: "personnel-record-attachment", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "amu_reports", ["id", "employee_number", "protected_payload", "employee_note", "review_note"],
    "SELECT id, employee_number, protected_payload, employee_note, review_note FROM amu_reports ORDER BY id")) {
    if (row.protected_payload) {
      protectedJson(storage, row.protected_payload, { namespace: "personnel-record", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) });
      verified += 1;
    }
    for (const legacy of [row.employee_note, row.review_note]) if (String(legacy || "").startsWith("enc:v1:")) { storage.unprotectText(legacy); verified += 1; }
  }
  for (const row of rowsIf(database, "amu_documents", ["id", "report_id", "protected_payload", "original_filename"], `
    SELECT d.id, d.protected_payload, d.original_filename, r.employee_number
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.status <> 'purged' ORDER BY d.id`)) {
    if (row.protected_payload) {
      protectedJson(storage, row.protected_payload, { namespace: "personnel-record-document", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) });
      verified += 1;
    }
    if (String(row.original_filename || "").startsWith("enc:v1:")) { storage.unprotectText(row.original_filename); verified += 1; }
  }
  for (const row of rowsIf(database, "sickness_cases", ["id", "employee_lookup", "protected_payload"],
    "SELECT id, employee_lookup, protected_payload FROM sickness_cases ORDER BY id")) {
    protectedJson(storage, row.protected_payload, { namespace: "sickness-case", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_lookup) });
    verified += 1;
  }
  for (const row of rowsIf(database, "sickness_alerts", ["id", "sickness_case_id", "protected_payload"],
    "SELECT id, sickness_case_id, protected_payload FROM sickness_alerts ORDER BY id")) {
    protectedJson(storage, row.protected_payload, { namespace: "sickness-alert", recordId: String(row.id), field: "payload", employeeNumber: String(row.sickness_case_id) });
    verified += 1;
  }
  for (const row of rowsIf(database, "sickness_notification_preferences", ["employee_number", "channel", "protected_destination"],
    "SELECT employee_number, channel, protected_destination FROM sickness_notification_preferences WHERE protected_destination <> '' ORDER BY employee_number, channel")) {
    protectedJson(storage, row.protected_destination, { namespace: "sickness-notification-preference", recordId: `${row.employee_number}:${row.channel}`, field: "destination", employeeNumber: String(row.employee_number) });
    verified += 1;
  }
  for (const row of rowsIf(database, "outbound_notification_jobs", ["id", "recipient_lookup", "protected_payload"],
    "SELECT id, recipient_lookup, protected_payload FROM outbound_notification_jobs ORDER BY id")) {
    protectedJson(storage, row.protected_payload, { namespace: "outbound-notification-job", recordId: String(row.id), field: "payload", employeeNumber: String(row.recipient_lookup) });
    verified += 1;
  }
  for (const row of rowsIf(database, "privacy_requests", ["id", "employee_number", "protected_payload"],
    "SELECT id, employee_number, protected_payload FROM privacy_requests ORDER BY id")) {
    protectedJson(storage, row.protected_payload, {
      namespace: "privacy-request",
      recordId: String(row.id),
      field: "state",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "privacy_request_events", ["id", "request_id", "protected_payload"], `
    SELECT e.id, e.protected_payload, r.employee_number
    FROM privacy_request_events e
    JOIN privacy_requests r ON r.id = e.request_id
    ORDER BY e.id`)) {
    protectedJson(storage, row.protected_payload, {
      namespace: "privacy-request-event",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "vacation_account_revisions", ["id", "employee_number", "calculation_json"],
    "SELECT id, employee_number, calculation_json FROM vacation_account_revisions ORDER BY id")) {
    protectedJson(storage, row.calculation_json, {
      namespace: "vacation-account",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "vacation_history_events", ["id", "employee_number", "snapshot_json"],
    "SELECT id, employee_number, snapshot_json FROM vacation_history_events ORDER BY id")) {
    protectedJson(storage, row.snapshot_json, {
      namespace: "vacation-history-event",
      recordId: String(row.id),
      field: "snapshot",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "time_record_statements", ["id", "employee_number", "snapshot_json"],
    "SELECT id, employee_number, snapshot_json FROM time_record_statements ORDER BY id")) {
    protectedJson(storage, row.snapshot_json, {
      namespace: "time-record-statement",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "payroll_handoffs", ["id", "payload_json"],
    "SELECT id, payload_json FROM payroll_handoffs ORDER BY id")) {
    protectedJson(storage, row.payload_json, {
      namespace: "payroll-handoff",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "payroll_handoff_events", ["id", "payload_json"],
    "SELECT id, payload_json FROM payroll_handoff_events ORDER BY id")) {
    protectedJson(storage, row.payload_json, {
      namespace: "payroll-handoff-event",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of rowsIf(database, "retention_preview_runs", ["id", "result_json"],
    "SELECT id, result_json FROM retention_preview_runs ORDER BY id")) {
    protectedJson(storage, row.result_json, {
      namespace: "retention-preview",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  return verified;
}

async function verifyIntegrationCredentials(database, integrationModule, configuration) {
  const { createIntegrationSecretVault } = require(integrationModule);
  const vault = createIntegrationSecretVault({ activeKeyId: configuration.integrationKeyId, keys: configuration.integrationKeys });
  if (!tableExists(database, "integration_connections")) return 0;
  const available = columns(database, "integration_connections");
  for (const column of ["id", "kind", "protected_credentials"]) if (!available.has(column)) fail("Die Schnittstellentabelle ist nicht kompatibel.");
  const rows = database.prepare("SELECT id, kind, protected_credentials FROM integration_connections WHERE protected_credentials <> '' ORDER BY id").all();
  if (!rows.length) return 0;
  for (const row of rows) {
    await vault.useSecret(row.protected_credentials, {
      namespace: "integration-connection", connectorId: String(row.id), field: "credentials", purpose: String(row.kind || "integration"),
    }, async (buffer) => {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Geschuetzte Schnittstellenzugangsdaten sind ungueltig.");
    });
  }
  return rows.length;
}

function assertCompatibility(database, sourcePackage, targetPackage, sourceRuntime, targetRuntime) {
  const sourceVersion = String(sourcePackage.version || "");
  const targetVersion = String(targetPackage.version || "");
  if (compareSemver(sourceVersion, targetVersion) > 0) fail("Der Sicherungspunkt stammt aus einer neueren App-Version.");
  for (const contract of [sourceRuntime, targetRuntime]) {
    if (contract.format !== "grabenplaner-linux-runtime-contract" || contract.schemaVersion !== 1
      || !Number.isSafeInteger(contract.deploymentSchemaVersion) || contract.deploymentSchemaVersion < 1) {
      fail("Der Linux-Runtimevertrag ist nicht kompatibel.");
    }
  }
  if (sourceRuntime.deploymentSchemaVersion > targetRuntime.deploymentSchemaVersion) {
    fail("Der Sicherungspunkt benoetigt ein neueres Deployment-Schema.");
  }
  if (tableExists(database, "schema_migrations")) {
    const available = columns(database, "schema_migrations");
    if (!available.has("app_version")) fail("Die Migrationshistorie ist nicht kompatibel.");
    for (const row of database.prepare("SELECT DISTINCT app_version FROM schema_migrations WHERE TRIM(app_version) <> ''").all()) {
      if (compareSemver(String(row.app_version), targetVersion) > 0) fail("Die Datenbank benoetigt eine neuere App-Version.");
    }
  }
  return { sourceVersion, targetVersion, deploymentSchemaVersion: sourceRuntime.deploymentSchemaVersion };
}

async function verifyRecovery(options, internalPolicy) {
  const stage = path.resolve(options.stage);
  const stageStat = fs.lstatSync(stage);
  if (!path.isAbsolute(options.stage) || stage === path.parse(stage).root || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    fail("Der Recovery-Baum ist unzulaessig.");
  }
  const frozenFiles = assertFrozenTree(stage, internalPolicy);
  const stageOutput = JSON.parse(runNode(path.resolve(options.stageHelper), ["verify", stage]));
  for (const name of ["database", "documents", "commitMarker"]) {
    const resolved = path.resolve(String(stageOutput[name] || ""));
    if (!resolved.startsWith(`${stage}${path.sep}`)) fail("Ein Recovery-Ergebnis verlaesst den eingefrorenen Baum.");
  }
  const backupResult = JSON.parse(runNode(path.resolve(options.backupVerifier), [
    stageOutput.database, stageOutput.documents, path.resolve(options.amuModule), stageOutput.commitMarker,
  ]));
  if (backupResult.ok !== true || !HASH.test(String(backupResult.databaseSha256 || ""))) fail("Der Recovery-Sicherungspunkt ist ungueltig.");

  const sourcePackage = readJson(path.join(stage, "recovery", "package.json"), { maximumBytes: 1024 * 1024 });
  const targetPackage = readJson(path.resolve(options.targetPackage), { maximumBytes: 1024 * 1024 });
  const sourceRuntime = readJson(path.join(stage, "recovery", "runtime-schema.json"), { maximumBytes: 256 * 1024 });
  const targetRuntime = readJson(path.resolve(options.targetRuntime), { maximumBytes: 256 * 1024 });
  const environment = encryptionConfiguration(readEnvironment(path.resolve(options.environment), internalPolicy));
  const { validateEncryptionKeyForStorage, createAmuStorage } = require(path.resolve(options.amuModule));
  validateEncryptionKeyForStorage({
    sourceDirectory: stageOutput.documents,
    encryptionKeys: { [environment.amuKeyId]: environment.amuKey },
    activeKeyId: environment.amuKeyId,
  });

  const scratch = fs.mkdtempSync(path.join(options.scratchRoot ? path.resolve(options.scratchRoot) : os.tmpdir(), ".recovery-key-check-"));
  fs.chmodSync(scratch, 0o700);
  let database;
  try {
    const storage = createAmuStorage({ rootDirectory: path.join(scratch, "amu"), encryptionKeys: { [environment.amuKeyId]: environment.amuKey }, activeKeyId: environment.amuKeyId });
    database = new DatabaseSync(stageOutput.database, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0]));
    if (integrity.length !== 1 || integrity[0] !== "ok") fail("SQLite integrity_check ist fehlgeschlagen.");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) fail("Die SQLite-Fremdschluesselpruefung ist fehlgeschlagen.");
    const compatibility = assertCompatibility(database, sourcePackage, targetPackage, sourceRuntime, targetRuntime);
    const protectedRecords = verifyProtectedRecords(database, storage);
    const integrationCredentials = await verifyIntegrationCredentials(database, path.resolve(options.integrationModule), environment);
    const manifestPath = path.join(stage, "offsite-stage-manifest.json");
    const result = {
      ok: true,
      databaseSha256: backupResult.databaseSha256,
      stageManifestSha256: sha256File(manifestPath),
      sourceAppVersion: compatibility.sourceVersion,
      targetAppVersion: compatibility.targetVersion,
      deploymentSchemaVersion: compatibility.deploymentSchemaVersion,
      protectedDocuments: Number(backupResult.protectedFiles || 0),
      protectedRecords,
      integrationCredentials,
      frozenFiles: frozenFiles.length,
      verifiedAt: new Date().toISOString(),
    };
    atomicJson(path.resolve(options.output), result);
    return result;
  } finally {
    if (database) database.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const names = new Set(["stage", "stage-helper", "backup-verifier", "amu-module", "integration-module", "environment", "target-package", "target-runtime", "scratch-root", "output"]);
  const options = {};
  const args = [...argv];
  while (args.length) {
    const name = String(args.shift() || "");
    if (!name.startsWith("--") || !names.has(name.slice(2)) || !args.length) fail("Recovery-Pruefparameter sind unvollstaendig.");
    if (Object.hasOwn(options, name.slice(2))) fail("Recovery-Pruefparameter sind doppelt.");
    options[name.slice(2)] = String(args.shift());
  }
  for (const name of names) if (name !== "scratch-root" && !options[name]) fail("Recovery-Pruefparameter sind unvollstaendig.");
  return {
    stage: options.stage,
    stageHelper: options["stage-helper"],
    backupVerifier: options["backup-verifier"],
    amuModule: options["amu-module"],
    integrationModule: options["integration-module"],
    environment: options.environment,
    targetPackage: options["target-package"],
    targetRuntime: options["target-runtime"],
    scratchRoot: options["scratch-root"],
    output: options.output,
  };
}

if (require.main === module) {
  verifyRecovery(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, databaseSha256: result.databaseSha256 })}\n`))
    .catch((error) => { process.stderr.write(`${error?.message || "Recovery-Pruefung fehlgeschlagen."}\n`); process.exitCode = 1; });
}

module.exports = {
  assertCompatibility,
  compareSemver,
  readEnvironment,
  verifyProtectedRecords,
  verifyRecovery,
};
