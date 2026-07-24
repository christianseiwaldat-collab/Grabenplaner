"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files, method = 0) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, dataValue] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(dataValue) ? dataValue : Buffer.from(dataValue);
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createLegacyDatabase({
  employees = [
    { id: 1, employeeNumber: "101", name: "Erika Beispiel", active: true },
    { id: 2, employeeNumber: "102", name: "Walter Beispiel", active: true },
  ],
  loans = [],
} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "f18-fixture-"));
  const databasePath = path.join(temporary, "lagerware.sqlite3");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_number TEXT,
        name TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        borrower_id INTEGER NOT NULL REFERENCES employees(id),
        item_number TEXT NOT NULL,
        description TEXT NOT NULL,
        serial_number TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        due_date TEXT NOT NULL,
        condition_out TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        returned_at TEXT,
        return_condition TEXT,
        return_notes TEXT,
        borrower_confirmed INTEGER NOT NULL DEFAULT 0,
        return_checked_by_id INTEGER REFERENCES employees(id)
      );
      CREATE TABLE loan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        item_number TEXT NOT NULL,
        description TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        condition_out TEXT NOT NULL,
        item_note TEXT,
        UNIQUE(loan_id, position)
      );
      CREATE TABLE loan_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
        item_id INTEGER REFERENCES loan_items(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('issue','return')),
        filename TEXT NOT NULL,
        original_name TEXT,
        uploaded_at TEXT NOT NULL
      );
    `);
    const insertEmployee = database.prepare(`
      INSERT INTO employees (id, employee_number, name, active) VALUES (?, ?, ?, ?)
    `);
    employees.forEach((employee) => insertEmployee.run(
      employee.id,
      employee.employeeNumber,
      employee.name,
      Number(employee.active !== false),
    ));
    const insertLoan = database.prepare(`
      INSERT INTO loans
        (id, borrower_id, item_number, description, serial_number, quantity, due_date,
         condition_out, notes, created_at, returned_at, return_condition, return_notes,
         borrower_confirmed, return_checked_by_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = database.prepare(`
      INSERT INTO loan_items
        (id, loan_id, position, item_number, description, serial_number, condition_out, item_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPhoto = database.prepare(`
      INSERT INTO loan_photos
        (id, loan_id, item_id, stage, filename, original_name, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let nextItemId = 1;
    let nextPhotoId = 1;
    for (const loan of loans) {
      const first = loan.items[0];
      insertLoan.run(
        loan.id,
        loan.borrowerId,
        first.articleNumber,
        first.description,
        first.serialNumber || "",
        loan.dueDate,
        loan.conditionOut || "gut",
        loan.notes || "",
        loan.issuedAt,
        loan.returnedAt || null,
        loan.returnCondition || "",
        loan.returnNotes || "",
        Number(Boolean(loan.borrowerConfirmed)),
        loan.returnWitnessId || null,
      );
      const itemIds = new Map();
      for (const item of loan.items) {
        const itemId = nextItemId++;
        itemIds.set(item.position, itemId);
        insertItem.run(
          itemId,
          loan.id,
          item.position,
          item.articleNumber,
          item.description,
          item.serialNumber || "",
          item.conditionOut || "gut",
          item.note || "",
        );
      }
      for (const photo of loan.photos || []) {
        insertPhoto.run(
          nextPhotoId++,
          loan.id,
          itemIds.get(photo.itemPosition) || null,
          photo.phase,
          photo.filename,
          photo.originalName || path.basename(photo.filename),
          photo.uploadedAt || loan.issuedAt,
        );
      }
    }
  } finally {
    database.close();
  }
  const buffer = fs.readFileSync(databasePath);
  fs.rmSync(temporary, { recursive: true, force: true });
  return buffer;
}

function createF18Backup({ employees, loans, photos = {}, appVersion = "v6.0.1" } = {}) {
  const database = createLegacyDatabase({ employees, loans });
  const components = {
    "database/lagerware.sqlite3": database,
    ...Object.fromEntries(Object.entries(photos).map(([name, data]) => [`photos/${name}`, data])),
  };
  const manifest = {
    format: "f18-lagerware-backup",
    schema_version: 1,
    app_version: appVersion,
    created_at: "2026-07-24T10:00:00+00:00",
    reason: "migration",
    components: { database: true, photos: true, branding_kits: true },
    files: Object.entries(components).map(([filePath, data]) => ({
      path: filePath,
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
    })),
  };
  const files = Object.fromEntries(Object.entries(components).map(([name, data]) => [
    `f18-lagerware-backup/${name}`,
    data,
  ]));
  files["f18-lagerware-backup/backup-manifest.json"] = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return storedZip(files, 8);
}

module.exports = {
  createF18Backup,
  createLegacyDatabase,
  storedZip,
};
