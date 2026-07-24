"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PRODUCT_READINESS_CHECKS,
  buildProductReadiness,
  createAcceptance,
  createProductReadinessEvidence,
  verifyAcceptance,
  verifyProductReadinessEvidence,
} = require("../lib/product-readiness");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const releaseVersion = "0.84.1-beta";
const instant = "2026-07-24T08:00:00.000Z";

function environmentFor(checkId) {
  const mobile = checkId.startsWith("mobile_") || checkId === "performance_mobile";
  return {
    platform: mobile ? "Android" : "Windows",
    browser: "Chrome",
    browserVersion: "140",
    userAgent: mobile ? "Grabenplaner mobile pilot" : "Grabenplaner desktop pilot",
    viewportWidth: mobile ? 412 : 1_920,
    viewportHeight: mobile ? 915 : 1_080,
    colorScheme: "light",
  };
}

function evidenceFor(check, index = 0, overrides = {}) {
  return createProductReadinessEvidence({
    checkId: check.id,
    outcome: "pass",
    environment: environmentFor(check.id),
    measurement: check.budgetMs ? { durationMs: check.budgetMs - 100 } : undefined,
    note: "Im Pilot nachvollziehbar geprüft.",
    ...overrides,
  }, {
    id: `readiness-evidence:${String(index).padStart(2, "0")}`,
    actor: "252",
    releaseVersion,
    now: new Date(Date.parse(instant) + index * 1_000),
  });
}

function technicalInput() {
  return {
    trustIndex: {
      cards: ["server", "database", "tls", "recovery"].map((id) => ({ id, state: "pass" })),
    },
    recovery: { applicationSmokeState: "passed" },
  };
}

test("v0.84: Pilotnachweise sind kanonisch belegt und nachträglich erkennbar verändert", () => {
  const value = evidenceFor(PRODUCT_READINESS_CHECKS[0]);
  assert.equal(verifyProductReadinessEvidence(value), true);
  assert.equal(verifyProductReadinessEvidence({ ...value, note: "nachträglich verändert" }), false);
});

test("v0.84: Desktop, Mobil und Performance werden serverseitig plausibilisiert", () => {
  assert.throws(
    () => evidenceFor(PRODUCT_READINESS_CHECKS.find(({ id }) => id === "mobile_portal_core"), 0, {
      environment: { ...environmentFor("mobile_portal_core"), viewportWidth: 1_920 },
    }),
    { code: "PRODUCT_READINESS_MOBILE_VIEWPORT_REQUIRED" },
  );
  assert.throws(
    () => evidenceFor(PRODUCT_READINESS_CHECKS.find(({ id }) => id === "desktop_planning_pdf"), 0, {
      environment: { ...environmentFor("desktop_planning_pdf"), viewportWidth: 412 },
    }),
    { code: "PRODUCT_READINESS_DESKTOP_VIEWPORT_REQUIRED" },
  );
  assert.throws(
    () => evidenceFor(PRODUCT_READINESS_CHECKS.find(({ id }) => id === "performance_desktop"), 0, {
      measurement: { durationMs: 3_001 },
    }),
    { code: "PRODUCT_READINESS_BUDGET_EXCEEDED" },
  );
});

test("v0.84: Produktreife benötigt alle sechs Gates und zwei aktuelle Abnahmen", () => {
  const evidence = PRODUCT_READINESS_CHECKS.map(evidenceFor);
  const technical = technicalInput();
  const ready = buildProductReadiness({
    evidence,
    releaseVersion,
    generatedAt: instant,
    ...technical,
  });
  assert.equal(ready.counts.total, 6);
  assert.equal(ready.counts.passed, 6);
  assert.equal(ready.state, "ready_for_acceptance");

  const technicalAcceptance = createAcceptance({
    discipline: "technical",
    decision: "approved",
    note: "Technischer Prüfstand freigegeben.",
  }, {
    id: "readiness-acceptance:technical",
    actor: "252",
    releaseVersion,
    basisSha256: ready.basisSha256,
    now: instant,
  });
  const operationalAcceptance = createAcceptance({
    discipline: "operational",
    decision: "approved",
    note: "Pilot fachlich freigegeben.",
  }, {
    id: "readiness-acceptance:operational",
    actor: "007",
    releaseVersion,
    basisSha256: ready.basisSha256,
    now: instant,
  });
  assert.equal(verifyAcceptance(technicalAcceptance), true);
  assert.equal(verifyAcceptance(operationalAcceptance), true);

  const accepted = buildProductReadiness({
    evidence,
    acceptances: [technicalAcceptance, operationalAcceptance],
    releaseVersion,
    generatedAt: instant,
    ...technical,
  });
  assert.equal(accepted.state, "accepted");

  const newerEvidence = evidenceFor(PRODUCT_READINESS_CHECKS[0], 99, {
    note: "Neuer Prüfstand nach einer Änderung.",
  });
  const changed = buildProductReadiness({
    evidence: [...evidence, newerEvidence],
    acceptances: [technicalAcceptance, operationalAcceptance],
    releaseVersion,
    generatedAt: instant,
    ...technical,
  });
  assert.notEqual(changed.basisSha256, ready.basisSha256);
  assert.equal(changed.state, "ready_for_acceptance");
  assert.equal(changed.acceptance.every(({ state }) => state === "pending"), true);

  const nextVersion = buildProductReadiness({
    evidence: [...evidence, newerEvidence],
    releaseVersion: "0.85.0-beta",
    generatedAt: instant,
    ...technical,
  });
  assert.equal(nextVersion.state, "in_review");
  assert.equal(nextVersion.counts.pending, 4);
});

test("v0.84: Fehlgeschlagene oder beschädigte Nachweise blockieren die Abnahme", () => {
  const evidence = PRODUCT_READINESS_CHECKS.map(evidenceFor);
  const failed = evidenceFor(PRODUCT_READINESS_CHECKS[0], 99, { outcome: "fail" });
  const report = buildProductReadiness({
    evidence: [...evidence, failed],
    releaseVersion,
    generatedAt: instant,
    ...technicalInput(),
  });
  assert.equal(report.state, "blocked");
  assert.equal(report.gates.find(({ id }) => id === "pilot").state, "fail");

  assert.throws(
    () => buildProductReadiness({
      evidence: [{ ...evidence[0], outcome: "fail" }],
      releaseVersion,
      ...technicalInput(),
    }),
    { code: "PRODUCT_READINESS_EVIDENCE_INTEGRITY_FAILED" },
  );
});

test("v0.84: Datenbank, API und Startprüfung erzwingen unveränderliche Nachweise", () => {
  const server = read("server.js");
  for (const marker of [
    "CREATE TABLE IF NOT EXISTS product_readiness_evidence",
    "CREATE TABLE IF NOT EXISTS product_readiness_acceptances",
    "trg_product_readiness_evidence_immutable_update",
    "trg_product_readiness_evidence_immutable_delete",
    "trg_product_readiness_acceptances_immutable_update",
    "trg_product_readiness_acceptances_immutable_delete",
    "productReadinessEvidenceRows();",
    "productReadinessAcceptanceRows();",
    'app.get("/api/portal/v1/product-readiness"',
    'app.post("/api/portal/v1/product-readiness/evidence"',
    'app.post("/api/portal/v1/product-readiness/acceptances"',
    '"system:readiness:review"',
    '"PRODUCT_READINESS_BASIS_STALE"',
    "throw productReadinessRequestError(error);",
  ]) assert.match(server, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("v0.84: System-Center stellt Pilot, Performance und doppelte Abnahme responsiv bereit", () => {
  const script = read("public/app.js");
  const styles = read("public/styles.css");
  const readinessModule = read("lib/product-readiness.js");
  assert.match(script, /function renderProductReadiness\(payload\)/);
  assert.match(script, /function saveProductReadinessEvidence\(checkId, outcome, measurement = null\)/);
  assert.match(script, /function saveProductReadinessAcceptance\(discipline\)/);
  assert.match(script, /\/api\/portal\/v1\/product-readiness\/evidence/);
  assert.match(script, /\/api\/portal\/v1\/product-readiness\/acceptances/);
  assert.match(script, /performance\.getEntriesByType\("navigation"\)/);
  assert.match(script, /Abnahme dokumentieren/);
  assert.match(readinessModule, /Technische Abnahme/);
  assert.match(readinessModule, /Fachliche Abnahme/);
  assert.match(styles, /\.product-readiness-gates/);
  assert.match(styles, /\.product-readiness-acceptance/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.product-readiness-actions/);
  assert.match(styles, /rights-dashboard\[data-dashboard-theme="dark"\][\s\S]*product-readiness/);
});

test("v0.84: API protokolliert berechtigte Nachweise, weist unplausible Eingaben ab und sperrt Änderungen", async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v084-readiness-"));
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
  let httpServer;
  try {
    const locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
    const employeeNumber = "v084-admin";
    db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours,
         target_workdays_per_week, fixed_workdays, home_location_id, active)
      VALUES (?, 'Ada Abnahme', 'Ada', '#26785f', 38.5, 5, '', ?, 1)
    `).run(employeeNumber, locationId);
    db.prepare(`
      INSERT INTO portal_users
        (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
      VALUES (?, 'test-only', 'admin', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(employeeNumber);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(24).toString("hex");
    db.prepare(`
      INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
      VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
    `).run(
      crypto.randomUUID(),
      employeeNumber,
      crypto.createHash("sha256").update(rawToken).digest("hex"),
    );
    await new Promise((resolve, reject) => {
      httpServer = app.listen(0, "127.0.0.1", resolve);
      httpServer.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    const send = async (body) => {
      const response = await fetch(`${baseUrl}/api/portal/v1/product-readiness/evidence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(body),
      });
      return { response, payload: await response.json() };
    };

    const recorded = await send({
      checkId: "desktop_planning_pdf",
      outcome: "pass",
      environment: {
        platform: "Windows",
        browser: "Chrome",
        browserVersion: "140",
        userAgent: "v0.84 API pilot",
        viewportWidth: 1_920,
        viewportHeight: 1_080,
        colorScheme: "light",
      },
      note: "API-Integration geprüft.",
      observedAt: new Date().toISOString(),
    });
    assert.equal(recorded.response.status, 201, JSON.stringify(recorded.payload));
    assert.equal(recorded.payload.releaseVersion, releaseVersion);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM product_readiness_evidence").get().count, 1);
    assert.throws(
      () => db.prepare("UPDATE product_readiness_evidence SET outcome = 'fail'").run(),
      /immutable/i,
    );

    const rejected = await send({
      checkId: "mobile_portal_core",
      outcome: "pass",
      environment: {
        platform: "Windows",
        browser: "Chrome",
        viewportWidth: 1_920,
        viewportHeight: 1_080,
        colorScheme: "light",
      },
      observedAt: new Date().toISOString(),
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.code, "PRODUCT_READINESS_MOBILE_VIEWPORT_REQUIRED");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM product_readiness_evidence").get().count, 1);
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    try { db.close(); } catch {}
    releaseInstanceLockForTests();
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
