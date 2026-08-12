"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");
const {
  BranchOrderCleanupError,
  cleanupOrders,
  createManifest,
} = require("../scripts/cleanup-branch-order-test-data");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "cleanup-branch-order-test-data.js");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function runCli(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ...result,
    payload: result.status === 0 && result.stdout.trim()
      ? JSON.parse(result.stdout)
      : null,
  };
}

function createFixture(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE branch_order_location_settings (location_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
    CREATE TABLE branch_order_recipients (id TEXT PRIMARY KEY, location_id TEXT NOT NULL);
    CREATE TABLE branch_order_groups (id TEXT PRIMARY KEY, location_id TEXT NOT NULL);
    CREATE TABLE branch_order_items (id TEXT PRIMARY KEY, group_id TEXT NOT NULL);
    CREATE TABLE branch_orders (
      id TEXT PRIMARY KEY,
      submitted_at TEXT NOT NULL,
      pdf_content BLOB
    );
    CREATE TABLE branch_order_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES branch_orders(id) ON DELETE CASCADE,
      item_title TEXT NOT NULL
    );
    CREATE TABLE branch_order_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES branch_orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );
    CREATE TABLE branch_order_drafts (id TEXT PRIMARY KEY, location_id TEXT NOT NULL);
    CREATE TABLE branch_order_draft_lines (
      draft_id TEXT NOT NULL REFERENCES branch_order_drafts(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      PRIMARY KEY(draft_id, item_id)
    );
    CREATE TABLE maintenance_cleanup_receipts (
      operation_id TEXT PRIMARY KEY,
      cleanup_kind TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO branch_order_location_settings VALUES ('18', '2031-03-11T16:00:00.000Z');
    INSERT INTO branch_order_recipients VALUES ('recipient-1', '18');
    INSERT INTO branch_order_groups VALUES ('group-1', '18');
    INSERT INTO branch_order_items VALUES ('item-1', 'group-1');
  `);
  const insertOrder = database.prepare(`
    INSERT INTO branch_orders (id, submitted_at, pdf_content) VALUES (?, ?, ?)
  `);
  const insertLine = database.prepare(`
    INSERT INTO branch_order_lines (id, order_id, item_title) VALUES (?, ?, ?)
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO branch_order_deliveries (id, order_id, status) VALUES (?, ?, 'sent')
  `);
  for (const [index, orderId] of ["demo-order-a", "demo-order-b"].entries()) {
    insertOrder.run(orderId, `2031-03-11T1${index}:00:00.000Z`, Buffer.from(`pdf-${orderId}`));
    insertLine.run(`line-${orderId}`, orderId, `Position ${index + 1}`);
    insertDelivery.run(`delivery-${orderId}`, orderId);
  }
  database.close();
}

function insertUnmanifestedData(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare(`
    INSERT INTO branch_orders (id, submitted_at, pdf_content) VALUES (?, ?, ?)
  `).run("real-order-new", "2031-03-11T18:30:00.000Z", Buffer.from("real-pdf"));
  database.prepare(`
    INSERT INTO branch_order_lines (id, order_id, item_title) VALUES (?, ?, ?)
  `).run("line-real-order-new", "real-order-new", "Echte Position");
  database.prepare(`
    INSERT INTO branch_order_deliveries (id, order_id, status) VALUES (?, ?, 'sent')
  `).run("delivery-real-order-new", "real-order-new");
  database.prepare("INSERT INTO branch_order_drafts VALUES ('draft-new', '18')").run();
  database.prepare("INSERT INTO branch_order_draft_lines VALUES ('draft-new', 'item-1')").run();
  database.close();
}

test("v0.92 Maintenance-CLI löscht nur exakt manifestierte Testbestellungen", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branch-order-cleanup-"));
  const databasePath = path.join(temporaryRoot, "dienstplan.db");
  const manifestPath = path.join(temporaryRoot, "branch-order-cleanup-manifest.json");
  const tamperedManifestPath = path.join(temporaryRoot, "branch-order-cleanup-manifest-tampered.json");
  const receiptPath = path.join(temporaryRoot, "branch-order-cleanup-receipt.json");
  const retryReceiptPath = path.join(temporaryRoot, "branch-order-cleanup-retry-receipt.json");
  const blockedReceiptPath = path.join(temporaryRoot, "branch-order-cleanup-blocked-receipt.json");
  try {
    createFixture(databasePath);

    const created = runCli([
      "--database", databasePath,
      "--create-manifest", manifestPath,
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.payload.status, "manifest-created");
    assert.equal(created.payload.orderCount, 2);
    assert.match(created.payload.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(created.payload.requiredConfirmToken, /^DELETE-BRANCH-ORDER-TEST-DATA-v1-[a-f0-9]{16}$/);
    const manifestBytes = fs.readFileSync(manifestPath);
    assert.equal(created.payload.manifestSha256, sha256(manifestBytes));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.deepEqual(manifest.orderIds, ["demo-order-a", "demo-order-b"]);
    assert.equal(manifest.orderCount, manifest.orderIds.length);

    insertUnmanifestedData(databasePath);

    const appLock = acquireDatabaseLock({
      databasePath,
      kind: "app",
      appVersion: "cleanup-lock-test",
    });
    try {
      const lockedApply = runCli([
        "--database", databasePath,
        "--manifest", manifestPath,
        "--manifest-sha256", created.payload.manifestSha256,
        "--apply",
        "--confirm", created.payload.requiredConfirmToken,
        "--receipt", blockedReceiptPath,
      ]);
      assert.notEqual(lockedApply.status, 0);
      assert.match(lockedApply.stderr, /BRANCH_ORDER_CLEANUP_DATABASE_IN_USE/);
      assert.equal(fs.existsSync(blockedReceiptPath), false);
      const lockedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(lockedDatabase.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count, 3);
      lockedDatabase.close();
    } finally {
      assert.equal(releaseDatabaseLock(appLock), true);
    }

    const relativeDenied = runCli([
      "--database", "dienstplan.db",
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
    ], temporaryRoot);
    assert.notEqual(relativeDenied.status, 0);
    assert.match(relativeDenied.stderr, /BRANCH_ORDER_CLEANUP_PATH_INVALID/);

    const wrongHash = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", "0".repeat(64),
    ]);
    assert.notEqual(wrongHash.status, 0);
    assert.match(wrongHash.stderr, /BRANCH_ORDER_CLEANUP_MANIFEST_HASH_MISMATCH/);

    const tampered = { ...manifest, orderCount: 3 };
    fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const tamperedBytes = fs.readFileSync(tamperedManifestPath);
    const tamperedDenied = runCli([
      "--database", databasePath,
      "--manifest", tamperedManifestPath,
      "--manifest-sha256", sha256(tamperedBytes),
    ]);
    assert.notEqual(tamperedDenied.status, 0);
    assert.match(tamperedDenied.stderr, /BRANCH_ORDER_CLEANUP_MANIFEST_INVALID/);

    const dryRun = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(dryRun.payload.status, "dry-run");
    assert.equal(dryRun.payload.dryRun, true);
    assert.deepEqual(dryRun.payload.targets, {
      orders: 2,
      lines: 2,
      deliveries: 2,
      missingOrderIds: [],
    });
    assert.equal(dryRun.payload.unmanifestedOrdersPreserved, 1);
    assert.match(dryRun.payload.preservedTableSha256.branch_order_location_settings, /^[a-f0-9]{64}$/);
    assert.equal(dryRun.payload.unmanifestedRecords.branch_orders.count, 1);
    assert.equal(dryRun.payload.unmanifestedRecords.branch_order_lines.count, 1);
    assert.equal(dryRun.payload.unmanifestedRecords.branch_order_deliveries.count, 1);
    assert.equal(fs.existsSync(receiptPath), false);

    let database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count, 3);
    database.close();

    const wrongConfirmation = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
      "--apply",
      "--confirm", "DELETE-BRANCH-ORDER-TEST-DATA-v1-wrong",
      "--receipt", receiptPath,
    ]);
    assert.notEqual(wrongConfirmation.status, 0);
    assert.match(wrongConfirmation.stderr, /BRANCH_ORDER_CLEANUP_CONFIRMATION_INVALID/);
    assert.equal(fs.existsSync(receiptPath), false);

    const applied = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
      "--apply",
      "--confirm", created.payload.requiredConfirmToken,
      "--receipt", receiptPath,
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.payload.status, "applied");
    assert.deepEqual(applied.payload.deleted, { orders: 2, lines: 2, deliveries: 2 });
    assert.equal(applied.payload.preserved.unmanifestedOrders, 1);
    assert.equal(applied.payload.preserved.tables.branch_order_drafts, 1);
    assert.deepEqual(applied.payload.preserved.tableSha256, dryRun.payload.preservedTableSha256);
    assert.deepEqual(applied.payload.preserved.unmanifestedRecords, dryRun.payload.unmanifestedRecords);
    assert.equal(applied.payload.integrity, "ok");
    assert.equal(applied.payload.foreignKeyViolations, 0);
    assert.match(applied.payload.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(receiptPath), true);

    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.receiptSha256, applied.payload.receiptSha256);
    assert.equal(receipt.manifestSha256, created.payload.manifestSha256);

    let receiptDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const internalReceipt = receiptDatabase.prepare(`
      SELECT receipt_json, receipt_sha256 FROM maintenance_cleanup_receipts
      WHERE manifest_sha256 = ?
    `).get(created.payload.manifestSha256);
    assert.equal(internalReceipt.receipt_json, fs.readFileSync(receiptPath, "utf8"));
    assert.equal(internalReceipt.receipt_sha256, applied.payload.receiptSha256);
    receiptDatabase.close();

    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      database.prepare("SELECT id FROM branch_orders ORDER BY id").all().map((row) => row.id),
      ["real-order-new"],
    );
    assert.deepEqual(
      database.prepare("SELECT order_id FROM branch_order_lines ORDER BY order_id").all().map((row) => row.order_id),
      ["real-order-new"],
    );
    assert.deepEqual(
      database.prepare("SELECT order_id FROM branch_order_deliveries ORDER BY order_id").all().map((row) => row.order_id),
      ["real-order-new"],
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_location_settings").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_recipients").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_groups").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_items").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_drafts").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_draft_lines").get().count, 1);
    assert.deepEqual({ ...database.prepare("SELECT * FROM branch_order_location_settings").get() }, {
      location_id: "18",
      updated_at: "2031-03-11T16:00:00.000Z",
    });
    assert.deepEqual({ ...database.prepare("SELECT * FROM branch_order_recipients").get() }, {
      id: "recipient-1",
      location_id: "18",
    });
    assert.deepEqual({ ...database.prepare("SELECT * FROM branch_order_drafts").get() }, {
      id: "draft-new",
      location_id: "18",
    });
    assert.equal(
      Buffer.from(database.prepare("SELECT pdf_content FROM branch_orders WHERE id = 'real-order-new'").get().pdf_content).toString("utf8"),
      "real-pdf",
    );
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    database.close();

    database = new DatabaseSync(databasePath);
    database.prepare(`
      INSERT INTO branch_orders (id, submitted_at, pdf_content) VALUES (?, ?, ?)
    `).run("real-order-after-apply", "2031-03-11T19:00:00.000Z", Buffer.from("later-pdf"));
    database.close();

    const retried = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
      "--apply",
      "--confirm", created.payload.requiredConfirmToken,
      "--receipt", retryReceiptPath,
    ]);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(retried.payload.status, "already-applied");
    assert.equal(retried.payload.alreadyApplied, true);
    assert.equal(retried.payload.operationId, applied.payload.operationId);
    assert.deepEqual(fs.readFileSync(retryReceiptPath), fs.readFileSync(receiptPath));
    receiptDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(receiptDatabase.prepare("SELECT COUNT(*) AS count FROM maintenance_cleanup_receipts").get().count, 1);
    assert.deepEqual(
      receiptDatabase.prepare("SELECT id FROM branch_orders ORDER BY id").all().map((row) => row.id),
      ["real-order-after-apply", "real-order-new"],
    );
    receiptDatabase.close();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("v0.92 Cleanup rolls back every change when preserved data is mutated", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branch-order-cleanup-rollback-"));
  const databasePath = path.join(temporaryRoot, "dienstplan.db");
  const manifestPath = path.join(temporaryRoot, "branch-order-cleanup-manifest.json");
  const receiptPath = path.join(temporaryRoot, "branch-order-cleanup-receipt.json");
  try {
    createFixture(databasePath);
    const created = runCli([
      "--database", databasePath,
      "--create-manifest", manifestPath,
    ]);
    assert.equal(created.status, 0, created.stderr);
    insertUnmanifestedData(databasePath);

    let database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER cleanup_must_detect_preserved_mutation
      AFTER DELETE ON branch_orders
      BEGIN
        UPDATE branch_order_location_settings SET updated_at = 'tampered';
        UPDATE branch_orders SET pdf_content = X'74616d7065726564' WHERE id = 'real-order-new';
      END;
    `);
    database.close();

    const applied = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.payload.manifestSha256,
      "--apply",
      "--confirm", created.payload.requiredConfirmToken,
      "--receipt", receiptPath,
    ]);
    assert.notEqual(applied.status, 0);
    assert.match(applied.stderr, /BRANCH_ORDER_CLEANUP_PRESERVED_DATA_CHANGED/);
    assert.equal(fs.existsSync(receiptPath), false);

    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_lines").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_order_deliveries").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM maintenance_cleanup_receipts").get().count, 0);
    assert.equal(
      database.prepare("SELECT updated_at FROM branch_order_location_settings WHERE location_id = '18'").get().updated_at,
      "2031-03-11T16:00:00.000Z",
    );
    assert.equal(
      Buffer.from(database.prepare("SELECT pdf_content FROM branch_orders WHERE id = 'real-order-new'").get().pdf_content).toString("utf8"),
      "real-pdf",
    );
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    database.close();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("v0.92 Cleanup keeps an atomic receipt when the post-commit export fails", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branch-order-cleanup-export-"));
  const databasePath = path.join(temporaryRoot, "dienstplan.db");
  const manifestPath = path.join(temporaryRoot, "branch-order-cleanup-manifest.json");
  const failedReceiptPath = path.join(temporaryRoot, "failed-receipt.json");
  const recoveredReceiptPath = path.join(temporaryRoot, "recovered-receipt.json");
  try {
    createFixture(databasePath);
    const created = createManifest({ databasePath, manifestPath });
    insertUnmanifestedData(databasePath);

    let failure = null;
    try {
      cleanupOrders({
        databasePath,
        manifestPath,
        manifestSha256: created.manifestSha256,
        apply: true,
        confirm: created.requiredConfirmToken,
        receiptPath: failedReceiptPath,
        writeReceiptExport() {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof BranchOrderCleanupError);
    assert.equal(failure.code, "BRANCH_ORDER_CLEANUP_APPLIED_RECEIPT_EXPORT_FAILED");
    assert.equal(failure.applied, true);
    assert.match(failure.operationId, /^[a-f0-9-]{36}$/);
    assert.match(failure.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(failedReceiptPath), false);

    let database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      database.prepare("SELECT id FROM branch_orders ORDER BY id").all().map((row) => row.id),
      ["real-order-new"],
    );
    const internalReceipt = database.prepare(`
      SELECT operation_id, receipt_json, receipt_sha256
      FROM maintenance_cleanup_receipts
      WHERE manifest_sha256 = ?
    `).get(created.manifestSha256);
    assert.equal(internalReceipt.operation_id, failure.operationId);
    assert.equal(internalReceipt.receipt_sha256, failure.receiptSha256);
    database.close();

    const recovered = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.manifestSha256,
      "--export-receipt-from-db",
      "--receipt", recoveredReceiptPath,
    ]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.payload.status, "receipt-exported");
    assert.equal(recovered.payload.operationId, failure.operationId);
    assert.equal(recovered.payload.receiptSha256, failure.receiptSha256);
    assert.equal(fs.readFileSync(recoveredReceiptPath, "utf8"), internalReceipt.receipt_json);
    const recoveredReceipt = JSON.parse(fs.readFileSync(recoveredReceiptPath, "utf8"));
    assert.equal(recoveredReceipt.receiptSha256, failure.receiptSha256);

    const overwriteDenied = runCli([
      "--database", databasePath,
      "--manifest", manifestPath,
      "--manifest-sha256", created.manifestSha256,
      "--export-receipt-from-db",
      "--receipt", recoveredReceiptPath,
    ]);
    assert.notEqual(overwriteDenied.status, 0);
    assert.match(overwriteDenied.stderr, /BRANCH_ORDER_CLEANUP_OUTPUT_EXISTS/);

    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM maintenance_cleanup_receipts").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count, 1);
    database.close();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("v0.92 Cleanup rejects a manifest replacement between read and verification", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branch-order-cleanup-manifest-race-"));
  const databasePath = path.join(temporaryRoot, "dienstplan.db");
  const manifestPath = path.join(temporaryRoot, "branch-order-cleanup-manifest.json");
  try {
    createFixture(databasePath);
    const created = createManifest({ databasePath, manifestPath });
    let failure = null;
    try {
      cleanupOrders({
        databasePath,
        manifestPath,
        manifestSha256: created.manifestSha256,
        manifestReadHook() {
          fs.appendFileSync(manifestPath, " ", "utf8");
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof BranchOrderCleanupError);
    assert.equal(failure.code, "BRANCH_ORDER_CLEANUP_MANIFEST_CHANGED");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM maintenance_cleanup_receipts").get().count, 0);
    database.close();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
