"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");

const MANIFEST_FORMAT = "grabenplaner-branch-order-cleanup-manifest";
const RECEIPT_FORMAT = "grabenplaner-branch-order-cleanup-receipt";
const CLEANUP_KIND = "branch-order-test-data";
const SCHEMA_VERSION = 1;
const REQUIRED_TABLES = Object.freeze([
  "branch_order_location_settings",
  "branch_order_recipients",
  "branch_order_groups",
  "branch_order_items",
  "branch_orders",
  "branch_order_lines",
  "branch_order_deliveries",
  "maintenance_cleanup_receipts",
]);
const PRESERVED_TABLES = Object.freeze([
  "branch_order_location_settings",
  "branch_order_recipients",
  "branch_order_groups",
  "branch_order_items",
  "branch_order_drafts",
  "branch_order_draft_lines",
]);

class BranchOrderCleanupError extends Error {
  constructor(message, code = "BRANCH_ORDER_CLEANUP_INVALID", properties = {}) {
    super(message);
    this.name = "BranchOrderCleanupError";
    this.code = code;
    Object.assign(this, properties);
  }
}

function cleanupError(message, code, properties = {}) {
  return new BranchOrderCleanupError(message, code, properties);
}

function acquireMaintenanceDatabaseLock(databasePath) {
  try {
    return acquireDatabaseLock({
      databasePath,
      kind: "app",
      appVersion: "branch-order-cleanup-v1",
    });
  } catch (error) {
    if (error?.code === "DATABASE_IN_USE") {
      throw cleanupError(
        "Die Datenbank wird von Grabenplaner oder einem Backup verwendet. Vor dem Cleanup muss der Dienst kontrolliert gestoppt sein.",
        "BRANCH_ORDER_CLEANUP_DATABASE_IN_USE",
      );
    }
    throw error;
  }
}

function releaseMaintenanceDatabaseLock(handle) {
  if (!handle) return;
  let released = false;
  try {
    released = releaseDatabaseLock(handle);
  } finally {
    if (!released) {
      try { handle.lockDatabase?.exec("ROLLBACK"); } catch {}
      try { handle.lockDatabase?.close(); } catch {}
    }
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readManifestSecure(manifestPath, afterRead = null) {
  let fileDescriptor = null;
  try {
    const pathBefore = fs.lstatSync(manifestPath, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw cleanupError("Der Manifestpfad muss eine regulaere Datei ohne Verknuepfung sein.", "BRANCH_ORDER_CLEANUP_PATH_INVALID");
    }
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    fileDescriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | noFollow);
    const descriptorBefore = fs.fstatSync(fileDescriptor, { bigint: true });
    if (!descriptorBefore.isFile() || !sameFileIdentity(pathBefore, descriptorBefore)) {
      throw cleanupError("Das Cleanup-Manifest wurde beim Oeffnen ausgetauscht.", "BRANCH_ORDER_CLEANUP_MANIFEST_CHANGED");
    }
    if (descriptorBefore.size > 32n * 1024n * 1024n) {
      throw cleanupError("Das Cleanup-Manifest ist unerwartet gross.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
    }
    const bytes = fs.readFileSync(fileDescriptor);
    if (typeof afterRead === "function") afterRead();
    const descriptorAfter = fs.fstatSync(fileDescriptor, { bigint: true });
    const pathAfter = fs.lstatSync(manifestPath, { bigint: true });
    const realPathAfter = fs.realpathSync(manifestPath);
    if (!sameFileIdentity(descriptorBefore, descriptorAfter)
      || !sameFileIdentity(descriptorAfter, pathAfter)
      || pathAfter.isSymbolicLink()
      || comparablePath(realPathAfter) !== comparablePath(manifestPath)
      || BigInt(bytes.length) !== descriptorAfter.size) {
      throw cleanupError("Das Cleanup-Manifest wurde waehrend des Lesens veraendert.", "BRANCH_ORDER_CLEANUP_MANIFEST_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof BranchOrderCleanupError) throw error;
    throw cleanupError("Das Cleanup-Manifest konnte nicht stabil gelesen werden.", "BRANCH_ORDER_CLEANUP_MANIFEST_CHANGED");
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
}

function orderIdsSha256(orderIds) {
  return sha256(Buffer.from(`${orderIds.join("\n")}\n`, "utf8"));
}

function requiredConfirmToken(manifestSha256) {
  return `DELETE-BRANCH-ORDER-TEST-DATA-v1-${manifestSha256.slice(0, 16)}`;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedAbsolutePath(value, label, { mustExist = true, rejectLink = false } = {}) {
  const source = String(value || "").trim();
  if (!source || !path.isAbsolute(source)) {
    throw cleanupError(`${label} muss als absoluter Pfad angegeben werden.`, "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  const resolved = path.resolve(source);
  if (!mustExist) return resolved;
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw cleanupError(`${label} wurde nicht gefunden.`, "BRANCH_ORDER_CLEANUP_PATH_MISSING");
  }
  if (!stat.isFile() || (rejectLink && stat.isSymbolicLink())) {
    throw cleanupError(`${label} muss eine reguläre Datei sein.`, "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  const real = fs.realpathSync(resolved);
  if (rejectLink && comparablePath(real) !== comparablePath(resolved)) {
    throw cleanupError(`${label} darf keine Dateiverknüpfung sein.`, "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  return real;
}

function existingDirectory(value, label) {
  const source = String(value || "").trim();
  if (!source || !path.isAbsolute(source)) {
    throw cleanupError(`${label} muss als absoluter Pfad angegeben werden.`, "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  const resolved = path.resolve(source);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw cleanupError(`${label} wurde nicht gefunden.`, "BRANCH_ORDER_CLEANUP_PATH_MISSING");
  }
  if (!stat.isDirectory()) {
    throw cleanupError(`${label} muss ein Verzeichnis sein.`, "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  return fs.realpathSync(resolved);
}

function newOutputPath(value, label) {
  const candidate = normalizedAbsolutePath(value, label, { mustExist: false });
  const directory = existingDirectory(path.dirname(candidate), `${label}: Verzeichnis`);
  const outputPath = path.join(directory, path.basename(candidate));
  if (fs.existsSync(outputPath)) {
    throw cleanupError(`${label} existiert bereits.`, "BRANCH_ORDER_CLEANUP_OUTPUT_EXISTS");
  }
  return outputPath;
}

function writeJsonExclusive(filePath, value) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { output, sha256: sha256(Buffer.from(output, "utf8")) };
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function writeBytesExclusiveFsync(filePath, content) {
  let fileDescriptor = null;
  try {
    fileDescriptor = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, content);
    fs.fsyncSync(fileDescriptor);
  } catch (error) {
    if (fileDescriptor !== null) {
      try { fs.closeSync(fileDescriptor); } catch {}
      fileDescriptor = null;
      try { fs.unlinkSync(filePath); } catch {}
    }
    throw error;
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
}

function parseArguments(argv) {
  const values = new Map();
  let apply = false;
  let exportReceiptFromDatabase = false;
  const valueOptions = new Set([
    "--database",
    "--manifest",
    "--manifest-sha256",
    "--confirm",
    "--receipt",
    "--create-manifest",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) throw cleanupError("--apply wurde mehrfach angegeben.", "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID");
      apply = true;
      continue;
    }
    if (argument === "--export-receipt-from-db") {
      if (exportReceiptFromDatabase) {
        throw cleanupError("--export-receipt-from-db wurde mehrfach angegeben.", "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID");
      }
      exportReceiptFromDatabase = true;
      continue;
    }
    if (!valueOptions.has(argument) || values.has(argument)) {
      throw cleanupError(`Unbekannte oder doppelte Option: ${argument}`, "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID");
    }
    const value = String(argv[index + 1] || "").trim();
    if (!value || value.startsWith("--")) {
      throw cleanupError(`Für ${argument} fehlt ein Wert.`, "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID");
    }
    values.set(argument, value);
    index += 1;
  }
  return {
    apply,
    exportReceiptFromDatabase,
    databasePath: values.get("--database") || "",
    manifestPath: values.get("--manifest") || "",
    manifestSha256: values.get("--manifest-sha256") || "",
    confirm: values.get("--confirm") || "",
    receiptPath: values.get("--receipt") || "",
    createManifestPath: values.get("--create-manifest") || "",
  };
}

function tableNames(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => String(row.name)));
}

function assertRequiredSchema(database) {
  const available = tableNames(database);
  const missing = REQUIRED_TABLES.filter((table) => !available.has(table));
  if (missing.length) {
    throw cleanupError(
      `Erforderliche Filialbestellungs-Tabellen fehlen: ${missing.join(", ")}`,
      "BRANCH_ORDER_CLEANUP_SCHEMA_INVALID",
    );
  }
  return available;
}

function databaseIntegrity(database) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  const integrity = integrityRows.map((row) => String(Object.values(row)[0] || ""));
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (integrity.length !== 1 || integrity[0].toLowerCase() !== "ok" || foreignKeyViolations.length) {
    throw cleanupError(
      "Die SQLite-Integritätsprüfung ist fehlgeschlagen.",
      "BRANCH_ORDER_CLEANUP_INTEGRITY_FAILED",
    );
  }
  return { integrity: "ok", foreignKeyViolations: 0 };
}

function allOrderIds(database) {
  return database.prepare("SELECT id FROM branch_orders").all()
    .map((row) => String(row.id))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function fingerprintRows(database, sql, include = () => true) {
  const digest = crypto.createHash("sha256");
  let count = 0;
  for (const row of database.prepare(sql).iterate()) {
    if (!include(row)) continue;
    const serialized = JSON.stringify(row, (_key, value) => {
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { type: "blob", base64: Buffer.from(value).toString("base64") };
      }
      if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
      return value;
    });
    digest.update(`${Buffer.byteLength(serialized, "utf8")}:`, "utf8");
    digest.update(serialized, "utf8");
    digest.update("\n", "utf8");
    count += 1;
  }
  return { count, sha256: digest.digest("hex") };
}

function preservedTableState(database, availableTables = tableNames(database)) {
  return Object.fromEntries(PRESERVED_TABLES
    .filter((table) => availableTables.has(table))
    .map((table) => [table, fingerprintRows(database, `SELECT * FROM ${table} ORDER BY rowid`)]));
}

function countsFromState(state) {
  return Object.fromEntries(Object.entries(state).map(([table, value]) => [table, value.count]));
}

function hashesFromState(state) {
  return Object.fromEntries(Object.entries(state).map(([table, value]) => [table, value.sha256]));
}

function unmanifestedRecordState(database, orderIds) {
  const targets = new Set(orderIds);
  return {
    branch_orders: fingerprintRows(
      database,
      "SELECT * FROM branch_orders ORDER BY id",
      (row) => !targets.has(String(row.id)),
    ),
    branch_order_lines: fingerprintRows(
      database,
      "SELECT * FROM branch_order_lines ORDER BY id",
      (row) => !targets.has(String(row.order_id)),
    ),
    branch_order_deliveries: fingerprintRows(
      database,
      "SELECT * FROM branch_order_deliveries ORDER BY id",
      (row) => !targets.has(String(row.order_id)),
    ),
  };
}

function targetCounts(database, orderIds) {
  const order = database.prepare("SELECT 1 AS present FROM branch_orders WHERE id = ?");
  const lines = database.prepare("SELECT COUNT(*) AS count FROM branch_order_lines WHERE order_id = ?");
  const deliveries = database.prepare("SELECT COUNT(*) AS count FROM branch_order_deliveries WHERE order_id = ?");
  const missingOrderIds = [];
  let lineCount = 0;
  let deliveryCount = 0;
  for (const orderId of orderIds) {
    if (!order.get(orderId)?.present) missingOrderIds.push(orderId);
    lineCount += Number(lines.get(orderId).count || 0);
    deliveryCount += Number(deliveries.get(orderId).count || 0);
  }
  return {
    orders: orderIds.length - missingOrderIds.length,
    lines: lineCount,
    deliveries: deliveryCount,
    missingOrderIds,
  };
}

function databaseSnapshot(database, orderIds) {
  const availableTables = assertRequiredSchema(database);
  const integrity = databaseIntegrity(database);
  const ids = allOrderIds(database);
  const targets = targetCounts(database, orderIds);
  if (targets.missingOrderIds.length) {
    throw cleanupError(
      `Manifestierte Bestellungen fehlen: ${targets.missingOrderIds.join(", ")}`,
      "BRANCH_ORDER_CLEANUP_TARGET_MISMATCH",
    );
  }
  const preservedState = preservedTableState(database, availableTables);
  return {
    totalOrders: ids.length,
    unmanifestedOrders: ids.length - orderIds.length,
    targets,
    preservedTableCounts: countsFromState(preservedState),
    preservedTableState: preservedState,
    unmanifestedRecordState: unmanifestedRecordState(database, orderIds),
    ...integrity,
  };
}

function validateManifest(value, databasePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== MANIFEST_FORMAT || value.schemaVersion !== SCHEMA_VERSION) {
    throw cleanupError("Das Cleanup-Manifest hat ein ungültiges Format.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  if (!path.isAbsolute(String(value.databasePath || ""))
    || comparablePath(String(value.databasePath)) !== comparablePath(databasePath)) {
    throw cleanupError(
      "Das Cleanup-Manifest ist nicht an diese Datenbank gebunden.",
      "BRANCH_ORDER_CLEANUP_DATABASE_MISMATCH",
    );
  }
  if (!Array.isArray(value.orderIds) || !value.orderIds.length || value.orderIds.length > 100000) {
    throw cleanupError("Das Cleanup-Manifest enthält keine gültige Bestellliste.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  const orderIds = value.orderIds.map((entry) => String(entry || "").trim());
  if (orderIds.some((id) => !/^[A-Za-z0-9._:-]{1,160}$/.test(id))) {
    throw cleanupError("Das Cleanup-Manifest enthält eine ungültige Bestell-ID.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  const sorted = [...orderIds].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(orderIds).size !== orderIds.length || JSON.stringify(orderIds) !== JSON.stringify(sorted)
    || Number(value.orderCount) !== orderIds.length
    || String(value.orderIdsSha256 || "") !== orderIdsSha256(orderIds)) {
    throw cleanupError(
      "Anzahl, Reihenfolge oder SHA-256 der manifestierten Bestell-IDs stimmt nicht.",
      "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID",
    );
  }
  if (!Number.isFinite(new Date(value.createdAt).getTime())) {
    throw cleanupError("Der Manifestzeitpunkt ist ungültig.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  return { ...value, orderIds };
}

function receiptBodySha256(receipt) {
  const { receiptSha256: _receiptSha256, ...body } = receipt;
  return sha256(Buffer.from(JSON.stringify(body), "utf8"));
}

function validateStoredReceipt(row, expectedManifestSha256 = "") {
  if (!row || String(row.cleanup_kind || "") !== CLEANUP_KIND) {
    throw cleanupError("Der interne Cleanup-Beleg fehlt oder hat einen ungueltigen Typ.", "BRANCH_ORDER_CLEANUP_RECEIPT_INVALID");
  }
  let receipt;
  try {
    receipt = JSON.parse(String(row.receipt_json || ""));
  } catch {
    throw cleanupError("Der interne Cleanup-Beleg ist kein gueltiges JSON-Dokument.", "BRANCH_ORDER_CLEANUP_RECEIPT_INVALID");
  }
  const storedBytes = Buffer.from(String(row.receipt_json || ""), "utf8");
  const canonicalBytes = receiptBytes(receipt);
  const calculatedSha256 = receiptBodySha256(receipt);
  if (storedBytes.length !== canonicalBytes.length
    || !crypto.timingSafeEqual(storedBytes, canonicalBytes)
    || receipt.format !== RECEIPT_FORMAT
    || receipt.schemaVersion !== SCHEMA_VERSION
    || receipt.status !== "applied"
    || String(receipt.operationId || "") !== String(row.operation_id || "")
    || String(receipt.manifestSha256 || "") !== String(row.manifest_sha256 || "")
    || (expectedManifestSha256 && receipt.manifestSha256 !== expectedManifestSha256)
    || String(receipt.receiptSha256 || "") !== calculatedSha256
    || String(row.receipt_sha256 || "") !== calculatedSha256) {
    throw cleanupError("Der interne Cleanup-Beleg oder sein SHA-256 ist ungueltig.", "BRANCH_ORDER_CLEANUP_RECEIPT_INVALID");
  }
  return { receipt, bytes: storedBytes, receiptSha256: calculatedSha256 };
}

function storedReceiptForManifest(database, manifestSha256) {
  const row = database.prepare(`
    SELECT operation_id, cleanup_kind, manifest_sha256, receipt_json, receipt_sha256, created_at
    FROM maintenance_cleanup_receipts
    WHERE cleanup_kind = ? AND manifest_sha256 = ?
  `).get(CLEANUP_KIND, manifestSha256);
  return row ? validateStoredReceipt(row, manifestSha256) : null;
}

function openDatabase(databasePath, readOnly) {
  const database = new DatabaseSync(databasePath, { readOnly });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0);
  if (foreignKeys !== 1) {
    database.close();
    throw cleanupError("SQLite-Fremdschlüssel konnten nicht aktiviert werden.", "BRANCH_ORDER_CLEANUP_FOREIGN_KEYS_DISABLED");
  }
  return database;
}

function createManifest({ databasePath, manifestPath, now = () => new Date().toISOString() }) {
  const databaseRealPath = normalizedAbsolutePath(databasePath, "Der Datenbankpfad", { rejectLink: true });
  const outputPath = newOutputPath(manifestPath, "Der Manifestpfad");
  if (comparablePath(outputPath) === comparablePath(databaseRealPath)) {
    throw cleanupError("Manifest und Datenbank dürfen nicht dieselbe Datei sein.", "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  const databaseLock = acquireMaintenanceDatabaseLock(databaseRealPath);
  try {
    const database = openDatabase(databaseRealPath, true);
    let orderIds;
    try {
      assertRequiredSchema(database);
      databaseIntegrity(database);
      orderIds = allOrderIds(database);
      if (!orderIds.length) {
        throw cleanupError(
          "Die Datenbank enthaelt keine Filialbestellungen fuer ein Cleanup-Manifest.",
          "BRANCH_ORDER_CLEANUP_NO_TARGETS",
        );
      }
    } finally {
      database.close();
    }
    const manifest = {
      format: MANIFEST_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now(),
      databasePath: databaseRealPath,
      orderCount: orderIds.length,
      orderIdsSha256: orderIdsSha256(orderIds),
      orderIds,
    };
    const written = writeJsonExclusive(outputPath, manifest);
    return {
      status: "manifest-created",
      databasePath: databaseRealPath,
      manifestPath: outputPath,
      manifestSha256: written.sha256,
      requiredConfirmToken: requiredConfirmToken(written.sha256),
      orderCount: orderIds.length,
      orderIdsSha256: manifest.orderIdsSha256,
    };
  } finally {
    releaseMaintenanceDatabaseLock(databaseLock);
  }
}

function cleanupOrdersWhileLocked({
  databasePath,
  manifestPath,
  manifestSha256,
  apply = false,
  confirm = "",
  receiptPath = "",
  now = () => new Date().toISOString(),
  manifestReadHook = null,
  writeReceiptExport = writeBytesExclusiveFsync,
}) {
  const databaseRealPath = normalizedAbsolutePath(databasePath, "Der Datenbankpfad", { rejectLink: true });
  const manifestRealPath = normalizedAbsolutePath(manifestPath, "Der Manifestpfad", { rejectLink: true });
  const expectedManifestSha256 = String(manifestSha256 || "").trim().toLowerCase();
  const manifestBytes = readManifestSecure(manifestRealPath, manifestReadHook);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256) || sha256(manifestBytes) !== expectedManifestSha256) {
    throw cleanupError("Der SHA-256 des Cleanup-Manifests stimmt nicht.", "BRANCH_ORDER_CLEANUP_MANIFEST_HASH_MISMATCH");
  }
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw cleanupError("Das Cleanup-Manifest ist kein gueltiges JSON-Dokument.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  const manifest = validateManifest(manifestValue, databaseRealPath);
  const token = requiredConfirmToken(expectedManifestSha256);
  let receiptOutputPath = "";
  if (apply) {
    if (confirm !== token) {
      throw cleanupError("Das Bestaetigungstoken stimmt nicht.", "BRANCH_ORDER_CLEANUP_CONFIRMATION_INVALID");
    }
    receiptOutputPath = newOutputPath(receiptPath, "Der Belegpfad");
    const distinctPaths = new Set([
      databaseRealPath,
      manifestRealPath,
      receiptOutputPath,
    ].map(comparablePath));
    if (distinctPaths.size !== 3) {
      throw cleanupError("Datenbank, Manifest und Beleg muessen getrennte Dateien sein.", "BRANCH_ORDER_CLEANUP_PATH_INVALID");
    }
  } else if (confirm || receiptPath) {
    throw cleanupError(
      "Bestaetigung und Belegpfad sind nur zusammen mit --apply zulaessig.",
      "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID",
    );
  }

  const database = openDatabase(databaseRealPath, !apply);
  let transactionOpen = false;
  let storedReceipt = null;
  let alreadyApplied = false;
  try {
    assertRequiredSchema(database);
    if (!apply) {
      const previousReceipt = storedReceiptForManifest(database, expectedManifestSha256);
      if (previousReceipt) {
        return {
          ...previousReceipt.receipt,
          status: "already-applied",
          alreadyApplied: true,
          dryRun: true,
          databasePath: databaseRealPath,
          manifestPath: manifestRealPath,
        };
      }
      const before = databaseSnapshot(database, manifest.orderIds);
      return {
        status: "dry-run",
        dryRun: true,
        databasePath: databaseRealPath,
        manifestPath: manifestRealPath,
        manifestSha256: expectedManifestSha256,
        requiredConfirmToken: token,
        orderIdsSha256: manifest.orderIdsSha256,
        targets: before.targets,
        totalOrdersBefore: before.totalOrders,
        unmanifestedOrdersPreserved: before.unmanifestedOrders,
        preservedTableCounts: before.preservedTableCounts,
        preservedTableSha256: hashesFromState(before.preservedTableState),
        unmanifestedRecords: before.unmanifestedRecordState,
        integrity: before.integrity,
      };
    }

    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    storedReceipt = storedReceiptForManifest(database, expectedManifestSha256);
    if (storedReceipt) {
      alreadyApplied = true;
    } else {
      const before = databaseSnapshot(database, manifest.orderIds);
      const deleteOrder = database.prepare("DELETE FROM branch_orders WHERE id = ?");
      for (const orderId of manifest.orderIds) {
        if (Number(deleteOrder.run(orderId).changes || 0) !== 1) {
          throw cleanupError(
            `Die manifestierte Bestellung ${orderId} konnte nicht eindeutig geloescht werden.`,
            "BRANCH_ORDER_CLEANUP_TARGET_MISMATCH",
          );
        }
      }
      const remainingTargets = targetCounts(database, manifest.orderIds);
      if (remainingTargets.orders || remainingTargets.lines || remainingTargets.deliveries) {
        throw cleanupError(
          "Manifestierte Bestellungen oder abhaengige Datensaetze sind verblieben.",
          "BRANCH_ORDER_CLEANUP_DELETE_INCOMPLETE",
        );
      }
      const availableTables = tableNames(database);
      const preservedAfterState = preservedTableState(database, availableTables);
      if (JSON.stringify(preservedAfterState) !== JSON.stringify(before.preservedTableState)) {
        throw cleanupError(
          "Konfiguration oder Entwuerfe wurden unerwartet veraendert.",
          "BRANCH_ORDER_CLEANUP_PRESERVED_DATA_CHANGED",
        );
      }
      const remainingOrderCount = Number(database.prepare("SELECT COUNT(*) AS count FROM branch_orders").get().count || 0);
      const unmanifestedAfterState = unmanifestedRecordState(database, manifest.orderIds);
      if (remainingOrderCount !== before.unmanifestedOrders
        || JSON.stringify(unmanifestedAfterState) !== JSON.stringify(before.unmanifestedRecordState)) {
        throw cleanupError(
          "Nicht manifestierte Bestellungen wurden unerwartet veraendert.",
          "BRANCH_ORDER_CLEANUP_PRESERVED_DATA_CHANGED",
        );
      }
      const orphanLines = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM branch_order_lines line
        LEFT JOIN branch_orders parent ON parent.id = line.order_id
        WHERE parent.id IS NULL
      `).get().count || 0);
      const orphanDeliveries = Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM branch_order_deliveries delivery
        LEFT JOIN branch_orders parent ON parent.id = delivery.order_id
        WHERE parent.id IS NULL
      `).get().count || 0);
      if (orphanLines || orphanDeliveries) {
        throw cleanupError("Nach dem Cleanup bestehen verwaiste Bestelldaten.", "BRANCH_ORDER_CLEANUP_DELETE_INCOMPLETE");
      }
      const integrity = databaseIntegrity(database);
      const after = {
        totalOrders: remainingOrderCount,
        unmanifestedOrders: remainingOrderCount,
        preservedTableCounts: countsFromState(preservedAfterState),
        preservedTableState: preservedAfterState,
        unmanifestedRecordState: unmanifestedAfterState,
        orphanLines,
        orphanDeliveries,
        ...integrity,
      };
      const receiptBody = {
        format: RECEIPT_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        status: "applied",
        operationId: crypto.randomUUID(),
        appliedAt: now(),
        databasePath: databaseRealPath,
        manifestPath: manifestRealPath,
        manifestSha256: expectedManifestSha256,
        orderIdsSha256: manifest.orderIdsSha256,
        deleted: {
          orders: before.targets.orders,
          lines: before.targets.lines,
          deliveries: before.targets.deliveries,
        },
        preserved: {
          unmanifestedOrders: after.unmanifestedOrders,
          tables: after.preservedTableCounts,
          tableSha256: hashesFromState(after.preservedTableState),
          unmanifestedRecords: after.unmanifestedRecordState,
        },
        integrity: after.integrity,
        foreignKeyViolations: after.foreignKeyViolations,
        orphanLines: after.orphanLines,
        orphanDeliveries: after.orphanDeliveries,
      };
      const receipt = {
        ...receiptBody,
        receiptSha256: sha256(Buffer.from(JSON.stringify(receiptBody), "utf8")),
      };
      const serializedReceipt = receiptBytes(receipt).toString("utf8");
      database.prepare(`
        INSERT INTO maintenance_cleanup_receipts (
          operation_id, cleanup_kind, manifest_sha256, receipt_json, receipt_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        receipt.operationId,
        CLEANUP_KIND,
        expectedManifestSha256,
        serializedReceipt,
        receipt.receiptSha256,
        receipt.appliedAt,
      );
      storedReceipt = storedReceiptForManifest(database, expectedManifestSha256);
      if (!storedReceipt || storedReceipt.bytes.toString("utf8") !== serializedReceipt) {
        throw cleanupError("Der interne Cleanup-Beleg konnte nicht verifiziert werden.", "BRANCH_ORDER_CLEANUP_RECEIPT_INVALID");
      }
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }

  try {
    writeReceiptExport(receiptOutputPath, storedReceipt.bytes);
  } catch {
    throw cleanupError(
      "Das Cleanup wurde angewendet, der externe Belegexport ist jedoch fehlgeschlagen. Der interne Beleg bleibt gueltig.",
      "BRANCH_ORDER_CLEANUP_APPLIED_RECEIPT_EXPORT_FAILED",
      {
        applied: true,
        operationId: storedReceipt.receipt.operationId,
        receiptSha256: storedReceipt.receiptSha256,
      },
    );
  }
  return {
    ...storedReceipt.receipt,
    status: alreadyApplied ? "already-applied" : "applied",
    alreadyApplied,
    receiptPath: receiptOutputPath,
  };
}

function cleanupOrders(options) {
  const databaseRealPath = normalizedAbsolutePath(
    options?.databasePath,
    "Der Datenbankpfad",
    { rejectLink: true },
  );
  const databaseLock = acquireMaintenanceDatabaseLock(databaseRealPath);
  try {
    return cleanupOrdersWhileLocked({
      ...options,
      databasePath: databaseRealPath,
    });
  } finally {
    releaseMaintenanceDatabaseLock(databaseLock);
  }
}

function exportReceiptFromDatabase({
  databasePath,
  manifestPath,
  manifestSha256,
  receiptPath,
  manifestReadHook = null,
  writeReceiptExport = writeBytesExclusiveFsync,
}) {
  const databaseRealPath = normalizedAbsolutePath(databasePath, "Der Datenbankpfad", { rejectLink: true });
  const manifestRealPath = normalizedAbsolutePath(manifestPath, "Der Manifestpfad", { rejectLink: true });
  const outputPath = newOutputPath(receiptPath, "Der Belegpfad");
  const distinctPaths = new Set([databaseRealPath, manifestRealPath, outputPath].map(comparablePath));
  if (distinctPaths.size !== 3) {
    throw cleanupError("Datenbank, Manifest und Beleg muessen getrennte Dateien sein.", "BRANCH_ORDER_CLEANUP_PATH_INVALID");
  }
  const expectedManifestSha256 = String(manifestSha256 || "").trim().toLowerCase();
  const manifestBytes = readManifestSecure(manifestRealPath, manifestReadHook);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256) || sha256(manifestBytes) !== expectedManifestSha256) {
    throw cleanupError("Der SHA-256 des Cleanup-Manifests stimmt nicht.", "BRANCH_ORDER_CLEANUP_MANIFEST_HASH_MISMATCH");
  }
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw cleanupError("Das Cleanup-Manifest ist kein gueltiges JSON-Dokument.", "BRANCH_ORDER_CLEANUP_MANIFEST_INVALID");
  }
  const manifest = validateManifest(manifestValue, databaseRealPath);
  const database = openDatabase(databaseRealPath, true);
  let storedReceipt;
  try {
    assertRequiredSchema(database);
    storedReceipt = storedReceiptForManifest(database, expectedManifestSha256);
  } finally {
    database.close();
  }
  if (!storedReceipt || storedReceipt.receipt.orderIdsSha256 !== manifest.orderIdsSha256) {
    throw cleanupError("Fuer dieses Manifest ist kein gueltiger interner Cleanup-Beleg vorhanden.", "BRANCH_ORDER_CLEANUP_RECEIPT_MISSING");
  }
  try {
    writeReceiptExport(outputPath, storedReceipt.bytes);
  } catch {
    throw cleanupError(
      "Der interne Cleanup-Beleg ist gueltig, der externe Belegexport ist jedoch fehlgeschlagen.",
      "BRANCH_ORDER_CLEANUP_RECEIPT_EXPORT_FAILED",
      {
        applied: true,
        operationId: storedReceipt.receipt.operationId,
        receiptSha256: storedReceipt.receiptSha256,
      },
    );
  }
  return {
    status: "receipt-exported",
    databasePath: databaseRealPath,
    manifestPath: manifestRealPath,
    manifestSha256: expectedManifestSha256,
    operationId: storedReceipt.receipt.operationId,
    receiptSha256: storedReceipt.receiptSha256,
    receiptPath: outputPath,
  };
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.databasePath) {
    throw cleanupError("--database ist erforderlich.", "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID");
  }
  if (options.createManifestPath) {
    if (options.apply || options.exportReceiptFromDatabase || options.manifestPath || options.manifestSha256
      || options.confirm || options.receiptPath) {
      throw cleanupError(
        "--create-manifest darf nicht mit Cleanup-Optionen kombiniert werden.",
        "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID",
      );
    }
    return createManifest({
      databasePath: options.databasePath,
      manifestPath: options.createManifestPath,
    });
  }
  if (options.exportReceiptFromDatabase) {
    if (options.apply || options.confirm || options.createManifestPath) {
      throw cleanupError(
        "--export-receipt-from-db darf nicht mit --apply, --confirm oder --create-manifest kombiniert werden.",
        "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID",
      );
    }
    if (!options.manifestPath || !options.manifestSha256 || !options.receiptPath) {
      throw cleanupError(
        "Fuer den Belegexport sind --manifest, --manifest-sha256 und --receipt erforderlich.",
        "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID",
      );
    }
    return exportReceiptFromDatabase(options);
  }
  if (!options.manifestPath || !options.manifestSha256) {
    throw cleanupError(
      "--manifest und --manifest-sha256 sind erforderlich.",
      "BRANCH_ORDER_CLEANUP_ARGUMENT_INVALID",
    );
  }
  return cleanupOrders(options);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof BranchOrderCleanupError
      ? error.code
      : "BRANCH_ORDER_CLEANUP_UNEXPECTED";
    process.stderr.write(`ERROR [${code}] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BranchOrderCleanupError,
  MANIFEST_FORMAT,
  RECEIPT_FORMAT,
  cleanupOrders,
  createManifest,
  exportReceiptFromDatabase,
  orderIdsSha256,
  parseArguments,
  requiredConfirmToken,
  runCli,
  sha256,
};
