"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const BACKUP_FORMAT = "f18-lagerware-backup";
const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_ROOT = "f18-lagerware-backup";
const MANIFEST_PATH = `${BACKUP_ROOT}/backup-manifest.json`;
const DATABASE_PATH = `${BACKUP_ROOT}/database/lagerware.sqlite3`;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 5000;

class F18MigrationError extends Error {
  constructor(message, code = "F18_MIGRATION_INVALID", status = 400) {
    super(message);
    this.name = "F18MigrationError";
    this.code = code;
    this.status = status;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeArchivePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized
    || normalized.startsWith("/")
    || /^[a-z]:/i.test(normalized)
    || normalized.includes("\0")
    || normalized.split("/").some((part) => part === "..")) {
    throw new F18MigrationError(
      "Die F18-Sicherung enthält einen unsicheren Dateipfad.",
      "F18_ARCHIVE_PATH_INVALID",
    );
  }
  return normalized.replace(/^\.\/+/, "");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new F18MigrationError(
    "Die Datei ist keine lesbare ZIP-Sicherung.",
    "F18_ARCHIVE_INVALID",
  );
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ARCHIVE_BYTES) {
    throw new F18MigrationError(
      `Die F18-Sicherung darf höchstens ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB groß sein.`,
      "F18_ARCHIVE_TOO_LARGE",
      413,
    );
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber || centralDisk || entryCount === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new F18MigrationError(
      "Mehrteilige oder ZIP64-Sicherungen werden nicht unterstützt.",
      "F18_ARCHIVE_UNSUPPORTED",
    );
  }
  if (entryCount > MAX_ENTRIES || centralOffset + centralSize > eocd) {
    throw new F18MigrationError(
      "Die F18-Sicherung enthält zu viele oder ungültige Einträge.",
      "F18_ARCHIVE_INVALID",
    );
  }
  const entries = new Map();
  let offset = centralOffset;
  let unpackedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new F18MigrationError("Das ZIP-Inhaltsverzeichnis ist beschädigt.", "F18_ARCHIVE_INVALID");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length || flags & 0x1 || ![0, 8].includes(method)) {
      throw new F18MigrationError(
        "Die F18-Sicherung verwendet eine nicht unterstützte ZIP-Option.",
        "F18_ARCHIVE_UNSUPPORTED",
      );
    }
    const name = safeArchivePath(buffer.subarray(offset + 46, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + commentLength;
    if (offset > buffer.length || entries.has(name)) {
      throw new F18MigrationError(
        "Die F18-Sicherung enthält doppelte oder beschädigte Einträge.",
        "F18_ARCHIVE_INVALID",
      );
    }
    if (name.endsWith("/")) continue;
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new F18MigrationError(
        "Eine Datei der F18-Sicherung ist zu groß.",
        "F18_ARCHIVE_ENTRY_TOO_LARGE",
        413,
      );
    }
    unpackedBytes += uncompressedSize;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      throw new F18MigrationError(
        "Der entpackte Inhalt der F18-Sicherung ist zu groß.",
        "F18_ARCHIVE_TOO_LARGE",
        413,
      );
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new F18MigrationError("Ein ZIP-Eintrag ist beschädigt.", "F18_ARCHIVE_INVALID");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new F18MigrationError("Ein ZIP-Eintrag ist unvollständig.", "F18_ARCHIVE_INVALID");
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, {
        maxOutputLength: Math.min(MAX_ENTRY_BYTES, uncompressedSize + 1),
      });
    } catch {
      throw new F18MigrationError("Ein ZIP-Eintrag kann nicht entpackt werden.", "F18_ARCHIVE_INVALID");
    }
    if (data.length !== uncompressedSize) {
      throw new F18MigrationError("Ein ZIP-Eintrag hat eine ungültige Größe.", "F18_ARCHIVE_INVALID");
    }
    entries.set(name, data);
  }
  return entries;
}

function parseManifest(entries) {
  const manifestBuffer = entries.get(MANIFEST_PATH);
  if (!manifestBuffer || manifestBuffer.length > 2 * 1024 * 1024) {
    throw new F18MigrationError(
      "Das F18-Sicherungsmanifest fehlt oder ist zu groß.",
      "F18_MANIFEST_MISSING",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    throw new F18MigrationError("Das F18-Sicherungsmanifest ist ungültig.", "F18_MANIFEST_INVALID");
  }
  if (manifest?.format !== BACKUP_FORMAT || Number(manifest?.schema_version) !== BACKUP_SCHEMA_VERSION
    || !Array.isArray(manifest?.files)) {
    throw new F18MigrationError(
      "Die Sicherung hat kein unterstütztes F18-Format.",
      "F18_MANIFEST_UNSUPPORTED",
    );
  }
  const declared = new Set();
  for (const item of manifest.files) {
    const relative = safeArchivePath(item?.path);
    const archivePath = `${BACKUP_ROOT}/${relative}`;
    if (declared.has(archivePath)) {
      throw new F18MigrationError("Das F18-Manifest enthält doppelte Dateien.", "F18_MANIFEST_INVALID");
    }
    declared.add(archivePath);
    const data = entries.get(archivePath);
    if (!data || Number(item?.size) !== data.length || !/^[a-f0-9]{64}$/i.test(String(item?.sha256 || ""))
      || sha256(data) !== String(item.sha256).toLowerCase()) {
      throw new F18MigrationError(
        `Die Integritätsprüfung ist für ${relative} fehlgeschlagen.`,
        "F18_MANIFEST_HASH_MISMATCH",
      );
    }
  }
  for (const archivePath of entries.keys()) {
    if (archivePath !== MANIFEST_PATH && !declared.has(archivePath)) {
      throw new F18MigrationError(
        "Die F18-Sicherung enthält eine nicht im Manifest deklarierte Datei.",
        "F18_MANIFEST_UNDECLARED_FILE",
      );
    }
  }
  if (!declared.has(DATABASE_PATH) || !entries.has(DATABASE_PATH)) {
    throw new F18MigrationError("Die F18-Datenbank fehlt in der Sicherung.", "F18_DATABASE_MISSING");
  }
  return manifest;
}

function requiredColumns(database, table, required) {
  const found = new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
  const missing = required.filter((column) => !found.has(column));
  if (missing.length) {
    throw new F18MigrationError(
      `Die F18-Datenbank ist nicht kompatibel (${table}: ${missing.join(", ")} fehlt).`,
      "F18_DATABASE_SCHEMA_UNSUPPORTED",
    );
  }
}

function stringValue(value, maximum = 2000) {
  return String(value ?? "").replace(/\0/g, "").trim().slice(0, maximum);
}

function normalizeLegacyDateTime(value) {
  const text = stringValue(value, 64);
  if (!text) return null;
  const parsed = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function normalizeLegacyDate(value) {
  const text = stringValue(value, 32);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function legacyCondition(value) {
  const original = stringValue(value, 300);
  const text = original.toLocaleLowerCase("de");
  let normalized = "good";
  if (/unvoll|fehl|ohne\s|incomplete/.test(text)) normalized = "incomplete";
  else if (/defekt|beschäd|bruch|kratzer|damaged/.test(text)) normalized = "damaged";
  else if (/gebraucht|abgenutzt|used/.test(text)) normalized = "used";
  return { normalized, original };
}

function readLegacyDatabase(databaseBuffer) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-f18-import-"));
  const databasePath = path.join(temporary, "lagerware.sqlite3");
  fs.writeFileSync(databasePath, databaseBuffer, { flag: "wx", mode: 0o600 });
  let database;
  try {
    database = new DatabaseSync(databasePath, { open: true, readOnly: true });
    requiredColumns(database, "employees", ["id", "employee_number", "name", "active"]);
    requiredColumns(database, "loans", [
      "id", "borrower_id", "due_date", "created_at", "returned_at",
      "return_condition", "borrower_confirmed", "return_checked_by_id",
    ]);
    requiredColumns(database, "loan_items", [
      "id", "loan_id", "position", "item_number", "description",
      "serial_number", "condition_out", "item_note",
    ]);
    requiredColumns(database, "loan_photos", [
      "id", "loan_id", "item_id", "stage", "filename", "original_name", "uploaded_at",
    ]);
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (String(integrity?.integrity_check || "").toLowerCase() !== "ok") {
      throw new F18MigrationError(
        "Die F18-Datenbank hat die SQLite-Integritätsprüfung nicht bestanden.",
        "F18_DATABASE_INTEGRITY_FAILED",
      );
    }
    const employees = database.prepare(`
      SELECT id, employee_number, name, active
      FROM employees
      ORDER BY id
    `).all().map((row) => ({
      id: Number(row.id),
      employeeNumber: stringValue(row.employee_number, 64),
      name: stringValue(row.name, 200),
      active: Boolean(row.active),
    }));
    const itemsByLoan = new Map();
    database.prepare(`
      SELECT id, loan_id, position, item_number, description, serial_number, condition_out, item_note
      FROM loan_items
      ORDER BY loan_id, position, id
    `).all().forEach((row) => {
      const entries = itemsByLoan.get(Number(row.loan_id)) || [];
      entries.push({
        sourceId: Number(row.id),
        position: Number(row.position),
        articleNumber: stringValue(row.item_number, 32),
        description: stringValue(row.description, 300),
        serialNumber: stringValue(row.serial_number, 200),
        conditionOut: legacyCondition(row.condition_out),
        note: stringValue(row.item_note, 1000),
      });
      itemsByLoan.set(Number(row.loan_id), entries);
    });
    const photosByLoan = new Map();
    database.prepare(`
      SELECT id, loan_id, item_id, stage, filename, original_name, uploaded_at
      FROM loan_photos
      ORDER BY loan_id, stage, id
    `).all().forEach((row) => {
      const entries = photosByLoan.get(Number(row.loan_id)) || [];
      entries.push({
        sourceId: Number(row.id),
        sourceItemId: row.item_id == null ? null : Number(row.item_id),
        phase: row.stage === "return" ? "return" : "issue",
        relativePath: safeArchivePath(`photos/${stringValue(row.filename, 1000)}`),
        originalName: stringValue(row.original_name || path.posix.basename(row.filename), 255),
        uploadedAt: normalizeLegacyDateTime(row.uploaded_at),
      });
      photosByLoan.set(Number(row.loan_id), entries);
    });
    const loans = database.prepare(`
      SELECT id, borrower_id, item_number, description, serial_number, quantity, due_date,
             condition_out, notes, created_at, returned_at, return_condition, return_notes,
             borrower_confirmed, return_checked_by_id
      FROM loans
      ORDER BY id
    `).all().map((row) => {
      let items = itemsByLoan.get(Number(row.id)) || [];
      if (!items.length && stringValue(row.item_number, 32)) {
        items = [{
          sourceId: null,
          position: 1,
          articleNumber: stringValue(row.item_number, 32),
          description: stringValue(row.description, 300),
          serialNumber: stringValue(row.serial_number, 200),
          conditionOut: legacyCondition(row.condition_out),
          note: "",
        }];
      }
      return {
        sourceId: Number(row.id),
        borrowerSourceEmployeeId: Number(row.borrower_id),
        returnWitnessSourceEmployeeId: row.return_checked_by_id == null
          ? null
          : Number(row.return_checked_by_id),
        dueDate: normalizeLegacyDate(row.due_date),
        issuedAt: normalizeLegacyDateTime(row.created_at),
        returnedAt: normalizeLegacyDateTime(row.returned_at),
        status: row.returned_at ? "returned" : "issued",
        notes: stringValue(row.notes, 1000),
        returnNotes: stringValue(row.return_notes, 1000),
        returnCondition: legacyCondition(row.return_condition),
        borrowerReturnConfirmed: Boolean(row.borrower_confirmed),
        items,
        photos: photosByLoan.get(Number(row.id)) || [],
      };
    });
    return { employees, loans };
  } finally {
    try { database?.close(); } catch {}
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function inspectF18Backup(buffer) {
  const fingerprint = sha256(buffer);
  const entries = readZipEntries(buffer);
  const manifest = parseManifest(entries);
  const source = readLegacyDatabase(entries.get(DATABASE_PATH));
  const warnings = [];
  const blockingIssues = [];
  for (const loan of source.loans) {
    if (!loan.items.length) blockingIssues.push(`Leihe ${loan.sourceId} enthält keinen Artikel.`);
    if (loan.items.length > 5) blockingIssues.push(`Leihe ${loan.sourceId} enthält mehr als fünf Artikel.`);
    const seenPositions = new Set();
    for (const item of loan.items) {
      if (!/^\d{6}$/.test(item.articleNumber)) {
        blockingIssues.push(`Leihe ${loan.sourceId}: Artikelnummer ${item.articleNumber || "fehlt"} ist nicht sechsstellig.`);
      }
      if (!Number.isInteger(item.position) || item.position < 1 || item.position > 5
        || seenPositions.has(item.position)) {
        blockingIssues.push(`Leihe ${loan.sourceId} hat ungültige Artikelpositionen.`);
      }
      seenPositions.add(item.position);
    }
    for (const phase of ["issue", "return"]) {
      const phasePhotos = loan.photos.filter((photo) => photo.phase === phase);
      if (phasePhotos.length > 9) {
        blockingIssues.push(
          `Leihe ${loan.sourceId} enthält ${phasePhotos.length} ${phase === "issue" ? "Ausgabe" : "Rücknahme"}fotos; höchstens neun sind möglich.`,
        );
      }
    }
    for (const photo of loan.photos) {
      const archivePath = `${BACKUP_ROOT}/${photo.relativePath}`;
      if (!entries.has(archivePath)) {
        blockingIssues.push(`Leihe ${loan.sourceId}: Foto ${photo.originalName} fehlt in der Sicherung.`);
      }
    }
    if (!loan.issuedAt) blockingIssues.push(`Leihe ${loan.sourceId} hat kein gültiges Ausgabedatum.`);
    if (!loan.dueDate) warnings.push(`Leihe ${loan.sourceId} hat kein gültiges Rückgabedatum.`);
    if (loan.status === "returned" && !loan.returnedAt) {
      blockingIssues.push(`Leihe ${loan.sourceId} hat ein ungültiges Rückgabedatum.`);
    }
  }
  const photoCount = source.loans.reduce((sum, loan) => sum + loan.photos.length, 0);
  const itemCount = source.loans.reduce((sum, loan) => sum + loan.items.length, 0);
  return {
    fingerprint,
    source: {
      format: manifest.format,
      schemaVersion: Number(manifest.schema_version),
      appVersion: stringValue(manifest.app_version, 64),
      createdAt: normalizeLegacyDateTime(manifest.created_at),
      reason: stringValue(manifest.reason, 64),
    },
    employees: source.employees,
    loans: source.loans,
    files: entries,
    summary: {
      employees: source.employees.length,
      loans: source.loans.length,
      openLoans: source.loans.filter((loan) => loan.status === "issued").length,
      returnedLoans: source.loans.filter((loan) => loan.status === "returned").length,
      items: itemCount,
      photos: photoCount,
    },
    warnings: [...new Set(warnings)],
    blockingIssues: [...new Set(blockingIssues)],
  };
}

function photoBufferForMigration(inspection, photo) {
  return inspection.files.get(`${BACKUP_ROOT}/${photo.relativePath}`) || null;
}

function publicF18Inspection(inspection) {
  return {
    fingerprint: inspection.fingerprint,
    source: inspection.source,
    summary: inspection.summary,
    employees: inspection.employees,
    warnings: inspection.warnings,
    blockingIssues: inspection.blockingIssues,
    canImport: inspection.blockingIssues.length === 0,
  };
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  F18MigrationError,
  inspectF18Backup,
  photoBufferForMigration,
  publicF18Inspection,
  readZipEntries,
};
