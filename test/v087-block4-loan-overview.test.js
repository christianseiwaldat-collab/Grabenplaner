"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-block4-loan-overview-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const HOME_LOCATION = "91";
const OTHER_LOCATION = "92";
const HOME_VIEWER = "v087-block4-viewer";
const HOME_BORROWER = "v087-block4-borrower";
const OTHER_VIEWER = "v087-block4-other-viewer";
const OTHER_BORROWER = "v087-block4-other-borrower";
const OPEN_ARTICLE_NUMBERS = Array.from({ length: 11 }, (_, index) =>
  String(981001 + index));
const RETURNED_ARTICLE_NUMBER = "981090";
const OTHER_ARTICLE_NUMBER = "982001";
const EXPECTED_OVERVIEW_KEYS = [
  "articleNumber",
  "description",
  "dueDate",
  "serialNumber",
];

let baseUrl;
let httpServer;
let homeViewerSession;
let otherViewerSession;

function ensureLocation(id, name) {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, ?, 0, '{}', 1)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1
  `).run(id, name);
  db.prepare(`
    INSERT INTO loan_location_settings
      (location_id, enabled, article_lookup_enabled, article_lookup_provider,
       created_by, updated_by, updated_at)
    VALUES (?, 1, 0, 'none', 'test', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(location_id) DO UPDATE SET
      enabled = 1,
      article_lookup_enabled = 0,
      article_lookup_provider = 'none',
      updated_by = 'test',
      updated_at = CURRENT_TIMESTAMP
  `).run(id);
}

function ensureEmployee(employeeNumber, name, locationId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, name, name.split(" ")[0], locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = 'employee',
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber);
}

function createSession(employeeNumber) {
  const id = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    id,
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function insertCentralArticle(articleNumber, description) {
  const productId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const digest = (label) => crypto.createHash("sha256")
    .update(`${label}\0${articleNumber}\0${productId}`)
    .digest("hex");
  const snapshotId = digest("snapshot");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO sales_article_import_snapshots (
        id, idempotency_key, source_system, source_profile_version,
        source_schema_sha256, source_file_sha256, content_sha256,
        snapshot_at, article_count, identifier_count, price_count,
        imported_by, imported_at
      ) VALUES (?, ?, 'manual.loan', 'test-v1', ?, ?, ?, ?, 1, 0, 0, 'test', ?)
    `).run(
      snapshotId,
      digest("idempotency"),
      digest("schema"),
      digest("file"),
      digest("content"),
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key,
        current_revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, 'manual.loan', ?, 1, 'test', ?, 'test', ?)
    `).run(productId, articleNumber, articleNumber, timestamp, timestamp);
    db.prepare(`
      INSERT INTO sales_article_revisions (
        product_id, revision, article_number, description, active,
        source_snapshot_id, created_by, created_at
      ) VALUES (?, 1, ?, ?, 1, ?, 'test', ?)
    `).run(productId, articleNumber, description, snapshotId, timestamp);
    db.prepare(`
      INSERT INTO sales_article_source_links (
        product_id, source_system, source_article_key, source_snapshot_id,
        match_method, match_confidence, linked_by, linked_at
      ) VALUES (?, 'manual.loan', ?, ?, 'source_import', 'authoritative', 'test', ?)
    `).run(productId, articleNumber, snapshotId, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { productId, revision: 1 };
}

function insertLoan({
  id,
  locationId,
  borrowerEmployeeNumber,
  articleNumber,
  description,
  serialNumber,
  dueDate,
  status = "issued",
  notes = "",
  itemNote = "",
}) {
  const article = insertCentralArticle(articleNumber, description);
  const returnedAt = status === "returned" ? "2027-02-02T12:00:00.000Z" : null;
  db.prepare(`
    INSERT INTO loans
      (id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, returned_at, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2027-02-01T08:00:00.000Z', ?, 1,
            '2027-02-01T08:00:00.000Z', '2027-02-01T08:00:00.000Z')
  `).run(
    id,
    locationId,
    borrowerEmployeeNumber,
    borrowerEmployeeNumber,
    dueDate,
    status,
    notes,
    returnedAt,
  );
  db.prepare(`
    INSERT INTO loan_items
      (id, loan_id, position, product_id, product_revision_snapshot,
       article_number_snapshot, description_snapshot, serial_number,
       quantity, condition_out, condition_return, item_note)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, 'good', ?, ?)
  `).run(
    crypto.randomUUID(),
    id,
    article.productId,
    article.revision,
    articleNumber,
    description,
    serialNumber,
    status === "returned" ? "good" : "",
    itemNote,
  );
  db.prepare(`
    INSERT INTO loan_events (loan_id, actor_employee_number, event_type, revision, payload_json)
    VALUES (?, ?, 'issued', 1, ?)
  `).run(
    id,
    borrowerEmployeeNumber,
    JSON.stringify({
      confidentialEventValue: `Ereignis ${articleNumber}`,
      borrowerEmployeeNumber,
    }),
  );
}

async function request(route, { session = homeViewerSession } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: {
      Accept: "application/json",
      Cookie: session.cookie,
    },
  });
  const payload = await response.json();
  return { response, payload };
}

function assertMinimizedOverviewItem(item) {
  assert.deepEqual(
    Object.keys(item).sort(),
    [...EXPECTED_OVERVIEW_KEYS].sort(),
    `Übersichtszeile enthält unerwartete Felder: ${JSON.stringify(item)}`,
  );
  assert.equal(typeof item.articleNumber, "string");
  assert.equal(typeof item.description, "string");
  assert.equal(typeof item.serialNumber, "string");
  assert.ok(item.dueDate === null || typeof item.dueDate === "string");
}

test.before(() => {
  ensureLocation(HOME_LOCATION, "Block 4 Hauptfiliale");
  ensureLocation(OTHER_LOCATION, "Block 4 Fremdfiliale");
  ensureEmployee(HOME_VIEWER, "Vera Übersicht", HOME_LOCATION);
  ensureEmployee(HOME_BORROWER, "Berta Vertraulich", HOME_LOCATION);
  ensureEmployee(OTHER_VIEWER, "Olivia Übersicht", OTHER_LOCATION);
  ensureEmployee(OTHER_BORROWER, "Frieda Fremdfiliale", OTHER_LOCATION);

  OPEN_ARTICLE_NUMBERS.forEach((articleNumber, index) => {
    insertLoan({
      id: `v087-block4-open-${index + 1}`,
      locationId: HOME_LOCATION,
      borrowerEmployeeNumber: HOME_BORROWER,
      articleNumber,
      description: index === 0
        ? "Sony Alpha 7 IV Kameragehäuse"
        : `Übersichtsgerät ${index + 1} Modell B4`,
      serialNumber: index === 0 ? "ALPHA7-IV-SECRET-SERIAL" : `B4-SERIAL-${index + 1}`,
      dueDate: `2027-03-${String(index + 1).padStart(2, "0")}`,
      notes: `Vertrauliche Leihnotiz ${index + 1}`,
      itemNote: `Interne Artikelnotiz ${index + 1}`,
    });
  });
  insertLoan({
    id: "v087-block4-returned",
    locationId: HOME_LOCATION,
    borrowerEmployeeNumber: HOME_BORROWER,
    articleNumber: RETURNED_ARTICLE_NUMBER,
    description: "Bereits retournierte Kamera",
    serialNumber: "RETURNED-SERIAL",
    dueDate: "2027-02-02",
    status: "returned",
    notes: "Darf in der offenen Übersicht nicht erscheinen",
    itemNote: "Vertrauliche Retourennotiz",
  });
  insertLoan({
    id: "v087-block4-other-location",
    locationId: OTHER_LOCATION,
    borrowerEmployeeNumber: OTHER_BORROWER,
    articleNumber: OTHER_ARTICLE_NUMBER,
    description: "Fremdfilialgerät Modell Isolation",
    serialNumber: "OTHER-LOCATION-SERIAL",
    dueDate: "2027-04-01",
    notes: "Andere Filiale",
    itemNote: "Andere Filiale intern",
  });

  homeViewerSession = createSession(HOME_VIEWER);
  otherViewerSession = createSession(OTHER_VIEWER);
  return new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 4: normale Mitarbeitende erhalten nur das minimierte Leihübersichtsrecht", () => {
  const employeeRole = db.prepare("SELECT permissions FROM portal_roles WHERE id = 'employee'").get();
  assert.ok(employeeRole, "Mitarbeiterrolle fehlt");
  const permissions = new Set(JSON.parse(employeeRole.permissions));
  assert.equal(permissions.has("loans:overview:read"), true);
  assert.equal(permissions.has("loans:location:read"), false);
  assert.equal(permissions.has("loans:location:manage"), false);
  assert.equal(permissions.has("loans:documents:read"), false);
});

test("Block 4: offene Standortübersicht ist minimiert, filialgebunden und enthält keine geschlossenen Leihen", async () => {
  const result = await request("/api/portal/v1/loans/open-overview");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.location.id, HOME_LOCATION);
  assert.equal(result.payload.total, OPEN_ARTICLE_NUMBERS.length);
  assert.equal(result.payload.searchThreshold, 10);
  assert.equal(result.payload.searchEnabled, true);
  assert.equal(result.payload.items.length, OPEN_ARTICLE_NUMBERS.length);

  for (const item of result.payload.items) assertMinimizedOverviewItem(item);
  assert.deepEqual(
    new Set(result.payload.items.map((item) => item.articleNumber)),
    new Set(OPEN_ARTICLE_NUMBERS),
  );
  assert.equal(
    result.payload.items.some((item) => item.articleNumber === RETURNED_ARTICLE_NUMBER),
    false,
  );
  assert.equal(
    result.payload.items.some((item) => item.articleNumber === OTHER_ARTICLE_NUMBER),
    false,
  );

  const serialized = JSON.stringify(result.payload);
  for (const forbidden of [
    HOME_BORROWER,
    "Berta Vertraulich",
    "Vertrauliche Leihnotiz",
    "Interne Artikelnotiz",
    "confidentialEventValue",
    "borrower",
    "createdBy",
    "notes",
    "note",
    "photos",
    "documents",
    "events",
    "revision",
    "pendingReturnConfirmation",
    "returnWitness",
    "downloadUrl",
    "contentUrl",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `Vertraulicher Inhalt in Leihübersicht: ${forbidden}`,
    );
  }
});

test("Block 4: Standortmanipulation wird abgewiesen und eine kurze Fremdfilialliste aktiviert keine Suche", async () => {
  const tampered = await request(
    `/api/portal/v1/loans/open-overview?locationId=${encodeURIComponent(OTHER_LOCATION)}`,
  );
  assert.equal(tampered.response.status, 403, JSON.stringify(tampered.payload));

  const other = await request("/api/portal/v1/loans/open-overview", {
    session: otherViewerSession,
  });
  assert.equal(other.response.status, 200, JSON.stringify(other.payload));
  assert.equal(other.payload.location.id, OTHER_LOCATION);
  assert.equal(other.payload.total, 1);
  assert.equal(other.payload.searchThreshold, 10);
  assert.equal(other.payload.searchEnabled, false);
  assert.equal(other.payload.items.length, 1);
  assertMinimizedOverviewItem(other.payload.items[0]);
  assert.equal(other.payload.items[0].articleNumber, OTHER_ARTICLE_NUMBER);
  assert.equal(
    other.payload.items.some((item) => OPEN_ARTICLE_NUMBERS.includes(item.articleNumber)),
    false,
  );
});

test("Block 4: offene Leihen stehen im Portal vor Ausgabe und Details, Suche erscheint erst ab längerer Liste", () => {
  const projectRoot = path.join(__dirname, "..");
  const portalHtml = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const portalSource = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  const overviewIndex = portalHtml.indexOf('id="loanOpenOverview"');
  const issueIndex = portalHtml.indexOf('id="loanIssueForm"');
  const detailIndex = portalHtml.indexOf('id="loanPersonalOverview"');
  assert.ok(overviewIndex >= 0, "Direkt sichtbare Tabelle der offenen Leihen fehlt");
  assert.ok(issueIndex >= 0, "Bestehendes Ausgabeformular fehlt");
  assert.ok(detailIndex >= 0, "Bestehende persönliche beziehungsweise leitende Detailansicht fehlt");
  assert.ok(overviewIndex < issueIndex, "Offene Leihen müssen vor der Ausgabe stehen");
  assert.ok(overviewIndex < detailIndex, "Minimierte Übersicht muss vor den Leihdetails stehen");

  assert.match(
    portalHtml,
    /id="loanOverviewSearchField"[^>]*class="[^"]*\bhidden\b[^"]*"/,
  );
  assert.match(portalHtml, /id="loanOverviewSearch"/);
  assert.match(portalHtml, /id="loanOverviewTableBody"/);
  assert.match(portalSource, /const LOAN_OVERVIEW_SEARCH_THRESHOLD = 10;/);
  assert.match(portalSource, /\/api\/portal\/v1\/loans\/open-overview/);
  assert.match(
    portalSource,
    /searchEnabled[\s\S]{0,240}loanOverviewSearchField[\s\S]{0,160}classList\.toggle\("hidden"/,
  );
});

test("v0.87 Block 8: Direktübersicht wird nach jeder bestandsändernden Leihaktion aktualisiert", () => {
  const portalSource = fs.readFileSync(
    path.join(__dirname, "..", "public", "portal.js"),
    "utf8",
  );
  const refreshCalls = portalSource.match(
    /await Promise\.all\(\[loadLoans\(\), loadLoanOverview\(\)\]\);/g,
  ) || [];
  assert.equal(
    refreshCalls.length,
    3,
    "Ausgabe, Filialleitungsaktionen und bestätigte Rückgabe müssen Liste und Direktübersicht gemeinsam aktualisieren",
  );
});
