"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o6-interfaces-api-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const CATALOG_ROUTE = "/api/portal/v1/personnel-lifecycle/interfaces/catalog";
const DOMAIN_IDS = Object.freeze(["training", "asset", "access"]);
const ACTION_IDS = Object.freeze(["read", "manage", "dispatch", "reconcile"]);
const O6_PERMISSION_IDS = Object.freeze(DOMAIN_IDS.flatMap((domainId) => (
  ACTION_IDS.map((actionId) => `personnel:lifecycle:interfaces:${domainId}:${actionId}`)
)));
const ELIGIBLE_ROLES = Object.freeze(["hr", "admin", "it_admin", "developer"]);
const MAXIMUM_FIELDS = Object.freeze({
  training: Object.freeze([
    "orderId",
    "displayName",
    "locationId",
    "departmentId",
    "module",
    "dueAt",
    "evidenceStatus",
    "status",
  ]),
  asset: Object.freeze([
    "orderId",
    "displayName",
    "locationId",
    "assetIdentifier",
    "action",
    "dueAt",
    "status",
  ]),
  access: Object.freeze([
    "orderId",
    "displayName",
    "businessIdentifier",
    "targetSystem",
    "action",
    "executeAt",
    "status",
  ]),
});
const PRIVATE_MARKERS = Object.freeze([
  "O6 Ohne Fachrecht",
  "O6 Technische Rolle",
  "O6 Reservierte Rechte",
  "O6 Schulung Katalog",
  "O6 Arbeitsmittel Zugang",
  "O6 Passwortwechsel ausstehend",
  "O6-PRIVATE-HR-MARKER",
]);
const EXPECTED_DOMAIN_KEYS = Object.freeze([
  "blockerCodes",
  "defaultPayloadFields",
  "externalEffectsEnabled",
  "id",
  "label",
  "maximumProjectionFields",
  "operations",
  "optionalProviderFields",
  "providerCount",
  "status",
]);
const SNAPSHOT_TABLE_NAMES = Object.freeze([
  "integration_deliveries",
  "outbound_notification_jobs",
  "portal_notifications",
  "portal_users",
  "portal_roles",
  "portal_permission_grants",
  "portal_permission_denials",
  "portal_permission_scope_grants",
  "portal_access_scopes",
  "portal_sessions",
]);

let httpServer;
let baseUrl;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function configuredInstallationFeatures() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get();
  try {
    const parsed = JSON.parse(String(stored?.value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setPersonnelLifecycleEnabled(enabled) {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  if (enabled) features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function insertEmployee(employeeNumber, fullName) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, active
    ) VALUES (?, ?, ?, 1)
  `).run(employeeNumber, fullName, "O6-PRIVATE-HR-MARKER");
}

function createSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, role_locked, active,
      must_change_password, password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, sha256(rawToken));
  return Object.freeze({
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  });
}

function grantPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, 'O6-API-TEST')
  `).run(employeeNumber, permission);
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
} = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload, text };
}

function createFixture() {
  const definitions = Object.freeze([
    Object.freeze({ employeeNumber: "O6-NO-RIGHTS", name: PRIVATE_MARKERS[0], role: "employee" }),
    Object.freeze({ employeeNumber: "O6-TECHNICAL", name: PRIVATE_MARKERS[1], role: "it_admin" }),
    Object.freeze({ employeeNumber: "O6-NON-READ", name: PRIVATE_MARKERS[2], role: "hr" }),
    Object.freeze({ employeeNumber: "O6-TRAINING", name: PRIVATE_MARKERS[3], role: "hr" }),
    Object.freeze({ employeeNumber: "O6-ASSET-ACCESS", name: PRIVATE_MARKERS[4], role: "admin" }),
    Object.freeze({ employeeNumber: "O6-MUST-CHANGE", name: PRIVATE_MARKERS[5], role: "hr" }),
  ]);
  const sessions = {};
  for (const definition of definitions) {
    insertEmployee(definition.employeeNumber, definition.name);
    sessions[definition.employeeNumber] = createSession(definition.employeeNumber, definition.role);
  }
  for (const domainId of DOMAIN_IDS) {
    for (const actionId of ["manage", "dispatch", "reconcile"]) {
      grantPermission("O6-NON-READ", `personnel:lifecycle:interfaces:${domainId}:${actionId}`);
    }
  }
  grantPermission("O6-TRAINING", "personnel:lifecycle:interfaces:training:read");
  grantPermission("O6-ASSET-ACCESS", "personnel:lifecycle:interfaces:asset:read");
  grantPermission("O6-ASSET-ACCESS", "personnel:lifecycle:interfaces:access:read");
  grantPermission("O6-MUST-CHANGE", "personnel:lifecycle:interfaces:training:read");
  db.prepare(`
    UPDATE portal_users
    SET must_change_password = 1, password_changed_at = NULL
    WHERE employee_number = ?
  `).run("O6-MUST-CHANGE");
  setPersonnelLifecycleEnabled(true);
  return Object.freeze(sessions);
}

function normalizeSnapshotValue(value) {
  if (Buffer.isBuffer(value)) return { type: "Buffer", base64: value.toString("base64") };
  return value;
}

function protectedTableNames() {
  const existing = new Set(db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `).all().map(({ name }) => String(name)));
  const dynamic = [...existing].filter((tableName) => (
    tableName.startsWith("loan")
    || tableName.startsWith("personnel_lifecycle_")
    || tableName.startsWith("custom_process_run")
    || tableName === "personnel_employment_episodes"
  ));
  return [...new Set([...SNAPSHOT_TABLE_NAMES, ...dynamic])]
    .filter((tableName) => existing.has(tableName))
    .sort();
}

function protectedStateSnapshot() {
  return Object.fromEntries(protectedTableNames().map((tableName) => {
    assert.match(tableName, /^[a-z0-9_]+$/);
    const rows = db.prepare(`SELECT * FROM "${tableName}"`).all()
      .map((row) => Object.fromEntries(Object.entries(row)
        // Die zentrale Portal-Authentisierung aktualisiert Heartbeat und gleitendes Ablaufdatum.
        // Identitaet, Token und Widerruf der Sitzung bleiben vollstaendig im Snapshot.
        .filter(([key]) => tableName !== "portal_sessions" || !["last_seen_at", "expires_at"].includes(key))
        .map(([key, value]) => [key, normalizeSnapshotValue(value)])))
      .map((row) => JSON.stringify(row))
      .sort();
    return [tableName, { count: rows.length, sha256: sha256(JSON.stringify(rows)) }];
  }));
}

function assertNoPrivateData(payload) {
  const serialized = JSON.stringify(payload);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(serialized.includes(marker), false, `Katalog enthaelt HR-Testwert: ${marker}`);
  }
  for (const forbiddenTerm of [
    "endpoint",
    "credential",
    "secret",
    "caseid",
    "runid",
    "stepid",
    "employeenumber",
    "personnelnumber",
  ]) {
    assert.equal(
      serialized.toLowerCase().includes(forbiddenTerm),
      false,
      `Katalog enthaelt verbotenes Feld oder Konfigurationsdetail: ${forbiddenTerm}`,
    );
  }
}

function assertRuntimeGatesClosed(runtimeGates) {
  assert.ok(runtimeGates && typeof runtimeGates === "object" && !Array.isArray(runtimeGates));
  const gates = Object.entries(runtimeGates);
  assert.ok(gates.length > 0, "Der Vertrag muss seine geschlossenen Runtime-Gates ausweisen.");
  for (const [gateId, value] of gates) {
    assert.equal(value, false, `Runtime-Gate ${gateId} ist nicht fail-closed.`);
  }
}

function assertDomainContract(domain, expectedId) {
  assert.deepEqual(Object.keys(domain).sort(), [...EXPECTED_DOMAIN_KEYS].sort());
  assert.equal(domain.id, expectedId);
  assert.equal(typeof domain.label, "string");
  assert.ok(domain.label.length > 0);
  assert.equal(domain.status, "blocked");
  assert.equal(domain.providerCount, 0);
  assert.equal(domain.externalEffectsEnabled, false);
  assert.ok(Array.isArray(domain.blockerCodes));
  assert.ok(domain.blockerCodes.length >= 1);
  assert.equal(domain.blockerCodes.every((code) => typeof code === "string" && code.length > 0), true);
  const normalizedBlockers = domain.blockerCodes.join(" ").toUpperCase();
  assert.match(normalizedBlockers, /PROVIDER|TARGET|REGISTRY|ALLOWLIST/);
  assert.ok(Array.isArray(domain.operations));
  assert.ok(domain.operations.length > 0);
  assert.equal(domain.operations.every((operation) => typeof operation === "string"), true);
  assert.deepEqual(domain.maximumProjectionFields, MAXIMUM_FIELDS[expectedId]);
  assert.ok(Array.isArray(domain.defaultPayloadFields));
  assert.ok(Array.isArray(domain.optionalProviderFields));
  const maximumFields = new Set(domain.maximumProjectionFields);
  for (const field of domain.optionalProviderFields) {
    assert.equal(maximumFields.has(field), true, `${expectedId} gibt Feld ${field} ausserhalb von O1 frei.`);
  }
}

function assertCatalogResponse(result, expectedDomainIds) {
  assert.equal(result.response.status, 200, result.text);
  assert.match(result.response.headers.get("cache-control") || "", /(?:^|,\s*)no-store(?:,|$)/i);
  assert.equal(result.response.headers.get("pragma"), "no-cache");
  assert.equal(result.response.headers.has("etag"), false);
  assert.deepEqual(
    Object.keys(result.payload || {}).sort(),
    ["contractVersion", "domains", "registry", "runtimeGates"].sort(),
  );
  assert.ok(
    (typeof result.payload.contractVersion === "string" && result.payload.contractVersion.length > 0)
      || (Number.isInteger(result.payload.contractVersion) && result.payload.contractVersion > 0),
  );
  assert.deepEqual(result.payload.registry, {
    providerCount: 0,
    activeProviderCount: 0,
    customerConfigured: false,
  });
  assertRuntimeGatesClosed(result.payload.runtimeGates);
  assert.ok(Array.isArray(result.payload.domains));
  assert.deepEqual(
    new Set(result.payload.domains.map(({ id }) => id)),
    new Set(expectedDomainIds),
  );
  assert.equal(result.payload.domains.length, expectedDomainIds.length);
  for (const domain of result.payload.domains) assertDomainContract(domain, domain.id);
  assertNoPrivateData(result.payload);
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("O6 Schnittstellenkatalog bleibt rechtegetrennt, datensparsam und ohne Aussenwirkung", async (t) => {
  const sessions = createFixture();

  await t.test("ohne Sitzung, Fachrecht oder mit rein technischer Rolle bleibt der Katalog gesperrt", async () => {
    const unauthenticated = await request(CATALOG_ROUTE);
    assert.equal(unauthenticated.response.status, 401, unauthenticated.text);

    for (const employeeNumber of ["O6-NO-RIGHTS", "O6-TECHNICAL", "O6-NON-READ"]) {
      const denied = await request(CATALOG_ROUTE, { auth: sessions[employeeNumber] });
      assert.equal(denied.response.status, 403, `${employeeNumber}: ${denied.text}`);
      assertNoPrivateData(denied.payload);
    }
  });

  await t.test("ein ausstehender Startpasswortwechsel sperrt auch ein explizites O6-Recht", async () => {
    const denied = await request(CATALOG_ROUTE, { auth: sessions["O6-MUST-CHANGE"] });
    assert.equal(denied.response.status, 428, denied.text);
    assert.equal(denied.payload?.code, "PORTAL_PASSWORD_CHANGE_REQUIRED", denied.text);
    assertNoPrivateData(denied.payload);
  });

  await t.test("der lokale Systemmodus erhaelt keinen O6-Katalog", async () => {
    const previousForcePortal = process.env.GRABENPLANER_FORCE_PORTAL;
    process.env.GRABENPLANER_FORCE_PORTAL = "0";
    try {
      const denied = await request(CATALOG_ROUTE);
      assert.equal(denied.response.status, 403, denied.text);
      assert.equal(
        denied.payload?.code,
        "PERSONNEL_LIFECYCLE_INTERFACE_CATALOG_PERMISSION_REQUIRED",
        denied.text,
      );
      assertNoPrivateData(denied.payload);
    } finally {
      process.env.GRABENPLANER_FORCE_PORTAL = previousForcePortal;
    }
  });

  await t.test("jedes read-Recht projiziert ausschliesslich seine freigegebenen Domaenen", async () => {
    const training = await request(CATALOG_ROUTE, { auth: sessions["O6-TRAINING"] });
    assertCatalogResponse(training, ["training"]);

    const assetAndAccess = await request(CATALOG_ROUTE, { auth: sessions["O6-ASSET-ACCESS"] });
    assertCatalogResponse(assetAndAccess, ["asset", "access"]);
  });

  await t.test("Feature-Abschaltung macht auch den read-only Katalog unverfuegbar", async () => {
    setPersonnelLifecycleEnabled(false);
    try {
      const disabled = await request(CATALOG_ROUTE, { auth: sessions["O6-TRAINING"] });
      assert.equal(disabled.response.status, 403, disabled.text);
      assert.equal(disabled.payload?.code, "FEATURE_DISABLED", disabled.text);
      assertNoPrivateData(disabled.payload);
    } finally {
      setPersonnelLifecycleEnabled(true);
    }
  });

  await t.test("alle zwolf reservierten Rechte sind katalogisiert; nur developer erhält sie automatisch", async () => {
    const roles = await request("/api/portal/v1/roles", { auth: sessions["O6-ASSET-ACCESS"] });
    assert.equal(roles.response.status, 200, roles.text);
    const entries = (roles.payload?.catalog || [])
      .filter(({ id }) => String(id).startsWith("personnel:lifecycle:interfaces:"));
    assert.deepEqual(entries.map(({ id }) => id).sort(), [...O6_PERMISSION_IDS].sort());
    for (const permission of entries) {
      assert.deepEqual(permission.eligibleRoles, ELIGIBLE_ROLES, permission.id);
    }
    for (const role of (roles.payload?.roles || []).filter(({ builtin }) => builtin)) {
      const automaticO6Rights = (role.permissions || [])
        .filter((permission) => O6_PERMISSION_IDS.includes(permission));
      const expectedPermissions = role.id === "developer" ? [...O6_PERMISSION_IDS].sort() : [];
      assert.deepEqual(automaticO6Rights.sort(), expectedPermissions, role.id);
    }
  });

  await t.test("Mutation, Dispatch, Commands und Feedback existieren nicht und aendern keinen Bestand", async () => {
    const before = protectedStateSnapshot();
    for (const route of [
      CATALOG_ROUTE,
      "/api/portal/v1/personnel-lifecycle/interfaces/dispatch",
      "/api/portal/v1/personnel-lifecycle/interfaces/commands",
      "/api/portal/v1/personnel-lifecycle/interfaces/feedback",
    ]) {
      const result = await request(route, {
        method: "POST",
        auth: sessions["O6-ASSET-ACCESS"],
        body: {
          domain: "access",
          action: "must-not-run",
          endpoint: "https://must-not-exist.example.invalid",
          secret: "must-not-persist",
        },
      });
      assert.equal(
        [404, 405].includes(result.response.status),
        true,
        `${route}: ${result.response.status} ${result.text}`,
      );
    }
    assert.deepEqual(protectedStateSnapshot(), before);
  });
});
