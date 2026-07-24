"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

const {
  hasValidGtinChecksum,
  normalizeArticleIdentifier,
  normalizeArticleNumber,
  parseShopwareProductBarcode,
  parseShopwareSuggestHtml,
  shopwareSuggestUrl,
} = require("../lib/article-catalog");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v085-loans-"));
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
  installationFeaturesForApiPath,
  releaseInstanceLockForTests,
  validateUsbFeatures,
} = require("../server");

const ADMIN = "v085-admin";
const MANAGER = "v085-manager";
const EMPLOYEE = "v085-employee";
const WITNESS = "v085-witness";
const OTHER = "v085-other";
let baseUrl;
let httpServer;
let locationId;
let adminSession;
let managerSession;
let employeeSession;
let witnessSession;
let otherSession;

function ensureEmployee(employeeNumber, name, role) {
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
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
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
    id,
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", session = employeeSession, body } = {}) {
  const headers = { Accept: "application/json" };
  const multipart = body instanceof FormData;
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function requestBinary(route, { session = employeeSession } = {}) {
  const headers = {};
  if (session) headers.Cookie = session.cookie;
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return { response, buffer: Buffer.from(await response.arrayBuffer()) };
}

test.before(() => {
  locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  ensureEmployee(ADMIN, "Ada Administration", "admin");
  ensureEmployee(MANAGER, "Mara Filialleitung", "manager");
  ensureEmployee(EMPLOYEE, "Erika Beispiel", "employee");
  ensureEmployee(WITNESS, "Walter Beispiel", "employee");
  ensureEmployee(OTHER, "Olivia Ohne Bezug", "employee");
  adminSession = createSession(ADMIN);
  managerSession = createSession(MANAGER);
  employeeSession = createSession(EMPLOYEE);
  witnessSession = createSession(WITNESS);
  otherSession = createSession(OTHER);
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

test("v0.85 Artikelnummern sind exakt sechsstellig und bleiben als Text erhalten", () => {
  assert.equal(normalizeArticleNumber("089319"), "089319");
  assert.throws(() => normalizeArticleNumber("89319"), { code: "ARTICLE_NUMBER_INVALID" });
  assert.throws(() => normalizeArticleNumber("08A319"), { code: "ARTICLE_NUMBER_INVALID" });
  assert.throws(
    () => db.prepare("INSERT INTO articles (article_number, description) VALUES ('12345', 'Ungültig')").run(),
    /CHECK constraint failed/,
  );
});

test("v0.85 Shopware-Suche gleicht die sechsstellige Nummer exakt mit der Shopnummer ab", () => {
  const html = `
    <ul>
      <li class="search-suggest-product js-result">
        <a href="https://shop.example/Panasonic-Test/0000000104405" title="Panasonic Lumix DC-TZ99 Schwarz">
          <img alt="0000000104405">
          <div class="col search-suggest-product-name">Panasonic Lumix DC-TZ99 Schwarz</div>
        </a>
      </li>
    </ul>`;
  assert.deepEqual(parseShopwareSuggestHtml(html, "104405", "https://shop.example"), {
    articleNumber: "104405",
    description: "Panasonic Lumix DC-TZ99 Schwarz",
    sourceProvider: "shopware_storefront",
    sourceProductNumber: "0000000104405",
    sourceUrl: "https://shop.example/Panasonic-Test/0000000104405",
  });
  assert.equal(parseShopwareSuggestHtml(html, "104404", "https://shop.example"), null);
  assert.equal(shopwareSuggestUrl("https://shop.example", "104405").href,
    "https://shop.example/suggest?search=104405");
});

test("v0.85 EAN und GTIN werden per Prüfziffer erkannt und am Shopartikel bestätigt", () => {
  assert.deepEqual(normalizeArticleIdentifier("5025232978748"), {
    type: "ean13",
    value: "5025232978748",
  });
  assert.equal(hasValidGtinChecksum("5025232978748"), true);
  assert.equal(hasValidGtinChecksum("5025232978749"), false);
  assert.throws(
    () => normalizeArticleIdentifier("5025232978749"),
    { code: "ARTICLE_IDENTIFIER_CHECKSUM_INVALID" },
  );
  assert.deepEqual(
    parseShopwareProductBarcode('<meta itemprop="gtin13" content="5025232978748">'),
    { type: "ean13", value: "5025232978748" },
  );
  const suggestion = `
    <li class="search-suggest-product">
      <a href="https://shop.example/Panasonic-Test/0000000104405" title="Panasonic Lumix DC-TZ99 Schwarz"></a>
    </li>`;
  assert.deepEqual(parseShopwareSuggestHtml(suggestion, "5025232978748", "https://shop.example"), {
    articleNumber: "104405",
    description: "Panasonic Lumix DC-TZ99 Schwarz",
    sourceProvider: "shopware_storefront",
    sourceProductNumber: "0000000104405",
    sourceUrl: "https://shop.example/Panasonic-Test/0000000104405",
  });
  assert.equal(shopwareSuggestUrl("https://shop.example", "5025232978748").href,
    "https://shop.example/suggest?search=5025232978748");
});

test("v0.85 Datenmodell trennt zentralen Artikelstamm, Standortfreigabe und Leihhistorie", () => {
  for (const table of [
    "articles",
    "article_identifiers",
    "loan_location_settings",
    "loans",
    "loan_items",
    "loan_return_confirmations",
    "loan_documents",
    "loan_photos",
    "loan_document_deliveries",
    "loan_events",
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.85-loan-module-foundation'").get());
  db.prepare("INSERT INTO articles (article_number, description) VALUES ('654321', 'Testartikel')").run();
  const loanId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO loans (id, location_id, borrower_employee_number, created_by_employee_number)
    VALUES (?, ?, ?, ?)
  `).run(loanId, locationId, EMPLOYEE, ADMIN);
  db.prepare(`
    INSERT INTO loan_events (loan_id, actor_employee_number, event_type, revision)
    VALUES (?, ?, 'created', 1)
  `).run(loanId, ADMIN);
  assert.throws(
    () => db.prepare("UPDATE loan_events SET event_type = 'changed' WHERE loan_id = ?").run(loanId),
    /loan events are immutable/,
  );
  db.prepare(`
    INSERT INTO loan_documents
      (id, loan_id, document_type, loan_revision, storage_key, filename, byte_size, sha256)
    VALUES ('test-document', ?, 'issue', 1, 'aa/test-document.enc', 'Test.pdf', 10, ?)
  `).run(loanId, "a".repeat(64));
  assert.throws(
    () => db.prepare("UPDATE loan_documents SET filename = 'Geaendert.pdf' WHERE id = 'test-document'").run(),
    /loan documents are immutable/,
  );
  db.prepare(`
    INSERT INTO loan_photos
      (id, loan_id, phase, position, storage_key, filename, byte_size, sha256,
       pixel_width, pixel_height)
    VALUES ('test-photo', ?, 'issue', 1, 'aa/test-photo.enc', 'Foto.jpg', 10, ?, 10, 10)
  `).run(loanId, "b".repeat(64));
  assert.throws(
    () => db.prepare("UPDATE loan_photos SET filename = 'Geaendert.jpg' WHERE id = 'test-photo'").run(),
    /loan photos are immutable/,
  );
  db.prepare(`
    INSERT INTO loan_document_deliveries
      (id, document_id, channel, recipient_employee_number, status)
    VALUES ('test-delivery', 'test-document', 'internal', ?, 'sent')
  `).run(ADMIN);
  assert.throws(
    () => db.prepare("UPDATE loan_document_deliveries SET status = 'failed' WHERE id = 'test-delivery'").run(),
    /loan document deliveries are immutable/,
  );
});

test("v0.85 Funktionsprofil schaltet Leihe nur gemeinsam mit dem Mitarbeiterportal frei", () => {
  assert.deepEqual(
    new Set(installationFeaturesForApiPath("/portal/v1/loans/articles/resolve")),
    new Set(["loans", "employeePortal"]),
  );
  assert.deepEqual(
    new Set(validateUsbFeatures({ enabledFeatures: ["loans"] })),
    new Set(["schedule", "loans", "employeePortal"]),
  );
  const roles = new Map(db.prepare("SELECT id, permissions FROM portal_roles").all()
    .map((role) => [role.id, new Set(JSON.parse(role.permissions))]));
  assert.equal(roles.get("employee").has("loans:self:create"), true);
  assert.equal(roles.get("department_manager").has("loans:location:manage"), false);
  assert.equal(roles.get("manager").has("loans:location:manage"), true);
  assert.equal(roles.get("hr").has("loans:settings"), true);
});

test("v0.85 PL-plus konfiguriert den Standort, Mitarbeitende dürfen die Einstellungen nicht lesen", async () => {
  const denied = await request("/api/portal/v1/loans/settings");
  assert.equal(denied.response.status, 403);

  const configured = await request(`/api/portal/v1/loans/settings/locations/${locationId}`, {
    method: "PUT",
    session: adminSession,
    body: {
      enabled: true,
      articleLookup: {
        enabled: true,
        provider: "shopware_storefront",
        baseUrl: "https://shop.lamprechter.com",
      },
      documentRecipientEmployeeNumber: ADMIN,
    },
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
  assert.equal(configured.payload.location.enabled, true);
  assert.equal(configured.payload.location.articleLookup.baseUrl, "https://shop.lamprechter.com");
  assert.equal(configured.payload.location.documentRecipient.employeeNumber, ADMIN);
  assert.equal(configured.payload.location.emailDelivery.enabled, false);
  assert.equal(configured.payload.location.emailDelivery.recipient, "");

  const status = await request("/api/portal/v1/loans/status");
  assert.equal(status.response.status, 200, JSON.stringify(status.payload));
  assert.equal(status.payload.available, true);
  assert.equal(status.payload.permissions.ownCreate, true);
});

test("v0.85 manuelle Rückfalleingabe speichert einen wiederverwendbaren Artikel", async () => {
  db.prepare(`
    UPDATE loan_location_settings
    SET article_lookup_enabled = 0, article_lookup_provider = 'none',
        article_lookup_base_url = '', updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  const invalid = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: { locationId, articleNumber: "12345", manualDescription: "Ungültig" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "ARTICLE_IDENTIFIER_INVALID");

  const resolved = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      articleNumber: "089319",
      manualDescription: "DÖRR Mini Octagon Softbox für Blitzgeräte",
    },
  });
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.payload));
  assert.equal(resolved.payload.article.articleNumber, "089319");
  assert.equal(resolved.payload.article.sourceProvider, "manual");

  const protectedExisting = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      articleNumber: "089319",
      manualDescription: "Unbeabsichtigtes Überschreiben",
    },
  });
  assert.equal(protectedExisting.response.status, 200, JSON.stringify(protectedExisting.payload));
  assert.equal(protectedExisting.payload.preservedManualDescription, true);
  assert.equal(protectedExisting.payload.article.description, "DÖRR Mini Octagon Softbox für Blitzgeräte");

  const cached = await request(`/api/portal/v1/loans/articles?locationId=${locationId}&query=089319`);
  assert.equal(cached.response.status, 200, JSON.stringify(cached.payload));
  assert.equal(cached.payload.articles[0].description, "DÖRR Mini Octagon Softbox für Blitzgeräte");

  db.prepare(`
    UPDATE loan_location_settings
    SET article_lookup_enabled = 1, article_lookup_provider = 'shopware_storefront',
        article_lookup_base_url = 'https://shop.example.test', updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  db.prepare(`
    UPDATE articles
    SET source_provider = 'shopware_storefront', source_fetched_at = CURRENT_TIMESTAMP
    WHERE article_number = '089319'
  `).run();
  const cachedResolution = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: { locationId, articleNumber: "089319" },
  });
  assert.equal(cachedResolution.response.status, 200, JSON.stringify(cachedResolution.payload));
  assert.equal(cachedResolution.payload.cacheHit, true);
  assert.equal(cachedResolution.payload.lookupWarning, null);
});

test("v0.85 ein einmal bestätigter EAN-Abgleich wird lokal wiederverwendet", async () => {
  db.prepare(`
    UPDATE loan_location_settings
    SET article_lookup_enabled = 0, article_lookup_provider = 'none',
        article_lookup_base_url = '', updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  const first = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      identifier: "5025232978748",
      manualArticleNumber: "104405",
      manualDescription: "Panasonic Lumix DC-TZ99 Schwarz",
    },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.article.articleNumber, "104405");
  assert.deepEqual(first.payload.article.identifiers.map((item) => [item.type, item.value]), [
    ["ean13", "5025232978748"],
  ]);

  const cached = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: { locationId, identifier: "5025232978748" },
  });
  assert.equal(cached.response.status, 200, JSON.stringify(cached.payload));
  assert.equal(cached.payload.cacheHit, true);
  assert.equal(cached.payload.article.articleNumber, "104405");

  const search = await request(`/api/portal/v1/loans/articles?locationId=${locationId}&query=5025232978748`);
  assert.equal(search.response.status, 200, JSON.stringify(search.payload));
  assert.equal(search.payload.articles[0].articleNumber, "104405");
});

test("v0.85 Ausgabe, Live-Gegenprüfung und bestätigte Rücknahme bilden einen Revisionsverlauf", async () => {
  const issued = await request("/api/portal/v1/loans", {
    method: "POST",
    body: {
      locationId,
      dueDate: "2027-01-15",
      notes: "Testausgabe",
      items: [{
        articleNumber: "104405",
        serialNumber: "TZ99-TEST-1",
        conditionOut: "good",
        note: "mit Akku",
      }],
    },
  });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.payload));
  assert.equal(issued.payload.loan.status, "issued");
  assert.equal(issued.payload.loan.revision, 1);
  assert.equal(issued.payload.loan.items[0].quantity, 1);
  assert.equal(issued.payload.loan.documents.length, 1);
  assert.equal(issued.payload.loan.documents[0].type, "issue");
  assert.ok(issued.payload.loan.documents[0].delivery.internalSent >= 1);
  const issuePdf = await requestBinary(issued.payload.loan.documents[0].downloadUrl);
  assert.equal(issuePdf.response.status, 200);
  assert.equal(issuePdf.buffer.subarray(0, 4).toString("ascii"), "%PDF");
  assert.equal(issuePdf.response.headers.get("cache-control"), "private, no-store, max-age=0");

  const issueImage = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 38, g: 120, b: 95 },
    },
  }).png().toBuffer();
  const issuePhotoForm = new FormData();
  issuePhotoForm.set("phase", "issue");
  issuePhotoForm.append("photos", new Blob([issueImage], { type: "image/png" }), "Ausgabe.png");
  const uploadedIssuePhoto = await request(
    `/api/portal/v1/loans/${issued.payload.loan.id}/photos`,
    { method: "POST", body: issuePhotoForm },
  );
  assert.equal(uploadedIssuePhoto.response.status, 201, JSON.stringify(uploadedIssuePhoto.payload));
  assert.equal(uploadedIssuePhoto.payload.photos.length, 1);
  assert.equal(uploadedIssuePhoto.payload.photos[0].phase, "issue");
  assert.match(uploadedIssuePhoto.payload.photos[0].filename, /\.jpg$/);
  const issuePhoto = await requestBinary(uploadedIssuePhoto.payload.photos[0].contentUrl);
  assert.equal(issuePhoto.response.status, 200);
  assert.equal(issuePhoto.response.headers.get("content-type"), "image/jpeg");
  assert.equal(issuePhoto.response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(issuePhoto.buffer.subarray(0, 2).toString("hex"), "ffd8");
  const deniedPhoto = await requestBinary(uploadedIssuePhoto.payload.photos[0].contentUrl, {
    session: otherSession,
  });
  assert.equal(deniedPhoto.response.status, 403);

  const open = await request(`/api/portal/v1/loans?scope=mine&status=open&locationId=${locationId}`);
  assert.equal(open.response.status, 200, JSON.stringify(open.payload));
  assert.equal(open.payload.loans.some((loan) => loan.id === issued.payload.loan.id), true);

  const management = await request(
    `/api/portal/v1/loans/management/summary?locationId=${locationId}`,
    { session: adminSession },
  );
  assert.equal(management.response.status, 200, JSON.stringify(management.payload));
  assert.equal(management.payload.loans.some((loan) => loan.id === issued.payload.loan.id), true);
  assert.ok(management.payload.summary.open >= 1);

  db.prepare(`
    UPDATE loan_location_settings
    SET document_email_enabled = 1,
        document_recipient_email = 'belege@example.test',
        updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);
  const failedEmailRetry = await request(
    `/api/portal/v1/loans/documents/${issued.payload.loan.documents[0].id}/email`,
    { method: "POST", session: adminSession, body: {} },
  );
  assert.equal(failedEmailRetry.response.status, 503, JSON.stringify(failedEmailRetry.payload));
  assert.equal(failedEmailRetry.payload.delivery.status, "failed");
  assert.equal(failedEmailRetry.payload.document.delivery.emailStatus, "failed");
  assert.equal(failedEmailRetry.payload.document.delivery.emailAttempts, 1);
  db.prepare(`
    UPDATE loan_location_settings
    SET document_email_enabled = 0,
        document_recipient_email = '',
        updated_at = CURRENT_TIMESTAMP
    WHERE location_id = ?
  `).run(locationId);

  db.prepare(`
    UPDATE portal_sessions SET last_seen_at = datetime('now', '-5 minutes')
    WHERE employee_number = ?
  `).run(WITNESS);
  const offline = await request(`/api/portal/v1/loans/${issued.payload.loan.id}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      borrowerConfirmed: true,
      note: "vollständig",
      items: [{ position: 1, conditionReturn: "good", note: "" }],
    },
  });
  assert.equal(offline.response.status, 409, JSON.stringify(offline.payload));
  assert.equal(offline.payload.code, "LOAN_RETURN_WITNESS_OFFLINE");

  const heartbeat = await request("/api/portal/v1/loans/return-confirmations/pending", {
    session: witnessSession,
  });
  assert.equal(heartbeat.response.status, 200, JSON.stringify(heartbeat.payload));
  assert.deepEqual(heartbeat.payload.confirmations, []);

  const returnImage = await sharp({
    create: {
      width: 900,
      height: 900,
      channels: 3,
      background: { r: 255, g: 203, b: 66 },
    },
  }).jpeg({ quality: 92 }).toBuffer();
  const returnPhotoForm = new FormData();
  returnPhotoForm.set("phase", "return");
  returnPhotoForm.append("photos", new Blob([returnImage], { type: "image/jpeg" }), "Rueckgabe.jpg");
  const uploadedReturnPhoto = await request(
    `/api/portal/v1/loans/${issued.payload.loan.id}/photos`,
    { method: "POST", body: returnPhotoForm },
  );
  assert.equal(uploadedReturnPhoto.response.status, 201, JSON.stringify(uploadedReturnPhoto.payload));
  assert.equal(uploadedReturnPhoto.payload.photos.length, 1);

  const requested = await request(`/api/portal/v1/loans/${issued.payload.loan.id}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      borrowerConfirmed: true,
      note: "vollständig",
      items: [{ position: 1, conditionReturn: "good", note: "" }],
    },
  });
  assert.equal(requested.response.status, 202, JSON.stringify(requested.payload));
  assert.equal(requested.payload.loan.status, "issued");
  assert.equal(requested.payload.loan.revision, 1);
  assert.equal(requested.payload.loan.pendingReturnConfirmation.witness.employeeNumber, WITNESS);

  const witnessPending = await request("/api/portal/v1/loans/return-confirmations/pending", {
    session: witnessSession,
  });
  assert.equal(witnessPending.response.status, 200, JSON.stringify(witnessPending.payload));
  assert.equal(witnessPending.payload.confirmations.length, 1);
  assert.equal(witnessPending.payload.confirmations[0].loan.borrower.employeeNumber, EMPLOYEE);
  assert.equal(witnessPending.payload.confirmations[0].items[0].conditionReturn, "good");
  assert.equal(witnessPending.payload.confirmations[0].photos.length, 1);
  assert.equal(witnessPending.payload.confirmations[0].photos[0].phase, "return");

  const requesterCannotConfirm = await request(
    `/api/portal/v1/loans/return-confirmations/${requested.payload.confirmation.id}/respond`,
    {
      method: "POST",
      body: { decision: "confirm" },
    },
  );
  assert.equal(requesterCannotConfirm.response.status, 403);
  assert.equal(requesterCannotConfirm.payload.code, "LOAN_RETURN_CONFIRMATION_DENIED");

  const returned = await request(
    `/api/portal/v1/loans/return-confirmations/${requested.payload.confirmation.id}/respond`,
    {
      method: "POST",
      session: witnessSession,
      body: { decision: "confirm", note: "gemeinsam geprüft" },
    },
  );
  assert.equal(returned.response.status, 200, JSON.stringify(returned.payload));
  assert.equal(returned.payload.loan.status, "returned");
  assert.equal(returned.payload.loan.revision, 2);
  assert.equal(returned.payload.loan.returnWitness.employeeNumber, WITNESS);
  assert.deepEqual(returned.payload.loan.documents.map((document) => document.type), ["issue", "return"]);
  assert.deepEqual(returned.payload.loan.events.map((event) => event.type), [
    "issued",
    "document_created",
    "photos_added",
    "photos_added",
    "return_confirmation_requested",
    "returned",
    "document_created",
  ]);
  const returnDocument = returned.payload.loan.documents.find((document) => document.type === "return");
  const returnPdf = await requestBinary(returnDocument.downloadUrl, { session: witnessSession });
  assert.equal(returnPdf.response.status, 200);
  assert.equal(returnPdf.buffer.subarray(0, 4).toString("ascii"), "%PDF");
  const deniedPdf = await requestBinary(returnDocument.downloadUrl, { session: otherSession });
  assert.equal(deniedPdf.response.status, 403);

  const stale = await request(`/api/portal/v1/loans/${issued.payload.loan.id}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      items: [{ position: 1, conditionReturn: "good", note: "" }],
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "LOAN_ALREADY_CLOSED");
});

test("v0.85 eine abgelehnte Gegenprüfung lässt die Leihe offen und erlaubt eine neue Anfrage", async () => {
  const issued = await request("/api/portal/v1/loans", {
    method: "POST",
    body: {
      locationId,
      items: [{
        articleNumber: "104405",
        serialNumber: "TZ99-TEST-2",
        conditionOut: "good",
      }],
    },
  });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.payload));
  await request("/api/portal/v1/loans/return-confirmations/pending", { session: witnessSession });

  const requested = await request(`/api/portal/v1/loans/${issued.payload.loan.id}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      items: [{ position: 1, conditionReturn: "damaged", note: "bitte prüfen" }],
    },
  });
  assert.equal(requested.response.status, 202, JSON.stringify(requested.payload));

  const rejected = await request(
    `/api/portal/v1/loans/return-confirmations/${requested.payload.confirmation.id}/respond`,
    {
      method: "POST",
      session: witnessSession,
      body: { decision: "reject", note: "Zustand stimmt nicht" },
    },
  );
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.confirmation.status, "rejected");
  assert.equal(rejected.payload.loan.status, "issued");
  assert.equal(rejected.payload.loan.revision, 1);
  assert.equal(rejected.payload.loan.pendingReturnConfirmation, null);

  const requestedAgain = await request(`/api/portal/v1/loans/${issued.payload.loan.id}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      items: [{ position: 1, conditionReturn: "good", note: "" }],
    },
  });
  assert.equal(requestedAgain.response.status, 202, JSON.stringify(requestedAgain.payload));
  assert.notEqual(requestedAgain.payload.confirmation.id, requested.payload.confirmation.id);
});

test("neue Leihen werden serverseitig immer dem angemeldeten Mitarbeiter zugeordnet", async () => {
  const denied = await request("/api/portal/v1/loans", {
    method: "POST",
    session: managerSession,
    body: {
      locationId,
      borrowerEmployeeNumber: EMPLOYEE,
      items: [{ articleNumber: "104405", conditionOut: "good" }],
    },
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "LOAN_BORROWER_DENIED");

  const own = await request("/api/portal/v1/loans", {
    method: "POST",
    session: managerSession,
    body: {
      locationId,
      borrowerEmployeeNumber: MANAGER,
      items: [{ articleNumber: "104405", conditionOut: "good" }],
    },
  });
  assert.equal(own.response.status, 201, JSON.stringify(own.payload));
  assert.equal(own.payload.loan.borrower.employeeNumber, MANAGER);
  assert.equal(own.payload.loan.createdBy.employeeNumber, MANAGER);
});

test("Filialleitung kann Leihen revisionsgesichert bearbeiten, ohne Beleg schließen und wieder öffnen", async () => {
  const issued = await request("/api/portal/v1/loans", {
    method: "POST",
    body: {
      locationId,
      dueDate: "2027-03-01",
      notes: "Vor Bearbeitung",
      items: [{
        articleNumber: "104405",
        serialNumber: "FL-TEST-1",
        conditionOut: "good",
        note: "mit Tasche",
      }],
    },
  });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.payload));
  const loanId = issued.payload.loan.id;
  const issueDocumentId = issued.payload.loan.documents[0].id;

  const denied = await request(`/api/portal/v1/loans/${loanId}/management`, {
    method: "PUT",
    body: {
      expectedRevision: 1,
      dueDate: "2027-03-02",
      notes: "",
      items: [{
        position: 1,
        serialNumber: "FL-TEST-1",
        conditionOut: "good",
        conditionReturn: "",
        note: "",
      }],
    },
  });
  assert.equal(denied.response.status, 403);

  const witnessHeartbeat = await request("/api/portal/v1/loans/return-confirmations/pending", {
    session: witnessSession,
  });
  assert.equal(witnessHeartbeat.response.status, 200);
  const pendingReturn = await request(`/api/portal/v1/loans/${loanId}/return`, {
    method: "POST",
    body: {
      expectedRevision: 1,
      witnessEmployeeNumber: WITNESS,
      items: [{ position: 1, conditionReturn: "good", note: "" }],
    },
  });
  assert.equal(pendingReturn.response.status, 202, JSON.stringify(pendingReturn.payload));

  const edited = await request(`/api/portal/v1/loans/${loanId}/management`, {
    method: "PUT",
    session: managerSession,
    body: {
      expectedRevision: 1,
      dueDate: "2027-03-15",
      notes: "Durch FL ergänzt",
      items: [{
        position: 1,
        serialNumber: "FL-TEST-1-KORR",
        conditionOut: "used",
        conditionReturn: "",
        note: "Tasche und Ladegerät",
      }],
    },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.loan.revision, 2);
  assert.equal(edited.payload.loan.dueDate, "2027-03-15");
  assert.equal(edited.payload.loan.items[0].conditionOut, "used");
  assert.equal(edited.payload.loan.pendingReturnConfirmation, null);
  assert.equal(
    db.prepare("SELECT status FROM loan_return_confirmations WHERE id = ?").get(
      pendingReturn.payload.confirmation.id,
    ).status,
    "cancelled",
  );

  const closed = await request(`/api/portal/v1/loans/${loanId}/management/close`, {
    method: "POST",
    session: managerSession,
    body: {
      expectedRevision: 2,
      dueDate: "2027-03-15",
      notes: "Manuell geschlossen",
      items: [{
        position: 1,
        serialNumber: "FL-TEST-1-KORR",
        conditionOut: "used",
        conditionReturn: "good",
        note: "vollständig",
      }],
    },
  });
  assert.equal(closed.response.status, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.loan.status, "returned");
  assert.equal(closed.payload.loan.revision, 3);
  assert.equal(closed.payload.loan.returnWitness, null);
  assert.equal(closed.payload.loan.borrowerReturnConfirmed, false);
  assert.deepEqual(closed.payload.loan.documents.map((document) => document.id), [issueDocumentId]);
  assert.equal(closed.payload.loan.events.at(-1).type, "manager_closed_without_document");

  const reopened = await request(`/api/portal/v1/loans/${loanId}/management/reopen`, {
    method: "POST",
    session: managerSession,
    body: { expectedRevision: 3 },
  });
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.payload));
  assert.equal(reopened.payload.loan.status, "issued");
  assert.equal(reopened.payload.loan.revision, 4);
  assert.equal(reopened.payload.loan.items[0].conditionReturn, "");
  assert.deepEqual(reopened.payload.loan.documents.map((document) => document.id), [issueDocumentId]);
  assert.equal(reopened.payload.loan.events.at(-1).type, "manager_reopened");

  const stale = await request(`/api/portal/v1/loans/${loanId}/management`, {
    method: "PUT",
    session: managerSession,
    body: {
      expectedRevision: 3,
      dueDate: "",
      notes: "",
      items: [{
        position: 1,
        serialNumber: "",
        conditionOut: "good",
        conditionReturn: "",
        note: "",
      }],
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "LOAN_STALE");
});

test("Leihverwaltung und FL-Aktionen sind im Portal verankert, der F18-Import ist entfernt", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const adminHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const adminSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const portalHtml = fs.readFileSync(path.join(__dirname, "..", "public", "portal.html"), "utf8");
  const portalSource = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");

  assert.match(adminHtml, /id="loanManagementNavButton"/);
  assert.match(adminHtml, /id="loansView"/);
  assert.match(adminHtml, /id="loanManagementSummary"/);
  assert.match(adminHtml, /id="loanSettingsCard"/);
  assert.doesNotMatch(adminHtml, /id="f18MigrationCard"/);
  assert.doesNotMatch(adminSource, /\/api\/portal\/v1\/loans\/migrations\/f18/);
  assert.doesNotMatch(serverSource, /app\.(?:get|post)\("\/api\/portal\/v1\/loans\/migrations\/f18/);
  assert.match(adminSource, /\/api\/portal\/v1\/loans\/management\/summary/);
  assert.match(adminSource, /\/api\/portal\/v1\/loans\/documents\/\$\{encodeURIComponent\(documentId\)\}\/email/);
  assert.match(portalHtml, /id="loanIssuePhotos"/);
  assert.match(portalHtml, /id="loanReturnPhotos"/);
  assert.match(portalHtml, /id="loanManageDialog"/);
  assert.doesNotMatch(portalHtml, /id="loanBorrower"/);
  assert.match(portalSource, /uploadLoanPhotos/);
  assert.match(portalSource, /data-loan-photo-remove/);
  assert.match(portalSource, /\/management\/\$\{suffix\}/);
});
