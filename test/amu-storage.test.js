"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_DOCUMENT_BYTES,
  createAmuStorage,
  detectDocumentType,
  sanitizeOriginalFilename,
  syncEncryptedFilesBackup,
  restoreEncryptedFilesBackup,
  validateEncryptionKeyForStorage,
} = require("../lib/amu-storage");

const testRoots = [];

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-amu-${label}-`));
  testRoots.push(directory);
  return directory;
}

function key(byte = 7) {
  return Buffer.alloc(32, byte);
}

function pdfBuffer(text = "AMU Testdokument") {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% ${text}\n%%EOF`, "utf8");
}

function jpgBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}

function pngBuffer() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
}

test.after(() => {
  for (const root of testRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("Dateinamen werden nur als sichere Anzeigewerte übernommen", () => {
  assert.equal(sanitizeOriginalFilename("../../Geheim\u0000: AMU?.PDF"), "Geheim- AMU-.PDF");
  assert.equal(sanitizeOriginalFilename("   ...   "), "Dokument");
  assert.ok(sanitizeOriginalFilename(`${"a".repeat(150)}.pdf`).length <= 120);
});

test("Magic Bytes erkennen PDF, JPEG und PNG und lehnen HEIC sowie unbekannte Typen ab", () => {
  assert.deepEqual(detectDocumentType(pdfBuffer(), "scan.exe"), {
    mimeType: "application/pdf", extension: "pdf", safeFilename: "scan.pdf",
  });
  assert.equal(detectDocumentType(jpgBuffer(), "foto.jpeg").mimeType, "image/jpeg");
  assert.equal(detectDocumentType(pngBuffer(), "foto.png").mimeType, "image/png");
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic", "ascii"), Buffer.alloc(4)]);
  assert.throws(() => detectDocumentType(heic, "foto.heic"), { code: "AMU_HEIC_UNSUPPORTED" });
  assert.throws(() => detectDocumentType(Buffer.from("not a document"), "fake.pdf"), { code: "AMU_DOCUMENT_TYPE_UNSUPPORTED" });
});

test("Dokumente werden gescannt, verschlüsselt gespeichert und unverändert gelesen", async () => {
  const root = temporaryDirectory("roundtrip");
  const scans = [];
  const storage = createAmuStorage({
    rootDirectory: root,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    requireScanner: true,
    scanner: async (filePath) => {
      scans.push(fs.readFileSync(filePath));
      return { available: true, clean: true, engine: "test-scanner" };
    },
  });
  const source = pdfBuffer("Person 07");
  const metadata = await storage.saveBuffer({ buffer: source, originalName: "../AMU Brigitte.PDF" });

  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0], source);
  assert.match(metadata.storageKey, /^[0-9a-f]{2}\/[0-9a-f-]+\.amu$/);
  assert.equal(metadata.originalFilename, "AMU Brigitte.pdf");
  assert.equal(metadata.detectedMime, "application/pdf");
  assert.equal(metadata.scanStatus, "clean");
  assert.deepEqual(storage.readBuffer(metadata), source);
  const protectedText = storage.protectText("Vertrauliche Bemerkung.pdf");
  assert.match(protectedText, /^enc:v1:/);
  assert.equal(protectedText.includes("Vertrauliche"), false);
  assert.equal(storage.unprotectText(protectedText), "Vertrauliche Bemerkung.pdf");
  const prefixedText = storage.protectText("enc:v1:test");
  assert.notEqual(prefixedText, "enc:v1:test");
  assert.equal(storage.unprotectText(prefixedText), "enc:v1:test");
  assert.equal(validateEncryptionKeyForStorage({ sourceDirectory: root, encryptionKeys: { primary: key() }, activeKeyId: "primary" }).fileCount, 1);

  const encrypted = fs.readFileSync(storage.blobPath(metadata.storageKey));
  assert.equal(encrypted.subarray(0, 8).toString("ascii"), "GPAMU002");
  assert.equal(encrypted.includes(source), false);
  assert.equal(fs.readdirSync(path.join(root, "tmp")).length, 0);
  assert.equal(storage.diagnostics().ok, true);
  assert.throws(() => storage.blobPath("../../public/index.html"), { code: "AMU_STORAGE_KEY_INVALID" });
});

test("Personalakt-Hüllen sind an Datensatz, Feld und Person gebunden", () => {
  const storage = createAmuStorage({
    rootDirectory: temporaryDirectory("record-context"),
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  const context = { namespace: "personnel-record", recordId: "17", field: "payload", employeeNumber: "420" };
  const protectedRecord = storage.protectRecord(JSON.stringify({ note: "vertraulich" }), context);
  assert.match(protectedRecord, /^enc:v2:/);
  assert.equal(protectedRecord.includes("vertraulich"), false);
  assert.deepEqual(JSON.parse(storage.unprotectRecord(protectedRecord, context)), { note: "vertraulich" });
  assert.throws(() => storage.unprotectRecord(protectedRecord, { ...context, recordId: "18" }), { code: "PERSONNEL_RECORD_INTEGRITY_FAILED" });
  assert.throws(() => storage.unprotectRecord("Klartext", context), { code: "PERSONNEL_RECORD_PLAINTEXT_REJECTED" });
});

test("Start bereinigt Klartextreste und prüft den dauerhaften Recovery-Schlüssel", () => {
  const root = temporaryDirectory("startup-cleanup");
  const temporary = path.join(root, "tmp");
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, "abgebrochener-upload.upload"), pdfBuffer("Klartextrest"));
  const storage = createAmuStorage({ rootDirectory: root, encryptionKeys: { primary: key() }, activeKeyId: "primary", scanner: async () => true });
  assert.equal(fs.readdirSync(temporary).length, 0);
  assert.equal(fs.existsSync(path.join(root, "key-check.amu")), true);
  assert.throws(
    () => createAmuStorage({ rootDirectory: root, encryptionKeys: { primary: key(9) }, activeKeyId: "primary", scanner: async () => true }),
    { code: "AMU_DOCUMENT_INTEGRITY_FAILED" },
  );
  assert.equal(storage.diagnostics().ok, true);
});

test("Größenlimit und Scanner-Ablehnung hinterlassen keine Blobs", async () => {
  const root = temporaryDirectory("reject");
  const storage = createAmuStorage({
    rootDirectory: root,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    requireScanner: true,
    scanner: async () => ({ available: true, clean: false, engine: "test-scanner" }),
  });
  await assert.rejects(storage.saveBuffer({ buffer: pdfBuffer(), originalName: "amu.pdf" }), { code: "AMU_DOCUMENT_SCAN_REJECTED" });
  assert.equal(fs.readdirSync(path.join(root, "blobs")).length, 0);
  assert.throws(
    () => detectDocumentType(Buffer.concat([pdfBuffer(), Buffer.alloc(MAX_DOCUMENT_BYTES)]), "gross.pdf"),
    { code: "AMU_DOCUMENT_TOO_LARGE" },
  );
});

test("Authentifizierung und Metadatenprüfsummen erkennen Manipulation", async () => {
  const root = temporaryDirectory("tamper");
  const storage = createAmuStorage({
    rootDirectory: root,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  const metadata = await storage.saveBuffer({ buffer: pngBuffer(), originalName: "amu.png" });
  assert.throws(() => storage.readBuffer({ ...metadata, sha256: "0".repeat(64) }), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" });

  const filePath = storage.blobPath(metadata.storageKey);
  const encrypted = fs.readFileSync(filePath);
  encrypted[encrypted.length - 1] ^= 0xff;
  fs.writeFileSync(filePath, encrypted);
  assert.throws(() => storage.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" });
});

test("deleteBlob entfernt nur validierte Speicherschlüssel", async () => {
  const storage = createAmuStorage({
    rootDirectory: temporaryDirectory("delete"),
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  const metadata = await storage.saveBuffer({ buffer: jpgBuffer(), originalName: "foto.jpg" });
  assert.equal(storage.deleteBlob(metadata.storageKey), true);
  assert.equal(storage.deleteBlob(metadata.storageKey), false);
  assert.throws(() => storage.deleteBlob("../outside"), { code: "AMU_STORAGE_KEY_INVALID" });
});

test("Backup und Restore prüfen Ciphertext-Hashes und tauschen das Ziel atomar", async () => {
  const root = temporaryDirectory("backup-source");
  const backup = temporaryDirectory("backup-parent");
  const target = temporaryDirectory("restore-target");
  const backupDirectory = path.join(backup, "snapshot");
  const storage = createAmuStorage({
    rootDirectory: root,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  const metadata = await storage.saveBuffer({ buffer: pdfBuffer("Backup"), originalName: "amu.pdf" });
  const result = syncEncryptedFilesBackup({ sourceDirectory: root, targetDirectory: backupDirectory });
  assert.equal(result.fileCount, 1);
  assert.equal(result.manifest.files[0].storageKey, metadata.storageKey);

  fs.writeFileSync(path.join(target, "alte-datei.txt"), "muss verschwinden");
  const restored = restoreEncryptedFilesBackup({ backupDirectory, targetDirectory: target });
  assert.equal(restored.fileCount, 1);
  assert.equal(fs.existsSync(path.join(target, "alte-datei.txt")), false);
  const restoredStorage = createAmuStorage({
    rootDirectory: target,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  assert.deepEqual(restoredStorage.readBuffer(metadata), pdfBuffer("Backup"));
});

test("Beschädigtes Backup wird vor dem Austausch abgelehnt und lässt das Ziel unverändert", async () => {
  const source = temporaryDirectory("bad-backup-source");
  const backup = path.join(temporaryDirectory("bad-backup-parent"), "snapshot");
  const target = temporaryDirectory("bad-backup-target");
  const storage = createAmuStorage({
    rootDirectory: source,
    encryptionKeys: { primary: key() },
    activeKeyId: "primary",
    scanner: async () => true,
  });
  const metadata = await storage.saveBuffer({ buffer: pdfBuffer("Original"), originalName: "amu.pdf" });
  syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: backup });
  fs.writeFileSync(path.join(target, "marker.txt"), "bestehend");

  const backupFile = path.join(backup, "blobs", ...metadata.storageKey.split("/"));
  fs.appendFileSync(backupFile, "manipuliert");
  assert.throws(
    () => restoreEncryptedFilesBackup({ backupDirectory: backup, targetDirectory: target }),
    { code: "AMU_BACKUP_INTEGRITY_FAILED" },
  );
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8"), "bestehend");
});
