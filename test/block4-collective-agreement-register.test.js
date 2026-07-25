"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-block4-kv-register-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, releaseInstanceLockForTests } = subject;

const HR = "block4-hr";
const MANAGER = "block4-manager";
const EMPLOYEE = "block4-employee";
let httpServer;
let baseUrl;
let hrSession;
let managerSession;
let employeeSession;
let localLocationId;
let foreignLocationId;
let localDepartmentId;
let agreement;
let localBusinessUnit;
let foreignBusinessUnit;

function createSession(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", body, session = hrSession } = {}) {
  const headers = { Accept: "application/json", Cookie: session.cookie };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function insertEmployee(personnelNumber, name, locationId, costCenterId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], locationId, costCenterId || null);
}

function versionPayload(overrides = {}) {
  return {
    versionLabel: "2026",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    externalPublishedOn: "2025-12-15",
    sourceTitle: "Offizielle Testquelle für den Kollektivvertrag",
    sourceUrl: "https://example.invalid/kv-2026.pdf",
    sourceRetrievedOn: "2026-07-25",
    sourceSha256: "a".repeat(64),
    sourceNote: "Fundstelle für den Test; kein übernommener Volltext.",
    contractingParties: ["Arbeitgeberseite", "Arbeitnehmerseite"],
    territorialScope: "Österreich",
    functionalScope: "Testhandel",
    personalScope: "Noch fachlich zu bestätigen",
    employeeGroups: ["Angestellte", "Lehrlinge"],
    workTimeParametersNote: "Nur abgeleitete Parameter mit Fundstelle.",
    classificationNote: "Einstufung separat prüfen.",
    apprenticeRelevance: "yes",
    apprenticeNote: "Jugendschutz bleibt als eigene gesetzliche Ebene erhalten.",
    ...overrides,
  };
}

test.before(async () => {
  const localLocation = db.prepare(`
    SELECT id, cost_center_id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get();
  localLocationId = String(localLocation.id);
  foreignLocationId = String(
    Array.from({ length: 19 }, (_, index) => 60 + index)
      .find((id) => !db.prepare("SELECT 1 FROM locations WHERE id = ?").get(String(id))),
  );
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, min_staff, day_settings_json, active)
    VALUES (?, 'Block 4 Fremdfiliale', ?, 1, '', 1)
  `).run(foreignLocationId, localLocation.cost_center_id || null);
  localDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active)
    VALUES (?, 'Block 4 Zusatzbereich', 0, 1)
    RETURNING id
  `).get(localLocationId).id);
  insertEmployee(HR, "Helena Personal", localLocationId, localLocation.cost_center_id);
  insertEmployee(MANAGER, "Mara Filiale", localLocationId, localLocation.cost_center_id);
  insertEmployee(EMPLOYEE, "Emil Team", localLocationId, localLocation.cost_center_id);
  hrSession = createSession(HR, "hr");
  managerSession = createSession(MANAGER, "manager");
  employeeSession = createSession(EMPLOYEE, "employee");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'block4-test')
  `).run(MANAGER, localLocationId);
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

test("Block 4/7: KV-Register speichert externe Quellenstände unveränderlich und versioniert", async () => {
  const created = await request("/api/collective-agreements", {
    method: "POST",
    body: {
      code: "HANDEL-TEST",
      title: "Test-Kollektivvertrag Handel",
      shortTitle: "Handels-KV Test",
      jurisdiction: "AT",
      note: "Keine Bestätigung der betrieblichen Anwendbarkeit.",
      version: versionPayload(),
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  agreement = created.payload.agreement;
  assert.equal(agreement.reviewState, "review_pending");
  assert.equal(agreement.versions.length, 1);
  assert.match(agreement.versions[0].contentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(agreement.versions[0].contractingParties, ["Arbeitgeberseite", "Arbeitnehmerseite"]);

  const extended = await request(`/api/collective-agreements/${agreement.id}/versions`, {
    method: "POST",
    body: versionPayload({
      versionLabel: "2027",
      validFrom: "2027-01-01",
      validTo: "2027-12-31",
      sourceUrl: "https://example.invalid/kv-2027.pdf",
      sourceSha256: "b".repeat(64),
    }),
  });
  assert.equal(extended.response.status, 201, JSON.stringify(extended.payload));
  agreement = extended.payload.agreement;
  assert.equal(agreement.versions.length, 2);
  assert.equal(agreement.versions.find((version) => version.id === agreement.currentVersionId).versionLabel, "2027");

  assert.throws(
    () => db.prepare("UPDATE collective_agreement_versions SET version_label = 'manipuliert' WHERE id = ?")
      .run(agreement.currentVersionId),
    /immutable/i,
  );
});

test("Block 4/7: Betriebsteile und Zuordnungen bleiben organisatorisch explizit und ungeprüft", async () => {
  const local = await request("/api/collective-agreements/business-units", {
    method: "POST",
    body: {
      code: "HANDEL-LOCAL",
      name: "Handel lokale Filiale",
      legalEntityName: "Test Rechtsträger GmbH",
      description: "Lokaler Testbetriebsteil",
      scopes: [{ scopeType: "location", scopeKey: localLocationId }],
    },
  });
  assert.equal(local.response.status, 201, JSON.stringify(local.payload));
  localBusinessUnit = local.payload.businessUnit;
  assert.equal(localBusinessUnit.scopes[0].scopeKey, localLocationId);
  const extendedLocal = await request(`/api/collective-agreements/business-units/${localBusinessUnit.id}/scopes`, {
    method: "POST",
    body: { scopes: [{ scopeType: "department", scopeKey: String(localDepartmentId) }] },
  });
  assert.equal(extendedLocal.response.status, 201, JSON.stringify(extendedLocal.payload));
  localBusinessUnit = extendedLocal.payload.businessUnit;
  assert.deepEqual(
    localBusinessUnit.scopes.map((scope) => scope.scopeType).sort(),
    ["department", "location"],
  );

  const foreign = await request("/api/collective-agreements/business-units", {
    method: "POST",
    body: {
      code: "HANDEL-FREMD",
      name: "Handel fremde Filiale",
      legalEntityName: "Test Rechtsträger GmbH",
      scopes: [{ scopeType: "location", scopeKey: foreignLocationId }],
    },
  });
  assert.equal(foreign.response.status, 201, JSON.stringify(foreign.payload));
  foreignBusinessUnit = foreign.payload.businessUnit;

  const version2026 = agreement.versions.find((version) => version.versionLabel === "2026");
  for (const [businessUnitId, rationale] of [
    [localBusinessUnit.id, "Lokaler Zuordnungsvorschlag für die fachliche Prüfung."],
    [foreignBusinessUnit.id, "Fremder Zuordnungsvorschlag für die fachliche Prüfung."],
  ]) {
    const prepared = await request("/api/collective-agreements/assignments", {
      method: "POST",
      body: {
        agreementVersionId: version2026.id,
        businessUnitId,
        validFrom: "2026-01-01",
        validTo: "2026-12-31",
        rationale,
        referenceNote: "Noch keine Vier-Augen-Freigabe.",
        reviewState: "review_pending",
      },
    });
    assert.equal(prepared.response.status, 201, JSON.stringify(prepared.payload));
    assert.equal(prepared.payload.assignment.reviewState, "review_pending");
  }

  const prematureApproval = await request("/api/collective-agreements/assignments", {
    method: "POST",
    body: {
      agreementVersionId: version2026.id,
      businessUnitId: localBusinessUnit.id,
      validFrom: "2026-02-01",
      validTo: "2026-11-30",
      rationale: "Darf in Block 4 trotzdem nicht freigegeben werden.",
      reviewState: "approved",
    },
  });
  assert.equal(prematureApproval.response.status, 400, JSON.stringify(prematureApproval.payload));
  assert.match(prematureApproval.payload.error, /Freigabeblock/i);
});

test("Block 4/7: Standard-Leserecht ist gescopt; Pflege und Zuordnung bleiben PL vorbehalten", async () => {
  const scoped = await request("/api/collective-agreements/registry", { session: managerSession });
  assert.equal(scoped.response.status, 200, JSON.stringify(scoped.payload));
  assert.match(scoped.payload.legalNotice, /erzeugt keinen Kollektivvertrag/i);
  assert.equal(scoped.payload.capabilities.canManage, false);
  assert.equal(scoped.payload.capabilities.canPrepareAssignments, false);
  assert.equal(scoped.payload.capabilities.canApprove, false);
  assert.deepEqual(scoped.payload.businessUnits.map((unit) => unit.id), [localBusinessUnit.id]);
  assert.deepEqual(scoped.payload.assignments.map((assignment) => assignment.businessUnitId), [localBusinessUnit.id]);
  assert.equal(scoped.payload.agreements.length, 1);

  const managerWrite = await request("/api/collective-agreements/business-units", {
    method: "POST",
    session: managerSession,
    body: { code: "NICHT-ERLAUBT", name: "Nicht erlaubt", legalEntityName: "Test GmbH" },
  });
  assert.equal(managerWrite.response.status, 403, JSON.stringify(managerWrite.payload));

  const denied = await request("/api/collective-agreements/registry", { session: employeeSession });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));

  const global = await request("/api/collective-agreements/registry");
  assert.equal(global.response.status, 200, JSON.stringify(global.payload));
  assert.equal(global.payload.capabilities.canManage, true);
  assert.equal(global.payload.capabilities.canPrepareAssignments, true);
  assert.equal(global.payload.businessUnits.length, 2);
  assert.equal(global.payload.assignments.length, 2);
  assert.equal(global.payload.summary.approvedAssignments, 0);
});

test("Block 4/7: Personalverwaltung verdrahtet Register, Betriebsteile und Vorschlagsdialoge", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  for (const marker of [
    'data-personnel-administration-route="collectiveAgreements"',
    'data-personnel-administration-tab="collectiveAgreements"',
    'id="collectiveAgreementsSection"',
    'id="collectiveAgreementModal"',
    'id="collectiveAgreementBusinessUnitModal"',
    'id="collectiveAgreementAssignmentModal"',
    "Register, keine Rechtsfreigabe",
    "Jeder Vorschlag bleibt bis Block 6",
  ]) assert.ok(html.includes(marker), marker);
  for (const marker of [
    "function canReadCollectiveAgreements",
    "function loadCollectiveAgreementRegistry",
    "function renderCollectiveAgreementRegistry",
    "function saveCollectiveAgreement",
    "function saveCollectiveAgreementBusinessUnit",
    "function saveCollectiveAgreementAssignment",
    'api("/api/collective-agreements/registry")',
  ]) assert.ok(script.includes(marker), marker);
  for (const marker of [
    ".collective-agreement-workspace",
    ".collective-agreement-boundary",
    ".collective-agreement-business-unit",
    ".collective-agreement-review-state",
  ]) assert.ok(styles.includes(marker), marker);
  assert.match(styles, /@media \(max-width:1000px\)[\s\S]*collective-agreement-workspace/);
  assert.match(styles, /@media \(max-width:700px\)[\s\S]*collective-agreements-actions/);
});
