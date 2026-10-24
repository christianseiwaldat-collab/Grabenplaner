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

function readOnlyTreeState(directory) {
  if (!fs.existsSync(directory)) return null;
  const crypto = require("node:crypto"), result = {};
  function visit(file) {
    const stat = fs.lstatSync(file), relative = path.relative(directory, file);
    result[relative] = { mode: stat.mode, ino: stat.ino, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      ...(stat.isFile() ? { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } : {}) };
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  visit(directory); return result;
}

test("read-only storage exposes only frozen reads and preserves source bytes, metadata and stale temporary files", async () => {
  const directory = temporaryDirectory("readonly"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const context = { namespace: "synthetic", recordId: "record", field: "payload", employeeNumber: "person" };
  const record = writer.protectRecord('{"synthetic":true}', context), text = writer.protectText("synthetic");
  const stale = path.join(directory, "tmp", "old.upload"); fs.writeFileSync(stale, "must remain"); fs.utimesSync(stale, new Date(0), new Date(0));
  const before = readOnlyTreeState(directory);
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  assert.equal(Object.isFrozen(reader), true); assert.deepEqual(Object.keys(reader).sort(), ["readBuffer", "unprotectRecord", "unprotectText"]);
  assert.deepEqual(reader.readBuffer(metadata), pdfBuffer()); assert.equal(reader.unprotectRecord(record, context), '{"synthetic":true}'); assert.equal(reader.unprotectText(text), "synthetic");
  assert.deepEqual(readOnlyTreeState(directory), before);
  assert.throws(() => createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: "true" }), { code: "AMU_STORAGE_MODE_INVALID" });
  assert.throws(() => createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true,
    checkBudget() { throw Object.assign(Error("synthetic deadline"), { code: "PG_BACKUP_OPERATION_TIMEOUT" }); } }), { code: "PG_BACKUP_OPERATION_TIMEOUT" });
  assert.deepEqual(readOnlyTreeState(directory), before);
});

test("read-only storage never creates a missing root or key check and rejects wrong keys and changed ciphertext", async () => {
  const parent = temporaryDirectory("readonly-missing"), directory = path.join(parent, "storage");
  createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  assert.equal(fs.existsSync(directory), false);
  const writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  fs.unlinkSync(path.join(directory, "key-check.amu")); const before = readOnlyTreeState(directory);
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  assert.deepEqual(reader.readBuffer(metadata), pdfBuffer()); assert.deepEqual(readOnlyTreeState(directory), before);
  assert.throws(() => createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key(8) }, activeKeyId: "example", readOnly: true }), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" });
  const file = writer.blobPath(metadata.storageKey), encrypted = fs.readFileSync(file); encrypted[encrypted.length - 1] ^= 1; fs.writeFileSync(file, encrypted);
  assert.throws(() => reader.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" }); assert.equal(fs.existsSync(path.join(directory, "key-check.amu")), false);
});

test("read-only storage rejects hardlinks, traversal and unexpected encrypted sizes before returning plaintext", async () => {
  const directory = temporaryDirectory("readonly-boundary"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  assert.throws(() => reader.readBuffer("../outside.amu"), { code: "AMU_STORAGE_KEY_INVALID" });
  const file = writer.blobPath(metadata.storageKey), linked = path.join(directory, "linked.amu"); fs.linkSync(file, linked);
  try { assert.throws(() => reader.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" }); } finally { fs.unlinkSync(linked); }
  fs.truncateSync(file, MAX_DOCUMENT_BYTES + 513);
  assert.throws(() => reader.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" });
});

test("read-only storage rejects a linked root and linked blob ancestors", async () => {
  const parent = temporaryDirectory("readonly-links"), directory = path.join(parent, "storage");
  const writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const alias = path.join(parent, "alias"); fs.symlinkSync(directory, alias, "junction");
  assert.throws(() => createAmuStorage({ rootDirectory: alias, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true }), { code: "AMU_STORAGE_KEY_INVALID" });
  fs.unlinkSync(alias);
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  const blobs = path.join(directory, "blobs"), parked = path.join(parent, "parked-blobs"); fs.renameSync(blobs, parked); fs.symlinkSync(parked, blobs, "junction");
  try { assert.throws(() => reader.readBuffer(metadata), { code: "AMU_STORAGE_KEY_INVALID" }); } finally { fs.unlinkSync(blobs); fs.renameSync(parked, blobs); }
});

test("read-only storage rejects a file symlink under the actual Linux filesystem", { skip: process.platform === "win32" }, async () => {
  const directory = temporaryDirectory("readonly-file-link"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  const file = writer.blobPath(metadata.storageKey), parkedFile = path.join(directory, "parked.amu"); fs.renameSync(file, parkedFile);
  try { fs.symlinkSync(parkedFile, file, "file"); assert.throws(() => reader.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" }); }
  finally { if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file); fs.renameSync(parkedFile, file); }
});

test("read-only FD reads reject growth during the read after at most the original size plus one byte", async t => {
  const directory = temporaryDirectory("readonly-growth"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  const file = writer.blobPath(metadata.storageKey), originalSize = fs.statSync(file).size, actualRead = fs.readSync;
  let grew = false, readBytes = 0;
  const controlled = t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    if (!grew) { grew = true; fs.appendFileSync(file, Buffer.alloc(MAX_DOCUMENT_BYTES + 1024)); }
    assert.ok(length <= originalSize + 1); assert.ok(length <= 65536);
    const count = actualRead(fd, buffer, offset, length, position); readBytes += count; return count;
  });
  try { assert.throws(() => reader.readBuffer(metadata), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" }); }
  finally { controlled.mock.restore(); }
  assert.equal(grew, true); assert.ok(readBytes > originalSize); assert.ok(readBytes <= originalSize + 1);
});

test("read-only key checks, fallback scans and failed metadata reads erase discarded plaintext buffers", async t => {
  const directory = temporaryDirectory("readonly-zero"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const plain = pdfBuffer(), metadata = await writer.saveBuffer({ buffer: plain, originalName: "proof.pdf" });
  const actualConcat = Buffer.concat, captured = [];
  const control = t.mock.method(Buffer, "concat", (...args) => {
    const value = actualConcat(...args);
    if (value.equals(plain) || value.equals(Buffer.from("Grabenplaner AMU key check v1"))) captured.push(value);
    return value;
  });
  try {
    const reader = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
    assert.throws(() => reader.readBuffer({ ...metadata, sha256: "0".repeat(64) }), { code: "AMU_DOCUMENT_INTEGRITY_FAILED" });
    fs.unlinkSync(path.join(directory, "key-check.amu"));
    createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example", readOnly: true });
  } finally { control.mock.restore(); }
  assert.equal(captured.length, 3, "Capture the actual key-check, failed document read and no-key-check fallback plaintext.");
  assert.ok(captured.every(buffer => buffer.every(byte => byte === 0)));
  assert.equal(fs.existsSync(path.join(directory, "key-check.amu")), false);
});

test("read-only FD open rejects a regular-file to FIFO swap without blocking the actual Linux child", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const directory = temporaryDirectory("readonly-fifo"), writer = createAmuStorage({ rootDirectory: directory, encryptionKeys: { example: key() }, activeKeyId: "example" });
  const metadata = await writer.saveBuffer({ buffer: pdfBuffer(), originalName: "proof.pdf" });
  const code = `const assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
    const storage=require(process.argv[1]).createAmuStorage({rootDirectory:process.argv[2],encryptionKeys:{example:Buffer.alloc(32,7)},activeKeyId:'example',readOnly:true});
    const file=process.argv[3],actualOpen=fs.openSync;let swapped=false;
    fs.openSync=(target,...args)=>{if(target===file&&!swapped){swapped=true;fs.unlinkSync(file);const made=spawnSync('/usr/bin/mkfifo',[file],{timeout:1000});assert.equal(made.status,0);}return actualOpen(target,...args);};
    assert.throws(()=>storage.readBuffer(JSON.parse(process.argv[4])),{code:'AMU_DOCUMENT_INTEGRITY_FAILED'});assert.equal(swapped,true);console.log('FIFO_REJECTED');`;
  const result = require("node:child_process").spawnSync(process.execPath, ["-e", code, path.resolve(__dirname, "../lib/amu-storage.js"), directory, writer.blobPath(metadata.storageKey), JSON.stringify(metadata)],
    { env: { PATH: "/usr/bin:/bin" }, timeout: 3000, encoding: "utf8" });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "FIFO_REJECTED");
});

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

for (const parentMode of [0o1777, 0o755]) {
  test(`Backup und Restore erhalten bestehende Elternrechte ${parentMode.toString(8)}`, async (t) => {
    const root = temporaryDirectory("parent-permissions");
    const parent = path.join(root, "shared-parent");
    fs.mkdirSync(parent);
    fs.chmodSync(parent, parentMode);
    const originalParentMode = fs.statSync(parent).mode & 0o7777;
    const source = path.join(root, "source");
    const backupDirectory = path.join(parent, "snapshot");
    const target = path.join(parent, "restored");
    const storage = createAmuStorage({
      rootDirectory: source,
      encryptionKeys: { primary: key() },
      activeKeyId: "primary",
      scanner: async () => true,
    });
    const metadata = await storage.saveBuffer({ buffer: pdfBuffer("Elternrechte"), originalName: "amu.pdf" });
    const parentChmods = [];
    const originalChmod = fs.chmodSync;
    // Windows does not implement POSIX directory modes; still reject any attempt
    // to change the shared parent's permissions on every supported platform.
    t.mock.method(fs, "chmodSync", (directory, mode) => {
      if (path.resolve(directory) === parent) parentChmods.push(mode);
      return originalChmod(directory, mode);
    });
    const assertParentUnchanged = () => {
      assert.deepEqual(parentChmods, []);
      assert.equal(fs.statSync(parent).mode & 0o7777, originalParentMode);
    };
    syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: backupDirectory });
    assertParentUnchanged();
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "previous.txt"), "vorher");
    restoreEncryptedFilesBackup({ backupDirectory, targetDirectory: target });
    assertParentUnchanged();
    assert.equal(fs.existsSync(path.join(target, "previous.txt")), false);
    if (process.platform !== "win32") {
      assert.equal(originalParentMode, parentMode);
      for (const directory of [backupDirectory, target]) {
        assert.equal(fs.statSync(directory).mode & 0o7777, 0o700);
        assert.equal(fs.statSync(path.join(directory, "blobs")).mode & 0o7777, 0o700);
      }
    }
    const restoredStorage = createAmuStorage({ rootDirectory: target, encryptionKeys: { primary: key() }, activeKeyId: "primary" });
    assert.deepEqual(restoredStorage.readBuffer(metadata), pdfBuffer("Elternrechte"));
  });
}

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
