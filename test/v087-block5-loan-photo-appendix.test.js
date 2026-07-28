"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-v087-block5-photo-appendix-"),
);
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";

const {
  app,
  createDatabaseBackupToDirectory,
  db,
  reconcileOrphanAmuBlobs,
  releaseInstanceLockForTests,
  verifyActiveProtectedDocumentBlobs,
} = require("../server");

const LOCATION_ID = "95";
const ADMIN = "v087-b5-admin";
const BORROWER = "v087-b5-borrower";
const OTHER = "v087-b5-other";
const ARTICLE_NUMBER = "975501";
const LOAN_ID = crypto.randomUUID();

let baseUrl;
let httpServer;
let adminSession;
let borrowerSession;
let otherSession;
let organizationSession;

function ensureLocation() {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Block 5 Fotobeilagen', 0, '{}', 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      active = 1
  `).run(LOCATION_ID);
}

function ensureEmployee(employeeNumber, fullName, role) {
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
  `).run(employeeNumber, fullName, fullName.split(" ")[0], LOCATION_ID);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = excluded.role,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createEmployeeSession(employeeNumber) {
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
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function createOverviewOnlyOrganizationSession() {
  const accountId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts
      (id, login_name, display_name, account_type, password_hash, active,
       must_change_password, created_by, updated_by)
    VALUES (?, ?, 'Block 5 Organisationskonto', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `v087-b5-org-${accountId.slice(0, 8)}`);
  db.prepare(`
    INSERT INTO portal_organization_account_permissions
      (account_id, permission, granted_by)
    VALUES (?, 'loans:overview:read', 'test')
  `).run(accountId);
  db.prepare(`
    INSERT INTO portal_organization_account_scopes
      (account_id, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'test')
  `).run(accountId, LOCATION_ID);
  db.prepare(`
    INSERT INTO portal_organization_sessions
      (id, account_id, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    accountId,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function insertOpenLoan() {
  db.prepare(`
    INSERT INTO articles
      (article_number, description, source_provider, active, created_by, updated_by)
    VALUES (?, 'Block-5-Testkamera', 'manual', 1, 'test', 'test')
  `).run(ARTICLE_NUMBER);
  db.prepare(`
    INSERT INTO loans
      (id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, revision)
    VALUES (?, ?, ?, ?, '2099-12-31', 'issued', 'Vertrauliche Testnotiz',
            CURRENT_TIMESTAMP, 1)
  `).run(LOAN_ID, LOCATION_ID, BORROWER, BORROWER);
  db.prepare(`
    INSERT INTO loan_items
      (id, loan_id, position, article_number, description_snapshot, serial_number,
       quantity, condition_out, item_note)
    VALUES (?, ?, 1, ?, 'Block-5-Testkamera', 'B5-COLOR-SECRET', 1, 'good',
            'Interne Block-5-Notiz')
  `).run(crypto.randomUUID(), LOAN_ID, ARTICLE_NUMBER);
}

function settingsPayload(photoPdf) {
  const payload = {
    enabled: true,
    articleLookup: {
      enabled: false,
      provider: "none",
      baseUrl: "",
    },
    documentRecipientEmployeeNumber: "",
    emailDelivery: {
      enabled: false,
      recipient: "",
    },
  };
  if (photoPdf !== undefined) payload.photoPdf = photoPdf;
  return payload;
}

async function requestJson(
  route,
  {
    method = "GET",
    session = borrowerSession,
    body,
  } = {},
) {
  const headers = { Accept: "application/json" };
  const multipart = body instanceof FormData;
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function requestBinary(route, { session = borrowerSession } = {}) {
  const headers = {};
  if (session) headers.Cookie = session.cookie;
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return {
    response,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

async function uploadPhoto(phase, image, filename, mimeType) {
  const form = new FormData();
  form.set("phase", phase);
  form.append("photos", new Blob([image], { type: mimeType }), filename);
  return requestJson(`/api/portal/v1/loans/${LOAN_ID}/photos`, {
    method: "POST",
    session: borrowerSession,
    body: form,
  });
}

function protectedBlobPath(storageKey) {
  return path.join(
    testRoot,
    "app-data",
    "private",
    "amu",
    "blobs",
    ...String(storageKey).split("/"),
  );
}

function assertPdfResponse(result, disposition) {
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("content-type"), "application/pdf");
  assert.match(
    result.response.headers.get("content-disposition") || "",
    new RegExp(`^${disposition};`, "i"),
  );
  assert.equal(
    Number(result.response.headers.get("content-length")),
    result.buffer.length,
  );
  assert.equal(
    result.response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(result.response.headers.get("pragma"), "no-cache");
  assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.buffer.subarray(0, 4).toString("ascii"), "%PDF");
}

async function pdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

test.before(() => {
  ensureLocation();
  assert.equal(
    db.prepare("SELECT 1 FROM loan_location_settings WHERE location_id = ?")
      .get(LOCATION_ID),
    undefined,
    "Der Teststandort muss ohne bestehende Leihmodul-Einstellung starten.",
  );
  ensureEmployee(ADMIN, "Ada Administration", "admin");
  ensureEmployee(BORROWER, "Berta Blockfuenf", "employee");
  ensureEmployee(OTHER, "Olivia Ohne Bezug", "employee");
  adminSession = createEmployeeSession(ADMIN);
  borrowerSession = createEmployeeSession(BORROWER);
  otherSession = createEmployeeSession(OTHER);
  organizationSession = createOverviewOnlyOrganizationSession();
  insertOpenLoan();
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
  fs.rmSync(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("v0.87 Block 5 erzeugt geschützte Foto-PDF-Beilagen mit konfigurierbarer Farbfassungsaufbewahrung", async (t) => {
  let issuePhoto;
  let issueAttachment;
  let secondIssueAttachment;
  let returnPhoto;
  let returnAttachment;

  await t.test("Standardeinstellung und alter PUT-Payload bleiben kompatibel", async () => {
    const initial = await requestJson("/api/portal/v1/loans/settings", {
      session: adminSession,
    });
    assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
    const initialLocation = initial.payload.locations.find(
      (location) => location.locationId === LOCATION_ID,
    );
    assert.ok(initialLocation);
    assert.ok(db.prepare(`
      SELECT 1 FROM schema_migrations
      WHERE id = 'v0.87-loan-photo-pdf-attachments'
    `).get());
    assert.deepEqual(initialLocation.photoPdf, {
      outputMode: "grayscale",
      originalRetention: "retain",
    });

    const legacyUpdate = await requestJson(
      `/api/portal/v1/loans/settings/locations/${LOCATION_ID}`,
      {
        method: "PUT",
        session: adminSession,
        body: settingsPayload(),
      },
    );
    assert.equal(
      legacyUpdate.response.status,
      200,
      JSON.stringify(legacyUpdate.payload),
    );
    assert.deepEqual(legacyUpdate.payload.location.photoPdf, {
      outputMode: "grayscale",
      originalRetention: "retain",
    });
    const stored = db.prepare(`
      SELECT photo_pdf_output_mode, photo_original_retention
      FROM loan_location_settings
      WHERE location_id = ?
    `).get(LOCATION_ID);
    assert.deepEqual({ ...stored }, {
      photo_pdf_output_mode: "grayscale",
      photo_original_retention: "retain",
    });
  });

  await t.test("Ausgabefoto bleibt farbig lesbar und erhält eine Graustufen-PDF-Beilage", async () => {
    const source = await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 3,
        background: { r: 218, g: 42, b: 73 },
      },
    }).png().toBuffer();
    const uploaded = await uploadPhoto("issue", source, "Ausgabe-Farbe.png", "image/png");
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    assert.equal(uploaded.payload.photos.length, 1);
    assert.equal(uploaded.payload.photoAttachments.length, 1);

    issuePhoto = uploaded.payload.photos[0];
    issueAttachment = uploaded.payload.photoAttachments[0];
    assert.equal(issuePhoto.phase, "issue");
    assert.equal(issuePhoto.originalRetained, true);
    assert.equal(issuePhoto.originalDeletedAt, null);
    assert.equal(issuePhoto.originalDeletionReason, "");
    assert.equal(
      issuePhoto.contentUrl,
      `/api/portal/v1/loans/photos/${encodeURIComponent(issuePhoto.id)}`,
    );
    assert.deepEqual(
      {
        phase: issueAttachment.phase,
        revision: issueAttachment.revision,
        sourcePhotoCount: issueAttachment.sourcePhotoCount,
        outputMode: issueAttachment.outputMode,
        originalRetention: issueAttachment.originalRetention,
      },
      {
        phase: "issue",
        revision: 1,
        sourcePhotoCount: 1,
        outputMode: "grayscale",
        originalRetention: "retain",
      },
    );
    assert.match(issueAttachment.filename, /\.pdf$/i);
    assert.equal(
      issueAttachment.previewUrl,
      `/api/portal/v1/loans/photo-attachments/${encodeURIComponent(issueAttachment.id)}/preview`,
    );
    assert.equal(
      issueAttachment.downloadUrl,
      `/api/portal/v1/loans/photo-attachments/${encodeURIComponent(issueAttachment.id)}/download`,
    );

    const photoRow = db.prepare(`
      SELECT storage_key, original_retained
      FROM loan_photos
      WHERE id = ?
    `).get(issuePhoto.id);
    assert.equal(photoRow.original_retained, 1);
    assert.equal(fs.existsSync(protectedBlobPath(photoRow.storage_key)), true);

    const attachmentRow = db.prepare(`
      SELECT storage_key
      FROM loan_photo_attachments
      WHERE id = ?
    `).get(issueAttachment.id);
    assert.equal(fs.existsSync(protectedBlobPath(attachmentRow.storage_key)), true);

    const original = await requestBinary(issuePhoto.contentUrl);
    assert.equal(original.response.status, 200);
    assert.equal(original.response.headers.get("content-type"), "image/jpeg");
    assert.equal(
      original.response.headers.get("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.equal(original.response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(original.buffer.subarray(0, 2).toString("hex"), "ffd8");
    const metadata = await sharp(original.buffer).metadata();
    assert.equal(metadata.format, "jpeg");
    const stats = await sharp(original.buffer).stats();
    const channelMeans = stats.channels.slice(0, 3).map((channel) => channel.mean);
    assert.ok(
      Math.max(...channelMeans) - Math.min(...channelMeans) > 50,
      `Die geschützte Farbfassung muss farbig bleiben: ${channelMeans.join(", ")}`,
    );

    const preview = await requestBinary(issueAttachment.previewUrl);
    assertPdfResponse(preview, "inline");
    const download = await requestBinary(issueAttachment.downloadUrl);
    assertPdfResponse(download, "attachment");

    const deniedEmployee = await requestJson(issueAttachment.previewUrl, {
      session: otherSession,
    });
    assert.equal(deniedEmployee.response.status, 403);
    assert.equal(deniedEmployee.payload.code, "LOAN_PHOTO_ATTACHMENT_DENIED");

    const deniedOrganization = await requestJson(issueAttachment.previewUrl, {
      session: organizationSession,
    });
    assert.equal(deniedOrganization.response.status, 403);
    assert.equal(deniedOrganization.payload.code, "PORTAL_PERMISSION_DENIED");
  });

  await t.test("Weitere Uploads erhalten globale Fotonummern und eine eigene unveränderliche Teilbeilage", async () => {
    const source = await sharp({
      create: {
        width: 720,
        height: 540,
        channels: 3,
        background: { r: 48, g: 128, b: 76 },
      },
    }).jpeg({ quality: 90 }).toBuffer();
    const uploaded = await uploadPhoto(
      "issue",
      source,
      "Ausgabe-Zweite-Aufnahme.jpg",
      "image/jpeg",
    );
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    assert.equal(uploaded.payload.photos.length, 2);
    assert.equal(uploaded.payload.photoAttachments.length, 2);
    secondIssueAttachment = uploaded.payload.photoAttachments[1];
    assert.deepEqual(
      {
        phase: secondIssueAttachment.phase,
        revision: secondIssueAttachment.revision,
        sourcePhotoCount: secondIssueAttachment.sourcePhotoCount,
      },
      { phase: "issue", revision: 2, sourcePhotoCount: 1 },
    );
    const preview = await requestBinary(secondIssueAttachment.previewUrl);
    assertPdfResponse(preview, "inline");
    const text = await pdfText(preview.buffer);
    assert.match(text, /Unveränderliche Teilbeilage dieses Foto-Uploads/);
    assert.match(text, /Foto 2 - Ausgabe-Zweite-Aufnahme\.jpg/);
  });

  await t.test("Schwarzweiß plus Löschen ist validiert und bleibt nach Fehlversuchen aktiv", async () => {
    const updated = await requestJson(
      `/api/portal/v1/loans/settings/locations/${LOCATION_ID}`,
      {
        method: "PUT",
        session: adminSession,
        body: settingsPayload({
          outputMode: "blackwhite",
          originalRetention: "delete",
        }),
      },
    );
    assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
    assert.deepEqual(updated.payload.location.photoPdf, {
      outputMode: "blackwhite",
      originalRetention: "delete",
    });

    const invalidObject = await requestJson(
      `/api/portal/v1/loans/settings/locations/${LOCATION_ID}`,
      {
        method: "PUT",
        session: adminSession,
        body: settingsPayload("ungueltig"),
      },
    );
    assert.equal(invalidObject.response.status, 400);
    assert.equal(invalidObject.payload.code, "LOAN_PHOTO_PDF_SETTINGS_INVALID");

    const invalidMode = await requestJson(
      `/api/portal/v1/loans/settings/locations/${LOCATION_ID}`,
      {
        method: "PUT",
        session: adminSession,
        body: settingsPayload({
          outputMode: "sepia",
          originalRetention: "delete",
        }),
      },
    );
    assert.equal(invalidMode.response.status, 400);
    assert.equal(invalidMode.payload.code, "LOAN_PHOTO_PDF_OUTPUT_MODE_INVALID");

    const invalidRetention = await requestJson(
      `/api/portal/v1/loans/settings/locations/${LOCATION_ID}`,
      {
        method: "PUT",
        session: adminSession,
        body: settingsPayload({
          outputMode: "blackwhite",
          originalRetention: "archive",
        }),
      },
    );
    assert.equal(invalidRetention.response.status, 400);
    assert.equal(
      invalidRetention.payload.code,
      "LOAN_PHOTO_ORIGINAL_RETENTION_INVALID",
    );

    const afterInvalid = await requestJson("/api/portal/v1/loans/settings", {
      session: adminSession,
    });
    assert.equal(afterInvalid.response.status, 200, JSON.stringify(afterInvalid.payload));
    assert.deepEqual(
      afterInvalid.payload.locations.find(
        (location) => location.locationId === LOCATION_ID,
      ).photoPdf,
      {
        outputMode: "blackwhite",
        originalRetention: "delete",
      },
    );
  });

  await t.test("Rückgabefoto wird nach lesbarer Schwarzweiß-Beilage sicher gelöscht", async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 640,
        channels: 3,
        background: { r: 36, g: 164, b: 224 },
      },
    }).jpeg({ quality: 92 }).toBuffer();
    const uploaded = await uploadPhoto("return", source, "Rueckgabe-Farbe.jpg", "image/jpeg");
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    assert.equal(uploaded.payload.photos.length, 1);
    assert.equal(uploaded.payload.photoAttachments.length, 1);

    returnPhoto = uploaded.payload.photos[0];
    returnAttachment = uploaded.payload.photoAttachments[0];
    assert.equal(returnPhoto.phase, "return");
    assert.equal(returnPhoto.originalRetained, false);
    assert.ok(returnPhoto.originalDeletedAt);
    assert.equal(returnPhoto.originalDeletionReason, "pdf_created");
    assert.equal(returnPhoto.contentUrl, null);
    assert.deepEqual(
      {
        phase: returnAttachment.phase,
        revision: returnAttachment.revision,
        sourcePhotoCount: returnAttachment.sourcePhotoCount,
        outputMode: returnAttachment.outputMode,
        originalRetention: returnAttachment.originalRetention,
      },
      {
        phase: "return",
        revision: 1,
        sourcePhotoCount: 1,
        outputMode: "blackwhite",
        originalRetention: "delete",
      },
    );

    const photoRow = db.prepare(`
      SELECT storage_key, original_retained, original_deleted_at,
             original_deletion_reason
      FROM loan_photos
      WHERE id = ?
    `).get(returnPhoto.id);
    assert.equal(photoRow.original_retained, 0);
    assert.ok(photoRow.original_deleted_at);
    assert.equal(photoRow.original_deletion_reason, "pdf_created");
    assert.equal(fs.existsSync(protectedBlobPath(photoRow.storage_key)), false);

    const gone = await requestJson(
      `/api/portal/v1/loans/photos/${encodeURIComponent(returnPhoto.id)}`,
    );
    assert.equal(gone.response.status, 410, JSON.stringify(gone.payload));
    assert.equal(gone.payload.code, "LOAN_PHOTO_ORIGINAL_DELETED");

    const attachmentRow = db.prepare(`
      SELECT storage_key
      FROM loan_photo_attachments
      WHERE id = ?
    `).get(returnAttachment.id);
    assert.equal(fs.existsSync(protectedBlobPath(attachmentRow.storage_key)), true);
    assertPdfResponse(
      await requestBinary(returnAttachment.previewUrl),
      "inline",
    );
    assertPdfResponse(
      await requestBinary(returnAttachment.downloadUrl),
      "attachment",
    );

    const attachmentRows = db.prepare(`
      SELECT phase, attachment_revision, source_photo_count, output_mode,
             original_retention
      FROM loan_photo_attachments
      WHERE loan_id = ?
      ORDER BY CASE phase WHEN 'issue' THEN 0 ELSE 1 END, attachment_revision
    `).all(LOAN_ID).map((row) => ({ ...row }));
    assert.deepEqual(attachmentRows, [
      {
        phase: "issue",
        attachment_revision: 1,
        source_photo_count: 1,
        output_mode: "grayscale",
        original_retention: "retain",
      },
      {
        phase: "issue",
        attachment_revision: 2,
        source_photo_count: 1,
        output_mode: "grayscale",
        original_retention: "retain",
      },
      {
        phase: "return",
        attachment_revision: 1,
        source_photo_count: 1,
        output_mode: "blackwhite",
        original_retention: "delete",
      },
    ]);
    const verified = verifyActiveProtectedDocumentBlobs();
    assert.equal(verified.loanPhotos, 2);
    assert.equal(verified.loanPhotoAttachments, 3);
    assert.equal(reconcileOrphanAmuBlobs().removed, 0);

    const backupDirectory = path.join(testRoot, "block5-backup");
    const backup = createDatabaseBackupToDirectory(
      backupDirectory,
      "block5-test",
      "test",
    );
    assert.equal(backup.verified, true);
    assert.equal(backup.committed, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(
      backupDirectory,
      `${path.basename(backup.path, ".db")}.amu`,
      "manifest.json",
    ), "utf8"));
    const manifestKeys = new Set(manifest.files.map((entry) => entry.storageKey));
    const attachmentStorageKeys = db.prepare(`
      SELECT storage_key FROM loan_photo_attachments WHERE loan_id = ?
    `).all(LOAN_ID).map((row) => row.storage_key);
    assert.equal(attachmentStorageKeys.every((key) => manifestKeys.has(key)), true);
    assert.equal(manifestKeys.has(photoRow.storage_key), false);

    const attachmentBlobPath = protectedBlobPath(attachmentRow.storage_key);
    const parkedAttachmentPath = `${attachmentBlobPath}.missing`;
    fs.renameSync(attachmentBlobPath, parkedAttachmentPath);
    try {
      assert.throws(
        () => createDatabaseBackupToDirectory(
          path.join(testRoot, "block5-backup-missing"),
          "block5-test-missing",
          "test",
        ),
        /nicht gefunden|fehlt/i,
      );
    } finally {
      fs.renameSync(parkedAttachmentPath, attachmentBlobPath);
    }
  });

  await t.test("Offene Block-4-Übersicht gibt weder interne IDs noch Datei-URLs preis", async () => {
    const overview = await requestJson(
      `/api/portal/v1/loans/open-overview?locationId=${LOCATION_ID}`,
      { session: borrowerSession },
    );
    assert.equal(overview.response.status, 200, JSON.stringify(overview.payload));
    assert.equal(overview.payload.total, 1);
    assert.deepEqual(
      Object.keys(overview.payload.items[0]).sort(),
      ["articleNumber", "description", "dueDate", "serialNumber"].sort(),
    );
    const serialized = JSON.stringify(overview.payload);
    for (const secret of [
      LOAN_ID,
      issuePhoto.id,
      issueAttachment.id,
      secondIssueAttachment.id,
      returnPhoto.id,
      returnAttachment.id,
      "/api/",
      "previewUrl",
      "downloadUrl",
      "photoAttachments",
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `Die minimierte Übersicht enthält unerwartet: ${secret}`,
      );
    }
  });

  await t.test("Foto- und Beilagenhistorie bleibt unveränderlich", () => {
    assert.throws(
      () => db.prepare(`
        UPDATE loan_photo_attachments SET filename = 'Geaendert.pdf' WHERE id = ?
      `).run(issueAttachment.id),
      /loan photo attachments are immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM loan_photo_attachments WHERE id = ?")
        .run(issueAttachment.id),
      /loan photo attachments are immutable/,
    );
    assert.throws(
      () => db.prepare(`
        UPDATE loan_photos SET filename = 'Geaendert.jpg' WHERE id = ?
      `).run(issuePhoto.id),
      /loan photos are immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM loan_photos WHERE id = ?").run(issuePhoto.id),
      /loan photos are immutable/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO loan_photos
          (id, loan_id, phase, position, storage_key, filename, byte_size, sha256,
           pixel_width, pixel_height, original_retained)
        VALUES (?, ?, 'issue', 3, ?, 'Widerspruch.jpg', 10, ?, 10, 10, 0)
      `).run(
        crypto.randomUUID(),
        LOAN_ID,
        `zz/${crypto.randomUUID()}.amu`,
        "c".repeat(64),
      ),
      /loan photo retention state is invalid/,
    );
  });
});
