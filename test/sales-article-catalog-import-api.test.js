"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-article-import-api-"));
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
  SALES_ARTICLE_CATALOG_PERMISSIONS,
} = require("../lib/sales-article-catalog-access");
const {
  TRADEFOTO_ARTICLE_ROW_FIELDS,
  TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS,
  TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS,
} = require("../lib/tradefoto-article-source-profile");
const {
  TRADEFOTO_GROSS_NET_PAIRS,
} = require("../lib/tradefoto-article-import");
const subject = require("../server");
const { app, db } = subject;

const MIME = "application/vnd.grabenplaner.tradefoto-articles+json";
const IMPORTER = "article-importer";
const OTHER_IMPORTER = "article-importer-other";
const WRITER = "article-import-writer";
let httpServer;
let baseUrl;

function grant(employeeNumber, permission) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `).run(employeeNumber, permission, IMPORTER);
}

function revokeGrant(employeeNumber, permission) {
  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE employee_number = ? AND permission = ?
  `).run(employeeNumber, permission);
}

function createSession(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return `grabenplaner_session=${encodeURIComponent(token)}`;
}

function authHeaders(employeeNumber, { csrf = false } = {}) {
  const headers = {
    Accept: "application/json",
    Cookie: createSession(employeeNumber),
  };
  if (csrf) {
    const token = crypto.randomBytes(24).toString("hex");
    headers.Cookie += `; grabenplaner_csrf=${encodeURIComponent(token)}`;
    headers["X-CSRF-Token"] = token;
  }
  return headers;
}

async function responsePayload(response) {
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

async function requestJson(route, {
  employeeNumber = IMPORTER,
  method = "GET",
  body,
  csrf = !["GET", "HEAD"].includes(method),
  extraHeaders = {},
} = {}) {
  const headers = { ...authHeaders(employeeNumber, { csrf }), ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return responsePayload(await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function requestRaw(route, body, {
  employeeNumber = IMPORTER,
  csrf = true,
  contentType = MIME,
  fileName = "TradeFoto-Artikel.json",
} = {}) {
  const headers = {
    ...authHeaders(employeeNumber, { csrf }),
    "Content-Type": contentType,
    "X-Import-Filename": fileName,
  };
  return responsePayload(await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"),
  }));
}

function noStore(response) {
  assert.match(response.headers.get("cache-control") || "", /\bno-store\b/);
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function sourceRow(sourceArticleKey, description, overrides = {}) {
  const row = { EAN: sourceArticleKey, Artikelbezeichnung: description, MWST: 1 };
  for (const { sourceField } of TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS) {
    row[sourceField] = null;
  }
  for (const { sourceField } of TRADEFOTO_EXCLUDED_NON_MONETARY_FIELDS) {
    row[sourceField] = null;
  }
  Object.assign(row, overrides);
  assert.deepEqual(Object.keys(row).sort(), [...TRADEFOTO_ARTICLE_ROW_FIELDS].sort());
  return row;
}

function sourceArticle(sourceArticleKey, description, {
  aliasRows = [],
  row = {},
} = {}) {
  return {
    articleRow: sourceRow(sourceArticleKey, description, row),
    aliasRows,
  };
}

function ean13(base12) {
  assert.match(base12, /^\d{12}$/);
  const sum = [...base12].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base12}${(10 - (sum % 10)) % 10}`;
}

function exchange(catalog, articles, overrides = {}) {
  return {
    format: "grabenplaner.tradefoto.article-catalog.v1",
    sourceSystem: catalog.sourceSystem,
    sourceProfileVersion: catalog.sourceProfileVersion,
    sourceSchemaSha256: catalog.sourceSchemaSha256,
    snapshotAt: "2026-09-03T13:00:00.000Z",
    currency: "EUR",
    articles,
    ...overrides,
  };
}

function tableCounts() {
  return Object.fromEntries([
    "sales_article_import_snapshots",
    "sales_article_import_findings",
    "sales_article_import_impacts",
    "sales_articles",
    "sales_article_revisions",
    "sales_article_source_links",
    "sales_article_identifiers",
    "sales_article_price_snapshots",
    "audit_log",
    "personal_action_receipts",
  ].map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}

function currentArticleBusinessState(articleNumber) {
  const head = db.prepare(`
    SELECT
      article.product_id AS productId,
      article.current_revision AS currentRevision,
      revision.article_number AS articleNumber,
      revision.description,
      revision.active,
      revision.source_snapshot_id AS sourceSnapshotId,
      revision.source_updated_at AS sourceUpdatedAt
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
      AND revision.revision = article.current_revision
    WHERE article.article_number = ?
  `).get(articleNumber);
  if (!head) return null;
  const identifiers = db.prepare(`
    SELECT identifier_type AS identifierType, identifier_value AS identifierValue,
      canonical_gtin14 AS canonicalGtin14, is_primary AS isPrimary,
      source_field AS sourceField, source_rank AS sourceRank,
      equivalent_identifiers_json AS equivalentIdentifiers, source_provider AS sourceProvider
    FROM sales_article_identifiers
    WHERE product_id = ? AND source_snapshot_id = ?
    ORDER BY is_primary DESC, identifier_type, identifier_value, source_rank
  `).all(head.productId, head.sourceSnapshotId).map((row) => ({ ...row }));
  const prices = db.prepare(`
    SELECT price_type AS priceType, amount, currency, price_basis AS priceBasis,
      quality_status AS qualityStatus, source_field AS sourceField
    FROM sales_article_price_snapshots
    WHERE product_id = ? AND source_snapshot_id = ?
    ORDER BY price_type, source_field
  `).all(head.productId, head.sourceSnapshotId).map((row) => ({ ...row }));
  return Object.freeze({ ...head, identifiers, prices });
}

function businessValues(state) {
  return {
    articleNumber: state.articleNumber,
    description: state.description,
    active: state.active,
    sourceUpdatedAt: state.sourceUpdatedAt,
    identifiers: state.identifiers,
    prices: state.prices,
  };
}

function immutableImportHistory(snapshotId) {
  const rows = (sql) => db.prepare(sql).all(snapshotId).map((row) => ({ ...row }));
  return JSON.stringify({
    snapshot: rows("SELECT * FROM sales_article_import_snapshots WHERE id = ? ORDER BY id"),
    findings: rows("SELECT * FROM sales_article_import_findings WHERE snapshot_id = ? ORDER BY ordinal"),
    impacts: rows("SELECT * FROM sales_article_import_impacts WHERE snapshot_id = ? ORDER BY ordinal"),
    audit: rows(`
      SELECT * FROM audit_log
      WHERE action = 'sales.article-catalog.import' AND entity_id = ?
      ORDER BY id
    `),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startStalledPreview(employeeNumber = IMPORTER) {
  const request = http.request(`${baseUrl}/api/sales/articles/import/preview`, {
    method: "POST",
    headers: {
      ...authHeaders(employeeNumber, { csrf: true }),
      "Content-Type": MIME,
      "Content-Length": "1024",
      "X-Import-Filename": "stalled-preview.json",
    },
  });
  request.on("error", () => {});
  request.write("{");
  await wait(75);
  return request;
}

async function requestChunkedOversizePreview(employeeNumber = IMPORTER) {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = http.request(`${baseUrl}/api/sales/articles/import/preview`, {
      method: "POST",
      headers: {
        ...authHeaders(employeeNumber, { csrf: true }),
        "Content-Type": MIME,
        "X-Import-Filename": "oversize-chunked.json",
      },
    }, (response) => {
      responseStarted = true;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
        resolve({ status: response.statusCode, headers: response.headers, payload, text });
      });
    });
    request.on("error", (error) => {
      if (!responseStarted) reject(error);
    });
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    request.write(chunk);
    for (let index = 0; index < 64; index += 1) request.write(chunk);
    request.end();
  });
}

async function catalog(employeeNumber = IMPORTER) {
  const result = await requestJson("/api/sales/articles/import/catalog", { employeeNumber });
  assert.equal(result.response.status, 200, result.text);
  return result;
}

async function preview(catalogPayload, articles, options = {}) {
  const body = JSON.stringify(exchange(catalogPayload, articles, options.exchange || {}));
  return requestRaw("/api/sales/articles/import/preview", body, options.request || {});
}

async function applyPreview(previewPayload, options = {}) {
  return requestJson("/api/sales/articles/import/apply", {
    method: "POST",
    body: {
      previewId: previewPayload.previewId,
      confirmationFingerprint: previewPayload.confirmationFingerprint,
      ...(options.extraBody || {}),
    },
    employeeNumber: options.employeeNumber || IMPORTER,
    csrf: options.csrf !== false,
  });
}

async function createManualArticle(articleNumber, description, identifiers = []) {
  const result = await requestJson("/api/sales/articles", {
    method: "POST",
    body: { articleNumber, description, identifiers },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.payload.article;
}

async function archiveManualArticle(article) {
  const result = await requestJson("/api/sales/articles/archive", {
    method: "POST",
    body: {
      articleNumber: article.articleNumber,
      expectedRevision: article.currentRevision,
    },
  });
  assert.equal(result.response.status, 200, result.text);
  return result.payload.article;
}

test.before(async () => {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  const position = db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get();
  let department = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(location.id);
  if (!department) {
    department = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Artikelimport Tests', 0, 1, 9294)
      RETURNING id
    `).get(location.id);
  }
  for (const [employeeNumber, name] of [
    [IMPORTER, "Artikelimport Manager"],
    [OTHER_IMPORTER, "Artikelimport Zweitmanager"],
    [WRITER, "Artikelstamm ohne Importrecht"],
  ]) {
    db.prepare(`
      INSERT INTO employees (
        personnel_number, full_name, nickname, color, contracted_hours,
        target_workdays_per_week, fixed_workdays, home_location_id,
        preferred_department_id, position_id, active
      ) VALUES (?, ?, 'Import', '#26785f', 38.5, 5, '', ?, ?, ?, 1)
    `).run(employeeNumber, name, location.id, department.id, position.id);
    db.prepare(`
      INSERT INTO portal_users (
        employee_number, password_hash, role, active, must_change_password,
        password_changed_at, updated_at
      ) VALUES (?, 'test-only', 'manager', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(employeeNumber);
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(employeeNumber, location.id, IMPORTER);
    grant(employeeNumber, SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS);
    grant(employeeNumber, SALES_ARTICLE_CATALOG_PERMISSIONS.READ);
  }
  grant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  grant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
  grant(OTHER_IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  grant(WRITER, SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Artikelimport verlangt sein eigenes Live-Recht, CSRF, MIME und den festen Dateivertrag", async () => {
  const unauthenticated = await responsePayload(await fetch(
    `${baseUrl}/api/sales/articles/import/catalog`,
    { headers: { Accept: "application/json" } },
  ));
  assert.equal(unauthenticated.response.status, 401, unauthenticated.text);

  const writeOnly = await requestJson("/api/sales/articles/import/catalog", {
    employeeNumber: WRITER,
  });
  assert.equal(writeOnly.response.status, 403, writeOnly.text);

  const catalogResult = await catalog();
  noStore(catalogResult.response);
  assert.deepEqual(Object.keys(catalogResult.payload).sort(), [
    "currency", "format", "maxBytes", "maxRows", "maxWorkUnits", "mimeType", "sourceProfileVersion",
    "sourceSchemaSha256", "sourceSystem",
  ]);
  assert.equal(catalogResult.payload.mimeType, MIME);
  assert.equal(catalogResult.payload.maxBytes, 64 * 1024 * 1024);
  assert.equal(catalogResult.payload.maxRows, 25000);
  assert.equal(catalogResult.payload.maxWorkUnits, 750000);
  assert.equal(catalogResult.payload.sourceSystem, "tradefoto.artikel_stamm");
  assert.equal(catalogResult.payload.sourceProfileVersion, "tradefoto-article-v1");
  assert.match(catalogResult.payload.sourceSchemaSha256, /^[a-f0-9]{64}$/);
  assert.equal(catalogResult.payload.currency, "EUR");

  const validBody = JSON.stringify(exchange(catalogResult.payload, [
    sourceArticle("0000000093757", "Sicherer Importvertrag"),
  ]));
  const noCsrf = await requestRaw("/api/sales/articles/import/preview", validBody, {
    csrf: false,
  });
  assert.equal(noCsrf.response.status, 403, noCsrf.text);

  const wrongMime = await requestRaw("/api/sales/articles/import/preview", validBody, {
    contentType: "application/json",
  });
  assert.equal(wrongMime.response.status, 415, wrongMime.text);
  assert.equal(wrongMime.payload?.code, "SALES_ARTICLE_IMPORT_CONTENT_TYPE_UNSUPPORTED");

  const invalidJson = await requestRaw("/api/sales/articles/import/preview", "{nicht-json");
  assert.equal(invalidJson.response.status, 422, invalidJson.text);
  assert.equal(invalidJson.payload?.code, "SALES_ARTICLE_IMPORT_JSON_INVALID");

  const drift = await requestRaw(
    "/api/sales/articles/import/preview",
    JSON.stringify(exchange(catalogResult.payload, [
      sourceArticle("0000000093757", "Schemaabweichung"),
    ], { sourceSchemaSha256: "0".repeat(64) })),
  );
  assert.equal(drift.response.status, 422, drift.text);
  assert.equal(drift.payload?.code, "SALES_ARTICLE_IMPORT_SCHEMA_MISMATCH");

  const unknownField = await requestRaw(
    "/api/sales/articles/import/preview",
    JSON.stringify({
      ...exchange(catalogResult.payload, [sourceArticle("0000000093757", "Unbekannt")]),
      unmodeledSourceData: "darf nicht übernommen werden",
    }),
  );
  assert.equal(unknownField.response.status, 422, unknownField.text);
  assert.match(unknownField.payload?.code || "", /^SALES_ARTICLE_IMPORT_/);

  const tooManyRows = await requestRaw(
    "/api/sales/articles/import/preview",
    JSON.stringify(exchange(catalogResult.payload, Array.from({ length: 25001 }, () => ({})))),
  );
  assert.equal(tooManyRows.response.status, 413, tooManyRows.text);
  assert.match(tooManyRows.payload?.code || "", /^SALES_ARTICLE_IMPORT_/);
});

test("Das eigenständige Importrecht erlaubt Preview und Apply ohne manuelles Schreibrecht", async () => {
  const manualWrite = await requestJson("/api/sales/articles", {
    employeeNumber: OTHER_IMPORTER,
    method: "POST",
    body: { articleNumber: "IMPORT-NO-WRITE", description: "Nicht manuell anlegen" },
  });
  assert.equal(manualWrite.response.status, 403, manualWrite.text);

  const catalogResult = await catalog(OTHER_IMPORTER);
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093759", "Import ohne manuelles Schreibrecht"),
  ], { request: { employeeNumber: OTHER_IMPORTER } });
  assert.equal(result.response.status, 201, result.text);
  assert.equal(result.payload.summary.create, 1);
  const applied = await applyPreview(result.payload, { employeeNumber: OTHER_IMPORTER });
  assert.equal(applied.response.status, 201, applied.text);
  assert.match(applied.payload.personalActionId, /^receipt:/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093759'").get().count,
    1,
  );

  const foreignUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {}, employeeNumber: IMPORTER },
  );
  assert.equal(foreignUndo.response.status, 404, foreignUndo.text);
  const noCsrfUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {}, employeeNumber: OTHER_IMPORTER, csrf: false },
  );
  assert.equal(noCsrfUndo.response.status, 403, noCsrfUndo.text);
  const undone = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {}, employeeNumber: OTHER_IMPORTER },
  );
  assert.equal(undone.response.status, 200, undone.text);
  assert.deepEqual(undone.payload, {
    undone: true,
    alreadyUndone: false,
    salesArticleImport: {
      snapshotId: applied.payload.snapshotId,
      articleCount: 1,
    },
  });
  const archived = currentArticleBusinessState("093759");
  assert.equal(archived.currentRevision, 2);
  assert.equal(archived.active, 0);
  const replay = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {}, employeeNumber: OTHER_IMPORTER },
  );
  assert.equal(replay.response.status, 200, replay.text);
  assert.equal(replay.payload.alreadyUndone, true);
  assert.equal(currentArticleBusinessState("093759").currentRevision, 2);
});

test("Ein vollständig quarantänisierter Lauf protokolliert Findings ohne Artikelmutation oder Undo-Beleg", async () => {
  const catalogResult = await catalog();
  const before = tableCounts();
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093758", "Ausschließlich quarantänisiert", {
      row: { DurchschnittEK: "-1" },
    }),
  ]);
  assert.equal(result.response.status, 201, result.text);
  assert.deepEqual(result.payload.summary, {
    total: 1,
    create: 0,
    update: 0,
    unchanged: 0,
    blocked: 1,
    identifierCount: 0,
    priceCount: 0,
  });
  assert.equal(result.payload.canApply, true);
  assert.ok(result.payload.rows[0].issueCodes.includes("negative_price"));
  assert.deepEqual(tableCounts(), before);

  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  noStore(applied.response);
  assert.equal(applied.payload.personalActionId, null);
  assert.equal(applied.payload.replayed, false);
  const after = tableCounts();
  assert.equal(after.sales_article_import_snapshots, before.sales_article_import_snapshots + 1);
  assert.equal(after.sales_article_import_findings, before.sales_article_import_findings + 1);
  assert.equal(after.audit_log, before.audit_log + 1);
  assert.equal(after.personal_action_receipts, before.personal_action_receipts);
  for (const table of [
    "sales_article_import_impacts",
    "sales_articles",
    "sales_article_revisions",
    "sales_article_source_links",
    "sales_article_identifiers",
    "sales_article_price_snapshots",
  ]) {
    assert.equal(after[table], before[table], `${table} darf sich nicht ändern`);
  }
  const stored = db.prepare(`
    SELECT article_count AS articleCount, identifier_count AS identifierCount,
      price_count AS priceCount
    FROM sales_article_import_snapshots WHERE id = ?
  `).get(applied.payload.snapshotId);
  assert.deepEqual({ ...stored }, { articleCount: 0, identifierCount: 0, priceCount: 0 });
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'sales.article-catalog.import' AND entity_id = ?
    `).get(applied.payload.snapshotId).count,
    1,
  );
});

test("Ein unveränderter Artikel mit reinem Alias-Hinweis bleibt Preview- und Apply-konsistent geschlossen", async () => {
  const catalogResult = await catalog();
  const sourceKey = ean13("000000093870");
  const baseline = await preview(catalogResult.payload, [
    sourceArticle(sourceKey, "Unveränderter Aliasartikel"),
  ]);
  assert.equal(baseline.response.status, 201, baseline.text);
  assert.equal((await applyPreview(baseline.payload)).response.status, 201);

  const warningOnly = await preview(catalogResult.payload, [
    sourceArticle(sourceKey, "Unveränderter Aliasartikel", {
      aliasRows: [{ EAN: sourceKey, ZweitEAN: sourceKey, Rang: 1 }],
    }),
  ]);
  assert.equal(warningOnly.response.status, 201, warningOnly.text);
  assert.deepEqual(warningOnly.payload.summary, {
    total: 1,
    create: 0,
    update: 0,
    unchanged: 1,
    blocked: 0,
    identifierCount: 0,
    priceCount: 0,
  });
  assert.equal(warningOnly.payload.canApply, false, warningOnly.text);
  const attempted = await applyPreview(warningOnly.payload);
  assert.equal(attempted.response.status, 422, attempted.text);
  assert.equal(attempted.payload?.code, "SALES_ARTICLE_IMPORT_NO_SAFE_ROWS");
});

test("Preview begrenzt laufende Schweroperationen vor Body-Pufferung und gibt das Gate nach Abbruch und 413 frei", async () => {
  const catalogResult = await catalog();
  const before = tableCounts();
  const stalled = await startStalledPreview(IMPORTER);
  try {
    const sameActor = await preview(catalogResult.payload, [
      sourceArticle("0000000093764", "Parallel gleicher Actor"),
    ]);
    assert.equal(sameActor.response.status, 429, sameActor.text);
    assert.equal(sameActor.payload?.code, "SALES_ARTICLE_IMPORT_BUSY");
    assert.equal(sameActor.response.headers.get("retry-after"), "5");

    const otherActor = await preview(catalogResult.payload, [
      sourceArticle("0000000093765", "Parallel global begrenzt"),
    ], { request: { employeeNumber: OTHER_IMPORTER } });
    assert.equal(otherActor.response.status, 429, otherActor.text);
    assert.equal(otherActor.payload?.code, "SALES_ARTICLE_IMPORT_BUSY");
  } finally {
    stalled.destroy();
    await wait(100);
  }
  assert.deepEqual(tableCounts(), before, "429/Abbruch dürfen keine Datenbankmutation auslösen");

  const recovered = await preview(catalogResult.payload, [
    sourceArticle("0000000093766", "Nach Abbruch wieder frei"),
  ]);
  assert.equal(recovered.response.status, 201, recovered.text);
  await requestJson(
    `/api/sales/articles/import/previews/${encodeURIComponent(recovered.payload.previewId)}`,
    { method: "DELETE" },
  );

  const oversizeBefore = tableCounts();
  const oversize = await requestChunkedOversizePreview();
  assert.equal(oversize.status, 413, oversize.text);
  assert.equal(oversize.payload?.code, "SALES_ARTICLE_IMPORT_FILE_SIZE_INVALID");
  assert.deepEqual(tableCounts(), oversizeBefore, "Raw-Parser-413 darf keine Datenbankmutation auslösen");
  const afterOversize = await preview(catalogResult.payload, [
    sourceArticle("0000000093767", "Nach Parserfehler wieder frei"),
  ]);
  assert.equal(afterOversize.response.status, 201, afterOversize.text);
  await requestJson(
    `/api/sales/articles/import/previews/${encodeURIComponent(afterOversize.payload.previewId)}`,
    { method: "DELETE" },
  );
});

test("Preview ist rein lesend, datensparsam und Apply übernimmt ausschließlich sichere Zeilen", async () => {
  const catalogResult = await catalog();
  const before = tableCounts();
  const rawSecretAmount = "9876.543210123456";
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093760", "Sicherer neuer Artikel", {
      row: { DurchschnittEK: rawSecretAmount },
    }),
    sourceArticle("0000000093761", "Quarantänisierter Artikel", {
      row: { DurchschnittEK: "-100" },
    }),
    sourceArticle("0000000093762", "Kurzformatiger Brutto-Netto-Konflikt", {
      row: { Verkaufspreis: "121", eNvk: "100.0" },
    }),
  ], {
    request: { fileName: "C:\\private\\TradeFoto-Artikel.json" },
  });
  assert.equal(result.response.status, 201, result.text);
  noStore(result.response);
  assert.deepEqual(tableCounts(), before, "Die Vorschau darf keinerlei Datenbankmutation auslösen");
  assert.match(result.payload.previewId, /^[a-zA-Z0-9._:-]+$/);
  assert.match(result.payload.confirmationFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.payload.source.fileName, "TradeFoto-Artikel.json");
  assert.equal(JSON.stringify(result.payload).includes("private"), false);
  assert.equal(JSON.stringify(result.payload).includes(rawSecretAmount), false);
  assert.equal(JSON.stringify(result.payload).includes("-100"), false);
  assert.deepEqual(result.payload.summary, {
    total: 3,
    create: 1,
    update: 0,
    unchanged: 0,
    blocked: 2,
    identifierCount: 0,
    priceCount: TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.length,
  });
  assert.equal(result.payload.canApply, true);
  assert.equal(result.payload.truncated, false);
  assert.deepEqual(result.payload.rows.map(({ action }) => action).sort(), ["blocked", "blocked", "create"]);
  assert.ok(result.payload.rows.find(({ action }) => action === "blocked")?.issueCodes.length > 0);
  assert.ok(result.payload.rows.some(({ issueCodes }) => issueCodes.includes("gross_net_mismatch")));

  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  noStore(applied.response);
  assert.equal(applied.payload.ok, true);
  assert.equal(applied.payload.replayed, false);
  assert.match(applied.payload.snapshotId, /^[a-f0-9]{64}$/);
  const safe = db.prepare(`
    SELECT product_id, current_revision FROM sales_articles WHERE article_number = '093760'
  `).get();
  assert.ok(safe?.product_id);
  assert.equal(safe.current_revision, 1);
  const safeRevision = db.prepare(`
    SELECT active, description FROM sales_article_revisions
    WHERE product_id = ? AND revision = 1
  `).get(safe.product_id);
  assert.deepEqual({ ...safeRevision }, { active: 1, description: "Sicherer neuer Artikel" });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093761'").get().count,
    0,
  );
  const importAudit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'sales.article-catalog.import' AND entity_id = ?
  `).get(applied.payload.snapshotId);
  assert.ok(importAudit);
  assert.equal(importAudit.detail.includes("Sicherer neuer Artikel"), false);
  assert.equal(importAudit.detail.includes(rawSecretAmount), false);

  const consumed = await applyPreview(result.payload);
  assert.notEqual(consumed.response.status, 201, consumed.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?").get(safe.product_id).count,
    1,
  );

  const replayPreview = await preview(catalogResult.payload, [
    sourceArticle("0000000093760", "Sicherer neuer Artikel", {
      row: { DurchschnittEK: rawSecretAmount },
    }),
  ]);
  assert.equal(replayPreview.response.status, 201, replayPreview.text);
  assert.equal(replayPreview.payload.summary.unchanged, 1);
  assert.equal(replayPreview.payload.canApply, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?").get(safe.product_id).count,
    1,
  );
});

test("Preview ist aktorgebunden, widerrufbar und wird bei Rechte- oder Zustandsänderung geschlossen abgewiesen", async () => {
  const catalogResult = await catalog();
  const foreign = await preview(catalogResult.payload, [
    sourceArticle("0000000093770", "Aktorgebundene Vorschau"),
  ]);
  assert.equal(foreign.response.status, 201, foreign.text);
  const otherActor = await applyPreview(foreign.payload, { employeeNumber: OTHER_IMPORTER });
  assert.notEqual(otherActor.response.status, 201, otherActor.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093770'").get().count,
    0,
  );

  revokeGrant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  const revoked = await applyPreview(foreign.payload);
  assert.equal(revoked.response.status, 403, revoked.text);
  grant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);

  const stale = await preview(catalogResult.payload, [
    sourceArticle("0000000093771", "Wird vor Apply manuell belegt"),
  ]);
  assert.equal(stale.response.status, 201, stale.text);
  const manual = await createManualArticle("093771", "Manueller Zwischenstand");
  const staleApply = await applyPreview(stale.payload);
  assert.equal(staleApply.response.status, 409, staleApply.text);
  assert.equal(staleApply.payload?.code, "SALES_ARTICLE_IMPORT_PREVIEW_STALE");
  const manualAfter = db.prepare(`
    SELECT article.current_revision AS currentRevision, revision.description, revision.active
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
      AND revision.revision = article.current_revision
    WHERE article.article_number = '093771'
  `).get();
  assert.deepEqual({ ...manualAfter }, {
    currentRevision: manual.currentRevision,
    description: "Manueller Zwischenstand",
    active: 1,
  });

  const cancellable = await preview(catalogResult.payload, [
    sourceArticle("0000000093772", "Widerrufbare Vorschau"),
  ]);
  assert.equal(cancellable.response.status, 201, cancellable.text);
  const cancelled = await requestJson(
    `/api/sales/articles/import/previews/${encodeURIComponent(cancellable.payload.previewId)}`,
    { method: "DELETE" },
  );
  assert.equal(cancelled.response.status, 204, cancelled.text);
  noStore(cancelled.response);
  const afterCancel = await applyPreview(cancellable.payload);
  assert.notEqual(afterCancel.response.status, 201, afterCancel.text);

  const exactBody = await preview(catalogResult.payload, [
    sourceArticle("0000000093773", "Exakter Apply-Vertrag"),
  ]);
  const extraField = await applyPreview(exactBody.payload, {
    extraBody: { rows: [{ articleNumber: "MANIPULIERT" }] },
  });
  assert.equal(extraField.response.status, 400, extraField.text);
  assert.equal(extraField.payload?.code, "SALES_ARTICLE_IMPORT_REQUEST_INVALID");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093773'").get().count,
    0,
  );
});

test("Apply koppelt Snapshot, Revisionen, Quellbindungen und Audit atomar", async () => {
  const catalogResult = await catalog();
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093780", "Atomarer Import A"),
    sourceArticle("0000000093781", "Atomarer Import B"),
  ]);
  assert.equal(result.response.status, 201, result.text);
  const before = tableCounts();
  db.exec(`
    CREATE TRIGGER test_article_import_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'sales.article-catalog.import'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic article import audit failure');
    END
  `);
  const failed = await applyPreview(result.payload);
  db.exec("DROP TRIGGER test_article_import_audit_failure");
  assert.notEqual(failed.response.status, 201, failed.text);
  assert.deepEqual(tableCounts(), before, "Ein Auditfehler muss den gesamten Import zurückrollen");

  const retried = await applyPreview(result.payload);
  assert.equal(retried.response.status, 201, retried.text);
  assert.equal(retried.payload.ok, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number IN ('093780','093781')").get().count,
    2,
  );
});

test("Import-Undo stellt Updates exakt wieder her, archiviert Neuanlagen additiv und bleibt atomar sowie idempotent", async () => {
  const catalogResult = await catalog();
  const oldGtin = ean13("590123412340");
  const newGtin = ean13("590123412341");
  const createdGtin = ean13("590123412342");
  const baselinePreview = await preview(catalogResult.payload, [
    sourceArticle("0000000093840", "Import-Undo Ausgangsstand", {
      aliasRows: [{ EAN: "0000000093840", ZweitEAN: oldGtin, Rang: 1 }],
      row: { DurchschnittEK: "10" },
    }),
  ]);
  assert.equal(baselinePreview.response.status, 201, baselinePreview.text);
  const baselineApply = await applyPreview(baselinePreview.payload);
  assert.equal(baselineApply.response.status, 201, baselineApply.text);
  const baselineState = currentArticleBusinessState("093840");
  assert.equal(baselineState.currentRevision, 1);

  const batchPreview = await preview(catalogResult.payload, [
    sourceArticle("0000000093840", "Import-Undo geänderter Stand", {
      aliasRows: [{ EAN: "0000000093840", ZweitEAN: newGtin, Rang: 1 }],
      row: { DurchschnittEK: "20" },
    }),
    sourceArticle("0000000093841", "Import-Undo neue Anlage", {
      aliasRows: [{ EAN: "0000000093841", ZweitEAN: createdGtin, Rang: 1 }],
      row: { DurchschnittEK: "30" },
    }),
    sourceArticle("0000000093842", "Import-Undo Quarantänebefund", {
      row: { DurchschnittEK: "-1" },
    }),
  ]);
  assert.equal(batchPreview.response.status, 201, batchPreview.text);
  assert.deepEqual(batchPreview.payload.summary, {
    total: 3,
    create: 1,
    update: 1,
    unchanged: 0,
    blocked: 1,
    identifierCount: 2,
    priceCount: 2 * TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.length,
  });
  const applied = await applyPreview(batchPreview.payload);
  assert.equal(applied.response.status, 201, applied.text);
  assert.match(applied.payload.personalActionId, /^receipt:/);
  const updatedState = currentArticleBusinessState("093840");
  const createdState = currentArticleBusinessState("093841");
  assert.equal(updatedState.currentRevision, 2);
  assert.equal(createdState.currentRevision, 1);
  assert.notDeepEqual(businessValues(updatedState), businessValues(baselineState));
  const originalHistory = immutableImportHistory(applied.payload.snapshotId);

  const ownActions = await requestJson("/api/portal/v1/me/actions?limit=50");
  assert.equal(ownActions.response.status, 200, ownActions.text);
  noStore(ownActions.response);
  const importAction = ownActions.payload.actions.find(
    (entry) => entry.id === applied.payload.personalActionId,
  );
  assert.ok(importAction, ownActions.text);
  assert.equal(importAction.actionType, "sales.article-catalog.import");
  assert.equal(importAction.canUndo, true);
  for (const privateField of ["compensatorKey", "undoPayload", "resultFingerprint", "sourceAuditId"]) {
    assert.equal(Object.hasOwn(importAction, privateField), false, privateField);
  }

  revokeGrant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  const revokedActions = await requestJson("/api/portal/v1/me/actions?limit=50");
  assert.equal(revokedActions.response.status, 200, revokedActions.text);
  const revokedAction = revokedActions.payload.actions.find(
    (entry) => entry.id === applied.payload.personalActionId,
  );
  assert.equal(revokedAction.canUndo, false);
  assert.match(revokedAction.undo.reason, /Importrecht/i);
  const revokedUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(revokedUndo.response.status, 403, revokedUndo.text);
  assert.equal(revokedUndo.payload?.code, "PERSONAL_ACTION_UNDO_PERMISSION_DENIED");
  grant(IMPORTER, SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);

  const beforeFailedUndo = tableCounts();
  db.exec(`
    CREATE TRIGGER test_article_import_undo_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'sales.article-catalog.import.undo'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic article import undo audit failure');
    END
  `);
  const failedUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {} },
  );
  db.exec("DROP TRIGGER test_article_import_undo_audit_failure");
  assert.notEqual(failedUndo.response.status, 200, failedUndo.text);
  assert.deepEqual(tableCounts(), beforeFailedUndo, "Undo-Auditfehler muss jede Gegenrevision zurückrollen");
  assert.equal(currentArticleBusinessState("093840").currentRevision, 2);
  assert.equal(currentArticleBusinessState("093841").currentRevision, 1);
  assert.equal(immutableImportHistory(applied.payload.snapshotId), originalHistory);

  const undone = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(undone.response.status, 200, undone.text);
  assert.deepEqual(undone.payload, {
    undone: true,
    alreadyUndone: false,
    salesArticleImport: {
      snapshotId: applied.payload.snapshotId,
      articleCount: 2,
    },
  });
  const restoredState = currentArticleBusinessState("093840");
  const archivedCreatedState = currentArticleBusinessState("093841");
  assert.equal(restoredState.currentRevision, 3);
  assert.deepEqual(businessValues(restoredState), businessValues(baselineState));
  assert.equal(archivedCreatedState.currentRevision, 2);
  assert.equal(archivedCreatedState.active, 0);
  assert.equal(archivedCreatedState.description, createdState.description);
  assert.notEqual(restoredState.sourceSnapshotId, applied.payload.snapshotId);
  assert.equal(restoredState.sourceSnapshotId, archivedCreatedState.sourceSnapshotId);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?")
      .get(restoredState.productId).count,
    3,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions WHERE product_id = ?")
      .get(archivedCreatedState.productId).count,
    2,
  );
  assert.equal(immutableImportHistory(applied.payload.snapshotId), originalHistory);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM personal_action_receipts
      WHERE actor_id = ? AND compensates_action_id = ?
    `).get(IMPORTER, applied.payload.personalActionId.replace(/^receipt:/, "")).count,
    1,
  );

  const afterUndoCounts = tableCounts();
  const replay = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(replay.response.status, 200, replay.text);
  assert.equal(replay.payload.alreadyUndone, true);
  assert.equal(replay.payload.salesArticleImport.snapshotId, applied.payload.snapshotId);
  assert.equal(replay.payload.salesArticleImport.articleCount, 0);
  assert.deepEqual(tableCounts(), afterUndoCounts, "Ein zweites Undo darf keine weitere Revision erzeugen");
  const actionsAfterUndo = await requestJson("/api/portal/v1/me/actions?limit=50");
  const closedAction = actionsAfterUndo.payload.actions.find(
    (entry) => entry.id === applied.payload.personalActionId,
  );
  assert.equal(closedAction.canUndo, false);
  assert.match(closedAction.undo.reason, /Bereits rückgängig/);
});

test("Import-Undo schließt den gesamten Batch, sobald nur ein Head nachträglich geändert wurde", async () => {
  const catalogResult = await catalog();
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093850", "Undo-Headkonflikt A"),
    sourceArticle("0000000093851", "Undo-Headkonflikt B"),
  ]);
  assert.equal(result.response.status, 201, result.text);
  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  const first = currentArticleBusinessState("093850");
  const second = currentArticleBusinessState("093851");
  await archiveManualArticle({ articleNumber: first.articleNumber, currentRevision: first.currentRevision });
  const before = tableCounts();
  const conflict = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.payload?.code, "PERSONAL_ACTION_UNDO_CONFLICT");
  assert.deepEqual(tableCounts(), before);
  assert.equal(currentArticleBusinessState("093850").currentRevision, 2);
  assert.equal(currentArticleBusinessState("093851").currentRevision, second.currentRevision);
  assert.equal(currentArticleBusinessState("093851").active, 1);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM personal_action_receipts
      WHERE compensates_action_id = ?
    `).get(applied.payload.personalActionId.replace(/^receipt:/, "")).count,
    0,
  );
});

test("Import-Undo meldet Identifier-Eigentümerkonflikte kontrolliert mit 409 und ohne Teilrevision", async () => {
  const catalogResult = await catalog();
  const conflictGtin = ean13("590123412360");
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093860", "Undo-Identifierkonflikt", {
      aliasRows: [{ EAN: "0000000093860", ZweitEAN: conflictGtin, Rang: 1 }],
    }),
  ]);
  assert.equal(result.response.status, 201, result.text);
  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  const imported = currentArticleBusinessState("093860");
  await createManualArticle("UNDO-GTIN-OWNER", "Simulierter konkurrierender Eigentümer");
  const foreignProductId = db.prepare(`
    SELECT product_id AS productId FROM sales_articles WHERE article_number = 'UNDO-GTIN-OWNER'
  `).get().productId;
  const canonical = `0${conflictGtin}`;
  db.exec("DROP TRIGGER trg_sales_article_identifier_owners_immutable_update");
  db.prepare(`
    UPDATE sales_article_identifier_owners SET product_id = ?
    WHERE canonical_gtin14 = ?
  `).run(foreignProductId, canonical);
  const before = tableCounts();
  try {
    const conflict = await requestJson(
      `/api/portal/v1/me/actions/${encodeURIComponent(applied.payload.personalActionId)}/undo`,
      { method: "POST", body: {} },
    );
    assert.equal(conflict.response.status, 409, conflict.text);
    assert.match(conflict.payload?.code || "", /CONFLICT/);
    assert.deepEqual(tableCounts(), before);
    assert.equal(currentArticleBusinessState("093860").currentRevision, 1);
    assert.equal(currentArticleBusinessState("093860").active, 1);
  } finally {
    db.prepare(`
      UPDATE sales_article_identifier_owners SET product_id = ?
      WHERE canonical_gtin14 = ?
    `).run(imported.productId, canonical);
    db.exec(`
      CREATE TRIGGER trg_sales_article_identifier_owners_immutable_update
      BEFORE UPDATE ON sales_article_identifier_owners
      BEGIN
        SELECT RAISE(ABORT, 'sales-article-identifier-owner-immutable');
      END
    `);
  }
});

test("Dateiinterne Duplikate werden zeilenweise quarantänisiert und die unabhängige Teilmenge bleibt importierbar", async () => {
  const catalogResult = await catalog();
  const sharedGtin = "4006381333931";
  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093800", "Doppelter Quellschlüssel A"),
    sourceArticle("0000000093800", "Doppelter Quellschlüssel B"),
    sourceArticle("0000000093801", "Doppelte GTIN A", {
      aliasRows: [{ EAN: "0000000093801", ZweitEAN: sharedGtin, Rang: 1 }],
    }),
    sourceArticle("0000000093802", "Doppelte GTIN B", {
      aliasRows: [{ EAN: "0000000093802", ZweitEAN: sharedGtin, Rang: 1 }],
    }),
    sourceArticle("0000000093803", "Unabhängige sichere Zeile"),
  ]);
  assert.equal(result.response.status, 201, result.text);
  assert.deepEqual(result.payload.summary, {
    total: 5,
    create: 1,
    update: 0,
    unchanged: 0,
    blocked: 4,
    identifierCount: 0,
    priceCount: TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.length,
  });
  assert.equal(result.payload.canApply, true);
  const issueCodes = new Set(result.payload.rows.flatMap((row) => row.issueCodes || []));
  assert.ok(issueCodes.has("duplicate_source_key"), JSON.stringify(result.payload));
  assert.ok(issueCodes.has("duplicate_article_number"), JSON.stringify(result.payload));
  assert.ok(issueCodes.has("duplicate_gtin"), JSON.stringify(result.payload));

  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093803'").get().count,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number IN ('093800','093801','093802')").get().count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_article_import_findings WHERE snapshot_id = ?").get(applied.payload.snapshotId).count,
    6,
  );
});

test("Manuelle und archivierte Heads sowie fremde GTIN-Eigentümer bleiben beim Teilimport unangetastet", async () => {
  const catalogResult = await catalog();
  const manual = await createManualArticle("093790", "Manuell führender Artikel");
  const archivedCreated = await createManualArticle("093791", "Archivierter Artikel");
  const archived = await archiveManualArticle(archivedCreated);
  const identifierOwner = await createManualArticle(
    "MANUAL-GTIN-OWNER",
    "Manueller GTIN-Eigentümer",
    [{ identifierValue: "4006381333931", isPrimary: true }],
  );
  const baseline = {
    manualRevision: manual.currentRevision,
    archivedRevision: archived.currentRevision,
    identifierOwnerRevision: identifierOwner.currentRevision,
  };

  const result = await preview(catalogResult.payload, [
    sourceArticle("0000000093790", "Darf manuellen Head nicht überschreiben"),
    sourceArticle("0000000093791", "Darf Archiv nicht reaktivieren"),
    sourceArticle("0000000093792", "Kollidierende GTIN", {
      aliasRows: [{ EAN: "0000000093792", ZweitEAN: "4006381333931", Rang: 1 }],
    }),
    sourceArticle("0000000093793", "Sicherer Teilimport"),
  ]);
  assert.equal(result.response.status, 201, result.text);
  assert.equal(result.payload.summary.create, 1);
  assert.equal(result.payload.summary.blocked, 3);
  assert.equal(result.payload.canApply, true);
  const issueCodes = new Set(result.payload.rows.flatMap((row) => row.issueCodes || []));
  assert.ok(issueCodes.has("manual_head"), JSON.stringify(result.payload));
  assert.ok(issueCodes.has("archived_head"), JSON.stringify(result.payload));
  assert.ok(issueCodes.has("gtin_conflict"), JSON.stringify(result.payload));

  const applied = await applyPreview(result.payload);
  assert.equal(applied.response.status, 201, applied.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sales_articles WHERE article_number = '093793'").get().count,
    1,
  );
  for (const [articleNumber, expectedRevision, expectedActive, expectedDescription] of [
    ["093790", baseline.manualRevision, 1, "Manuell führender Artikel"],
    ["093791", baseline.archivedRevision, 0, "Archivierter Artikel"],
    ["MANUAL-GTIN-OWNER", baseline.identifierOwnerRevision, 1, "Manueller GTIN-Eigentümer"],
  ]) {
    const current = db.prepare(`
      SELECT article.current_revision AS currentRevision, revision.active, revision.description
      FROM sales_articles article
      JOIN sales_article_revisions revision
        ON revision.product_id = article.product_id
        AND revision.revision = article.current_revision
      WHERE article.article_number = ?
    `).get(articleNumber);
    assert.deepEqual({ ...current }, {
      currentRevision: expectedRevision,
      active: expectedActive,
      description: expectedDescription,
    });
  }
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM sales_article_source_links
      WHERE source_system = 'tradefoto.artikel_stamm'
        AND source_article_key IN ('0000000093790','0000000093791','0000000093792')
    `).get().count,
    0,
  );
});

test("Der reale 18.996/37.412-Bestand bleibt mit vollständig befüllten Preisfeldern vorschaufähig", async () => {
  const catalogResult = await catalog();
  const prices = Object.fromEntries(TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(
    ({ sourceField }) => [sourceField, "1.000000000000"],
  ));
  for (const [grossField, netField] of TRADEFOTO_GROSS_NET_PAIRS) {
    prices[grossField] = "1.200000000000";
    prices[netField] = "1.000000000000";
  }
  const realArticleCount = 18996;
  const realAliasCount = 37412;
  const secondAliasRows = realAliasCount - realArticleCount;
  assert.equal(realArticleCount * 36 + realAliasCount, 721268);
  assert.ok(realArticleCount * 36 + realAliasCount <= catalogResult.payload.maxWorkUnits);
  let articles = Array.from({ length: realArticleCount }, (_, index) => (
    (() => {
      const sourceArticleKey = String(700000 + index).padStart(13, "0");
      const aliasRows = [{
        EAN: sourceArticleKey,
        ZweitEAN: ean13(String(200000000000 + index)),
        Rang: 1,
      }];
      if (index < secondAliasRows) {
        aliasRows.push({
          EAN: sourceArticleKey,
          ZweitEAN: ean13(String(300000000000 + index)),
          Rang: 2,
        });
      }
      return sourceArticle(
        sourceArticleKey,
        `Kapazitätsprüfung ${index + 1}`,
        { row: prices, aliasRows },
      );
    })()
  ));
  let body = JSON.stringify(exchange(catalogResult.payload, articles));
  articles = null;
  assert.ok(Buffer.byteLength(body, "utf8") < catalogResult.payload.maxBytes);
  const before = tableCounts();
  const result = await requestRaw("/api/sales/articles/import/preview", body, {
    fileName: "TradeFoto-Vollbestand-18996.json",
  });
  body = null;
  assert.equal(result.response.status, 201, result.text);
  noStore(result.response);
  assert.deepEqual(result.payload.summary, {
    total: realArticleCount,
    create: realArticleCount,
    update: 0,
    unchanged: 0,
    blocked: 0,
    identifierCount: realAliasCount,
    priceCount: realArticleCount * TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.length,
  });
  assert.equal(result.payload.canApply, true);
  assert.equal(result.payload.truncated, true);
  assert.equal(result.payload.rows.length, 200);
  assert.deepEqual(tableCounts(), before, "Auch die Vollbestandsvorschau bleibt strikt mutationsfrei");
  const cancelled = await requestJson(
    `/api/sales/articles/import/previews/${encodeURIComponent(result.payload.previewId)}`,
    { method: "DELETE" },
  );
  assert.equal(cancelled.response.status, 204, cancelled.text);
});

test("Das 750.000er Arbeitsbudget weist einen synthetischen 25.000-Zeilen-Vollimport früh und mutationsfrei ab", async () => {
  const catalogResult = await catalog();
  const prices = Object.fromEntries(TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(
    ({ sourceField }) => [sourceField, "1.000000000000"],
  ));
  for (const [grossField, netField] of TRADEFOTO_GROSS_NET_PAIRS) {
    prices[grossField] = "1.200000000000";
    prices[netField] = "1.000000000000";
  }
  let articles = Array.from({ length: catalogResult.payload.maxRows }, (_, index) => (
    sourceArticle(
      String(800000 + index).padStart(13, "0"),
      `Budgetprüfung ${index + 1}`,
      { row: prices },
    )
  ));
  let body = JSON.stringify(exchange(catalogResult.payload, articles));
  articles = null;
  assert.ok(Buffer.byteLength(body, "utf8") < catalogResult.payload.maxBytes);
  const before = tableCounts();
  const result = await requestRaw("/api/sales/articles/import/preview", body, {
    fileName: "TradeFoto-Arbeitsbudget-25000.json",
  });
  body = null;
  assert.equal(result.response.status, 413, result.text);
  assert.equal(result.payload?.code, "SALES_ARTICLE_IMPORT_WORK_BUDGET_EXCEEDED");
  assert.deepEqual(tableCounts(), before);
});
