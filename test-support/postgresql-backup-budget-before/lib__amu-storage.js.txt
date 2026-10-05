"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256File } = require("./file-integrity");

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ENCRYPTED_FILE_MAGIC = Buffer.from("GPAMU001", "ascii");
const ENCRYPTED_FILE_MAGIC_V2 = Buffer.from("GPAMU002", "ascii");
const ENCRYPTION_VERSION = "aes-256-gcm-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 255;
const BACKUP_FORMAT = "grabenplaner-amu-backup";
const BACKUP_VERSION = 1;
const METADATA_PREFIX = "enc:v1:";
const PROTECTED_RECORD_PREFIX = "enc:v2:";
const METADATA_AAD = Buffer.from("grabenplaner-amu-metadata-v1", "utf8");
const PROTECTED_RECORD_AAD_PREFIX = "grabenplaner-protected-record-v2";
const PROTECTED_BLOB_AAD_PREFIX = "grabenplaner-protected-blob-v2";
const KEY_CHECK_FILE = "key-check.amu";
const KEY_CHECK_PAYLOAD = Buffer.from("Grabenplaner AMU key check v1", "utf8");
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;

class AmuStorageError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "AmuStorageError";
    this.code = code;
  }
}

function storageError(message, code, cause) {
  return new AmuStorageError(message, code, cause ? { cause } : undefined);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function writeExclusiveAndSync(filePath, buffer) {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removePathQuietly(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function removePlaintextFileQuietly(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    }
    const descriptor = fs.openSync(target, "r+");
    try {
      const zeros = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
      for (let offset = 0; offset < stat.size; offset += zeros.length) {
        fs.writeSync(descriptor, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {}
  try { fs.rmSync(target, { force: true }); } catch {}
}

function purgeStaleTempFiles(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      continue;
    }
    if (!stat.isFile()) throw storageError("Der temporäre AMU-Ordner enthält einen unzulässigen Eintrag.", "AMU_TEMP_ENTRY_INVALID");
    try {
      const descriptor = fs.openSync(target, "r+");
      try {
        const zeros = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
        for (let offset = 0; offset < stat.size; offset += zeros.length) {
          fs.writeSync(descriptor, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
        }
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
    } catch {}
    fs.rmSync(target, { force: true });
  }
}

function sanitizeOriginalFilename(name) {
  let value = String(name || "").normalize("NFC");
  value = value.replaceAll("\\", "/").split("/").pop() || "";
  value = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  if (!value) value = "Dokument";
  if (value.length <= 120) return value;
  const extension = path.extname(value).slice(0, 16);
  const stemLength = Math.max(1, 120 - extension.length);
  return `${value.slice(0, stemLength).trim()}${extension}`;
}

function detectedDocument(mimeType, extension, originalName) {
  const sanitized = sanitizeOriginalFilename(originalName);
  const stem = path.basename(sanitized, path.extname(sanitized)).replace(/[. ]+$/g, "") || "Dokument";
  const safeFilename = `${stem.slice(0, Math.max(1, 120 - extension.length - 1))}.${extension}`;
  return { mimeType, extension, safeFilename };
}

function normalizeMaxBytes(maxBytes, fallback = MAX_DOCUMENT_BYTES) {
  const value = maxBytes === undefined || maxBytes === null ? fallback : Number(maxBytes);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw storageError("Das Größenlimit für AMU-Dokumente ist ungültig.", "AMU_DOCUMENT_LIMIT_INVALID");
  }
  return value;
}

function formatByteLimit(maxBytes) {
  const mebibytes = maxBytes / (1024 * 1024);
  return Number.isInteger(mebibytes)
    ? `${mebibytes} MiB`
    : `${Math.round(mebibytes * 10) / 10} MiB`;
}

function detectDocumentType(buffer, originalName = "Dokument", options = {}) {
  const maxBytes = normalizeMaxBytes(
    typeof options === "number" ? options : options?.maxBytes,
    MAX_DOCUMENT_BYTES,
  );
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw storageError("Die Dokumentdatei ist leer oder ungültig.", "AMU_DOCUMENT_INVALID");
  }
  if (buffer.length > maxBytes) {
    throw storageError(`Die Dokumentdatei darf höchstens ${formatByteLimit(maxBytes)} groß sein.`, "AMU_DOCUMENT_TOO_LARGE");
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    return detectedDocument("application/pdf", "pdf", originalName);
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return detectedDocument("image/jpeg", "jpg", originalName);
  }
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= pngMagic.length && buffer.subarray(0, pngMagic.length).equals(pngMagic)) {
    return detectedDocument("image/png", "png", originalName);
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return detectedDocument("image/webp", "webp", originalName);
  }
  if (buffer.length >= 4
    && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) {
    return detectedDocument("image/tiff", "tiff", originalName);
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp"
    && /^(hei[cf]|heix|hevc|mif1|msf1)$/.test(buffer.subarray(8, 12).toString("ascii"))) {
    throw storageError("HEIC-Dateien werden derzeit nicht unterstützt. Bitte als JPG, PNG oder PDF hochladen.", "AMU_HEIC_UNSUPPORTED");
  }
  throw storageError("Nur PDF-, JPG-, PNG-, WEBP- und TIFF-Dateien werden unterstützt.", "AMU_DOCUMENT_TYPE_UNSUPPORTED");
}

function normalizeEncryptionKeys(encryptionKeys) {
  const entries = encryptionKeys instanceof Map
    ? [...encryptionKeys.entries()]
    : Object.entries(encryptionKeys || {});
  const result = new Map();
  for (const [rawId, rawKey] of entries) {
    const id = String(rawId || "").trim();
    if (!id || Buffer.byteLength(id, "utf8") > MAX_KEY_ID_BYTES) {
      throw storageError("Eine AMU-Schlüsselkennung ist ungültig.", "AMU_ENCRYPTION_KEY_ID_INVALID");
    }
    let key;
    if (Buffer.isBuffer(rawKey)) key = Buffer.from(rawKey);
    else if (typeof rawKey === "string") {
      const value = rawKey.trim();
      key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    } else key = Buffer.alloc(0);
    if (key.length !== 32) {
      throw storageError(`Der AMU-Schlüssel „${id}“ muss genau 32 Byte lang sein.`, "AMU_ENCRYPTION_KEY_INVALID");
    }
    result.set(id, key);
  }
  return result;
}

function runScannerCommand(command, args, engine) {
  return new Promise((resolve, reject) => {
    const process = childProcess.spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let totalOutput = 0;
    const capture = (chunks) => (chunk) => {
      if (totalOutput >= 16 * 1024) return;
      const value = Buffer.from(chunk).subarray(0, 16 * 1024 - totalOutput);
      totalOutput += value.length;
      chunks.push(value);
    };
    process.stdout.on("data", capture(stdout));
    process.stderr.on("data", capture(stderr));
    process.once("error", reject);
    process.once("close", (code) => resolve({
      code: Number(code),
      engine,
      output: Buffer.concat([...stdout, ...stderr]).toString("utf8").trim().slice(0, 2000),
    }));
  });
}

function defenderCandidates() {
  const candidates = [];
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (base) candidates.push(path.join(base, "Windows Defender", "MpCmdRun.exe"));
  }
  const platformRoot = process.env.ProgramData
    ? path.join(process.env.ProgramData, "Microsoft", "Windows Defender", "Platform")
    : "";
  if (platformRoot && fs.existsSync(platformRoot)) {
    const versions = fs.readdirSync(platformRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) candidates.unshift(path.join(platformRoot, version, "MpCmdRun.exe"));
  }
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

async function scanWithAvailableEngine(filePath, { requireScanner = false } = {}) {
  const resolved = path.resolve(String(filePath || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw storageError("Die temporäre AMU-Datei wurde nicht gefunden.", "AMU_SCAN_FILE_MISSING");
  }

  const attempts = [];
  for (const candidate of defenderCandidates()) {
    attempts.push({
      engine: "Microsoft Defender",
      command: candidate,
      args: ["-Scan", "-ScanType", "3", "-File", resolved],
      cleanCodes: new Set([0]),
      threatCodes: new Set([2]),
      threatPattern: /(threat|malware|bedrohung|schadsoftware).*(found|found and not remediated|gefunden)|found.*(threat|malware)/i,
    });
  }
  attempts.push({
    engine: "ClamAV",
    command: process.platform === "win32" ? "clamscan.exe" : "clamscan",
    args: ["--no-summary", "--", resolved],
    cleanCodes: new Set([0]),
    threatCodes: new Set([1]),
  });

  let lastScannerError = null;
  for (const attempt of attempts) {
    try {
      const result = await runScannerCommand(attempt.command, attempt.args, attempt.engine);
      if (attempt.cleanCodes.has(result.code)) {
        return { available: true, clean: true, engine: attempt.engine, detail: result.output };
      }
      if (attempt.threatCodes.has(result.code)) {
        if (attempt.threatPattern && !attempt.threatPattern.test(result.output || "")) {
          throw storageError(`${attempt.engine} konnte die Datei nicht zuverlässig prüfen.`, "AMU_SCANNER_FAILED");
        }
        return { available: true, clean: false, engine: attempt.engine, detail: result.output || "Bedrohung erkannt." };
      }
      throw storageError(`${attempt.engine} konnte die Datei nicht zuverlässig prüfen.`, "AMU_SCANNER_FAILED");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof AmuStorageError) {
        lastScannerError = error;
        continue;
      }
      lastScannerError = storageError("Der Virenscanner konnte nicht gestartet werden.", "AMU_SCANNER_FAILED", error);
    }
  }
  if (requireScanner) {
    if (lastScannerError) throw lastScannerError;
    throw storageError("Es ist kein unterstützter Virenscanner verfügbar.", "AMU_SCANNER_UNAVAILABLE");
  }
  return { available: false, clean: true, engine: null, detail: "Kein Virenscanner verfügbar; Prüfung war nicht verpflichtend." };
}

async function runConfiguredScanner(scanner, filePath, requireScanner) {
  if (!scanner) return scanWithAvailableEngine(filePath, { requireScanner });
  let result;
  try {
    result = typeof scanner === "function" ? await scanner(filePath) : await scanner.scan(filePath);
  } catch (error) {
    throw storageError("Der Virenscanner konnte die Datei nicht prüfen.", "AMU_SCANNER_FAILED", error);
  }
  if (typeof result === "boolean") result = { available: true, clean: result, engine: "configured" };
  if (!result || typeof result.clean !== "boolean") {
    throw storageError("Der Virenscanner hat kein gültiges Ergebnis geliefert.", "AMU_SCANNER_RESULT_INVALID");
  }
  if (requireScanner && result.available === false) {
    throw storageError("Der verpflichtende Virenscanner ist nicht verfügbar.", "AMU_SCANNER_UNAVAILABLE");
  }
  return {
    available: result.available !== false,
    clean: result.clean,
    engine: result.engine || "configured",
    detail: String(result.detail || "").slice(0, 2000),
  };
}

function createStorageKey() {
  const id = crypto.randomUUID();
  return `${id.slice(0, 2)}/${id}.amu`;
}

function validateStorageKey(storageKey) {
  const value = String(storageKey || "").replaceAll("\\", "/").toLowerCase();
  if (!STORAGE_KEY_PATTERN.test(value)) {
    throw storageError("Der AMU-Speicherschlüssel ist ungültig.", "AMU_STORAGE_KEY_INVALID");
  }
  return value;
}

function encryptedFileVersion(encrypted) {
  if (!Buffer.isBuffer(encrypted)) return 0;
  if (encrypted.subarray(0, ENCRYPTED_FILE_MAGIC_V2.length).equals(ENCRYPTED_FILE_MAGIC_V2)) return 2;
  if (encrypted.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC)) return 1;
  return 0;
}

function protectedBlobAad(storageKey) {
  return Buffer.from(`${PROTECTED_BLOB_AAD_PREFIX}\0${validateStorageKey(storageKey)}`, "utf8");
}

function encryptDocument(buffer, keyId, key, { aad = null, version = 1 } = {}) {
  const keyIdBuffer = Buffer.from(keyId, "utf8");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (version === 2) {
    if (!Buffer.isBuffer(aad) || !aad.length) throw storageError("Für die geschützte AMU-Datei fehlt die Kontextbindung.", "AMU_DOCUMENT_CONTEXT_REQUIRED");
    cipher.setAAD(aad);
  }
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const magic = version === 2 ? ENCRYPTED_FILE_MAGIC_V2 : ENCRYPTED_FILE_MAGIC;
  const header = Buffer.alloc(magic.length + 1 + IV_BYTES + TAG_BYTES + keyIdBuffer.length);
  let offset = 0;
  magic.copy(header, offset); offset += magic.length;
  header[offset] = keyIdBuffer.length; offset += 1;
  iv.copy(header, offset); offset += IV_BYTES;
  tag.copy(header, offset); offset += TAG_BYTES;
  keyIdBuffer.copy(header, offset);
  return { encrypted: Buffer.concat([header, encrypted]), iv, tag, version };
}

function decryptDocument(encrypted, keys, { aad = null } = {}) {
  const version = encryptedFileVersion(encrypted);
  const magic = version === 2 ? ENCRYPTED_FILE_MAGIC_V2 : ENCRYPTED_FILE_MAGIC;
  const minimum = magic.length + 1 + IV_BYTES + TAG_BYTES;
  if (!version || encrypted.length <= minimum) {
    throw storageError("Die AMU-Datei hat ein ungültiges verschlüsseltes Format.", "AMU_ENCRYPTED_FILE_INVALID");
  }
  if (version === 2 && (!Buffer.isBuffer(aad) || !aad.length)) {
    throw storageError("Für die geschützte AMU-Datei fehlt die Kontextbindung.", "AMU_DOCUMENT_CONTEXT_REQUIRED");
  }
  let offset = magic.length;
  const keyIdLength = encrypted[offset]; offset += 1;
  if (!keyIdLength || encrypted.length <= minimum + keyIdLength) {
    throw storageError("Der Schlüsselverweis der AMU-Datei ist ungültig.", "AMU_ENCRYPTED_FILE_INVALID");
  }
  const iv = encrypted.subarray(offset, offset + IV_BYTES); offset += IV_BYTES;
  const tag = encrypted.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES;
  const keyId = encrypted.subarray(offset, offset + keyIdLength).toString("utf8"); offset += keyIdLength;
  const key = keys.get(keyId);
  if (!key) throw storageError(`Der AMU-Schlüssel „${keyId}“ ist nicht verfügbar.`, "AMU_ENCRYPTION_KEY_UNAVAILABLE");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    if (version === 2) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return { buffer: Buffer.concat([decipher.update(encrypted.subarray(offset)), decipher.final()]), keyId, iv, tag, version };
  } catch (error) {
    throw storageError("Die AMU-Datei ist beschädigt oder wurde verändert.", "AMU_DOCUMENT_INTEGRITY_FAILED", error);
  }
}

function createAmuStorage({
  rootDirectory,
  encryptionKeys,
  activeKeyId,
  scanner = null,
  requireScanner = false,
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
} = {}) {
  if (!rootDirectory) throw storageError("Für AMU-Dateien fehlt das private Speicherverzeichnis.", "AMU_STORAGE_ROOT_REQUIRED");
  const configuredMaxDocumentBytes = normalizeMaxBytes(maxDocumentBytes, MAX_DOCUMENT_BYTES);
  const root = path.resolve(String(rootDirectory));
  const tempDirectory = path.join(root, "tmp");
  const blobsDirectory = path.join(root, "blobs");
  const keys = normalizeEncryptionKeys(encryptionKeys);
  const currentKeyId = String(activeKeyId || "").trim();
  if (!keys.has(currentKeyId)) {
    throw storageError("Der aktive AMU-Verschlüsselungsschlüssel ist nicht verfügbar.", "AMU_ACTIVE_KEY_UNAVAILABLE");
  }
  safeMkdir(root);
  safeMkdir(tempDirectory);
  safeMkdir(blobsDirectory);
  purgeStaleTempFiles(tempDirectory);
  const keyCheckPath = path.join(root, KEY_CHECK_FILE);
  if (fs.existsSync(keyCheckPath)) {
    const checked = decryptDocument(fs.readFileSync(keyCheckPath), keys);
    if (!checked.buffer.equals(KEY_CHECK_PAYLOAD)) throw storageError("Der AMU-Schlüsselprüfwert ist ungültig.", "AMU_KEY_CHECK_INVALID");
  } else {
    for (const file of listEncryptedFiles(root).files) {
      const encrypted = fs.readFileSync(file.path);
      decryptDocument(encrypted, keys, encryptedFileVersion(encrypted) === 2 ? { aad: protectedBlobAad(file.storageKey) } : {});
    }
    writeExclusiveAndSync(keyCheckPath, encryptDocument(KEY_CHECK_PAYLOAD, currentKeyId, keys.get(currentKeyId)).encrypted);
  }
  let scannerHealth = {
    checked: !requireScanner || Boolean(scanner),
    available: Boolean(scanner),
    clean: true,
    engine: scanner ? "configured" : null,
    error: "",
  };

  function blobPath(storageKey) {
    const normalized = validateStorageKey(storageKey);
    const target = path.resolve(blobsDirectory, ...normalized.split("/"));
    const prefix = `${path.resolve(blobsDirectory)}${path.sep}`;
    if (!target.startsWith(prefix)) throw storageError("Der AMU-Speicherpfad ist ungültig.", "AMU_STORAGE_KEY_INVALID");
    return target;
  }

  async function scanTemporaryFile(filePath) {
    let scan;
    try {
      scan = await runConfiguredScanner(scanner, filePath, Boolean(requireScanner));
      scannerHealth = {
        checked: true,
        available: scan.available !== false,
        clean: scan.clean,
        engine: scan.engine || null,
        error: "",
      };
    } catch (error) {
      scannerHealth = { checked: true, available: false, clean: false, engine: null, error: error.message };
      throw error;
    }
    if (!scan.clean) {
      throw storageError("Die Datei wurde vom Virenscanner abgelehnt.", "AMU_DOCUMENT_SCAN_REJECTED");
    }
    return scan;
  }

  async function scanBuffer({ buffer, originalName, maxBytes } = {}) {
    const effectiveMaxBytes = normalizeMaxBytes(maxBytes, configuredMaxDocumentBytes);
    const type = detectDocumentType(buffer, originalName, { maxBytes: effectiveMaxBytes });
    const plainTemp = path.join(tempDirectory, `${crypto.randomUUID()}.scan`);
    try {
      writeExclusiveAndSync(plainTemp, buffer);
      const scan = await scanTemporaryFile(plainTemp);
      return {
        ...scan,
        detectedMime: type.mimeType,
        byteSize: buffer.length,
      };
    } finally {
      removePlaintextFileQuietly(plainTemp);
    }
  }

  async function saveBuffer({ buffer, originalName, maxBytes } = {}) {
    const effectiveMaxBytes = normalizeMaxBytes(maxBytes, configuredMaxDocumentBytes);
    const type = detectDocumentType(buffer, originalName, { maxBytes: effectiveMaxBytes });
    const storageKey = createStorageKey();
    const finalPath = blobPath(storageKey);
    const plainTemp = path.join(tempDirectory, `${crypto.randomUUID()}.upload`);
    const encryptedTemp = path.join(tempDirectory, `${crypto.randomUUID()}.encrypted`);
    let moved = false;
    try {
      writeExclusiveAndSync(plainTemp, buffer);
      const scan = await scanTemporaryFile(plainTemp);
      const encryptedDocument = encryptDocument(buffer, currentKeyId, keys.get(currentKeyId), {
        version: 2,
        aad: protectedBlobAad(storageKey),
      });
      writeExclusiveAndSync(encryptedTemp, encryptedDocument.encrypted);
      safeMkdir(path.dirname(finalPath));
      fs.renameSync(encryptedTemp, finalPath);
      moved = true;
      return {
        storageKey,
        originalFilename: type.safeFilename,
        detectedMime: type.mimeType,
        extension: type.extension,
        byteSize: buffer.length,
        sha256: sha256(buffer),
        encryptionVersion: ENCRYPTION_VERSION,
        encryptionKeyId: currentKeyId,
        scanStatus: scan.available ? "clean" : "unavailable",
        scanEngine: scan.engine,
        createdAt: new Date().toISOString(),
      };
    } finally {
      removePlaintextFileQuietly(plainTemp);
      if (!moved) removePathQuietly(encryptedTemp);
    }
  }

  function readBuffer(metadata = {}) {
    const storageKey = typeof metadata === "string" ? metadata : metadata.storageKey;
    const filePath = blobPath(storageKey);
    let encrypted;
    try { encrypted = fs.readFileSync(filePath); }
    catch (error) {
      if (error.code === "ENOENT") throw storageError("Die AMU-Datei wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND", error);
      throw error;
    }
    const decrypted = decryptDocument(encrypted, keys, encryptedFileVersion(encrypted) === 2
      ? { aad: protectedBlobAad(storageKey) }
      : {});
    if (typeof metadata === "object" && metadata) {
      if (metadata.byteSize !== undefined && Number(metadata.byteSize) !== decrypted.buffer.length) {
        throw storageError("Die Größe der AMU-Datei stimmt nicht mit den Metadaten überein.", "AMU_DOCUMENT_INTEGRITY_FAILED");
      }
      if (metadata.sha256 && String(metadata.sha256).toLowerCase() !== sha256(decrypted.buffer)) {
        throw storageError("Die Prüfsumme der AMU-Datei stimmt nicht mit den Metadaten überein.", "AMU_DOCUMENT_INTEGRITY_FAILED");
      }
      if (metadata.detectedMime) {
        const detected = detectDocumentType(decrypted.buffer, metadata.originalFilename || "Dokument", {
          maxBytes: Math.max(configuredMaxDocumentBytes, decrypted.buffer.length),
        });
        if (detected.mimeType !== metadata.detectedMime) {
          throw storageError("Der Dokumenttyp stimmt nicht mit den Metadaten überein.", "AMU_DOCUMENT_INTEGRITY_FAILED");
        }
      }
    }
    return decrypted.buffer;
  }

  function deleteBlob(storageKey) {
    const filePath = blobPath(storageKey);
    try {
      fs.rmSync(filePath, { force: false });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  function protectText(value) {
    const text = String(value || "");
    if (!text) return text;
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(currentKeyId), iv);
    cipher.setAAD(METADATA_AAD);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const payload = Buffer.concat([Buffer.from([Buffer.byteLength(currentKeyId, "utf8")]), Buffer.from(currentKeyId, "utf8"), iv, cipher.getAuthTag(), encrypted]);
    return `${METADATA_PREFIX}${payload.toString("base64url")}`;
  }

  function unprotectText(value) {
    const text = String(value || "");
    if (!text.startsWith(METADATA_PREFIX)) return text;
    try {
      const payload = Buffer.from(text.slice(METADATA_PREFIX.length), "base64url");
      const keyIdLength = payload[0];
      const keyId = payload.subarray(1, 1 + keyIdLength).toString("utf8");
      let offset = 1 + keyIdLength;
      const iv = payload.subarray(offset, offset + IV_BYTES); offset += IV_BYTES;
      const tag = payload.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES;
      const key = keys.get(keyId);
      if (!key || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("metadata key unavailable");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(METADATA_AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload.subarray(offset)), decipher.final()]).toString("utf8");
    } catch (error) {
      throw storageError("Geschützte AMU-Metadaten sind beschädigt oder der Schlüssel fehlt.", "AMU_METADATA_INTEGRITY_FAILED", error);
    }
  }

  function protectedRecordAad(context = {}) {
    const normalized = {
      namespace: String(context.namespace || "").trim(),
      recordId: String(context.recordId || "").trim(),
      field: String(context.field || "").trim(),
      employeeNumber: String(context.employeeNumber || "").trim(),
    };
    if (!normalized.namespace || !normalized.recordId || !normalized.field || !normalized.employeeNumber) {
      throw storageError("Für geschützte Personalakt-Daten fehlt der Datensatzkontext.", "PERSONNEL_RECORD_CONTEXT_REQUIRED");
    }
    return Buffer.from(`${PROTECTED_RECORD_AAD_PREFIX}\0${JSON.stringify(normalized)}`, "utf8");
  }

  function protectRecord(value, context) {
    const text = String(value ?? "");
    const keyIdBuffer = Buffer.from(currentKeyId, "utf8");
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(currentKeyId), iv);
    cipher.setAAD(protectedRecordAad(context));
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const payload = Buffer.concat([Buffer.from([keyIdBuffer.length]), keyIdBuffer, iv, cipher.getAuthTag(), encrypted]);
    return `${PROTECTED_RECORD_PREFIX}${payload.toString("base64url")}`;
  }

  function unprotectRecord(value, context, { allowLegacy = false, allowPlaintext = false } = {}) {
    const text = String(value ?? "");
    if (!text.startsWith(PROTECTED_RECORD_PREFIX)) {
      if (allowLegacy && text.startsWith(METADATA_PREFIX)) return unprotectText(text);
      if (allowPlaintext) return text;
      throw storageError("Geschützte Personalakt-Daten liegen nicht im erwarteten Format vor.", "PERSONNEL_RECORD_PLAINTEXT_REJECTED");
    }
    try {
      const payload = Buffer.from(text.slice(PROTECTED_RECORD_PREFIX.length), "base64url");
      const keyIdLength = payload[0];
      const keyId = payload.subarray(1, 1 + keyIdLength).toString("utf8");
      let offset = 1 + keyIdLength;
      const iv = payload.subarray(offset, offset + IV_BYTES); offset += IV_BYTES;
      const tag = payload.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES;
      const key = keys.get(keyId);
      if (!key || !keyIdLength || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("record key unavailable");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(protectedRecordAad(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload.subarray(offset)), decipher.final()]).toString("utf8");
    } catch (error) {
      if (error instanceof AmuStorageError) throw error;
      throw storageError("Geschützte Personalakt-Daten sind beschädigt, vertauscht oder der Schlüssel fehlt.", "PERSONNEL_RECORD_INTEGRITY_FAILED", error);
    }
  }

  async function probeScanner() {
    const probe = path.join(tempDirectory, `.scanner-probe-${crypto.randomUUID()}.txt`);
    try {
      writeExclusiveAndSync(probe, Buffer.from("Grabenplaner AMU scanner readiness probe\n", "utf8"));
      const result = await runConfiguredScanner(scanner, probe, Boolean(requireScanner));
      scannerHealth = { checked: true, available: result.available !== false, clean: result.clean, engine: result.engine || null, error: "" };
      return { ...scannerHealth };
    } catch (error) {
      scannerHealth = { checked: true, available: false, clean: false, engine: null, error: error.message };
      throw error;
    } finally {
      removePathQuietly(probe);
    }
  }

  function diagnostics() {
    const probe = path.join(tempDirectory, `.probe-${crypto.randomUUID()}`);
    let writable = false;
    let error = "";
    try {
      writeExclusiveAndSync(probe, Buffer.from("probe"));
      writable = true;
    } catch (caught) {
      error = caught.message;
    } finally {
      removePathQuietly(probe);
    }
    return {
      ok: writable && keys.has(currentKeyId) && (!requireScanner || (scannerHealth.checked && scannerHealth.available && scannerHealth.clean)),
      rootDirectory: root,
      writable,
      activeKeyId: currentKeyId,
      keyCount: keys.size,
      scannerConfigured: Boolean(scanner),
      scannerChecked: scannerHealth.checked,
      scannerAvailable: scannerHealth.available,
      scannerEngine: scannerHealth.engine,
      requireScanner: Boolean(requireScanner),
      maxDocumentBytes: configuredMaxDocumentBytes,
      allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"],
      error: error || scannerHealth.error,
    };
  }

  return {
    saveBuffer,
    scanBuffer,
    readBuffer,
    deleteBlob,
    blobPath,
    diagnostics,
    protectText,
    unprotectText,
    protectRecord,
    unprotectRecord,
    probeScanner,
    listStorageKeys: () => listEncryptedFiles(root).files.map((file) => file.storageKey),
  };
}

function listEncryptedFiles(sourceDirectory) {
  const root = path.resolve(sourceDirectory);
  const blobRoot = fs.existsSync(path.join(root, "blobs")) ? path.join(root, "blobs") : root;
  if (!fs.existsSync(blobRoot)) return { blobRoot, files: [] };
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw storageError("Symbolische Links sind im AMU-Speicher nicht zulässig.", "AMU_BACKUP_SYMLINK_REJECTED");
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        const storageKey = path.relative(blobRoot, entryPath).split(path.sep).join("/").toLowerCase();
        validateStorageKey(storageKey);
        files.push({ storageKey, path: entryPath });
      }
    }
  }
  visit(blobRoot);
  files.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  return { blobRoot, files };
}

function atomicReplaceDirectory(preparedDirectory, targetDirectory) {
  const target = path.resolve(targetDirectory);
  safeMkdir(path.dirname(target));
  const rollback = `${target}.rollback-${crypto.randomUUID()}`;
  const hadTarget = fs.existsSync(target);
  let oldMoved = false;
  try {
    if (hadTarget) {
      fs.renameSync(target, rollback);
      oldMoved = true;
    }
    fs.renameSync(preparedDirectory, target);
    if (oldMoved) removePathQuietly(rollback);
  } catch (error) {
    if (!fs.existsSync(target) && oldMoved && fs.existsSync(rollback)) {
      try { fs.renameSync(rollback, target); } catch {}
    }
    throw error;
  } finally {
    if (fs.existsSync(preparedDirectory)) removePathQuietly(preparedDirectory);
    if (fs.existsSync(rollback) && fs.existsSync(target)) removePathQuietly(rollback);
  }
}

function syncEncryptedFilesBackup({ sourceDirectory, targetDirectory, manifestMetadata = {} } = {}) {
  if (!sourceDirectory || !targetDirectory) throw storageError("Quell- und Zielordner für das AMU-Backup fehlen.", "AMU_BACKUP_PATH_REQUIRED");
  const target = path.resolve(targetDirectory);
  const prepared = `${target}.tmp-${crypto.randomUUID()}`;
  safeMkdir(path.join(prepared, "blobs"));
  try {
    const sourceRoot = path.resolve(sourceDirectory);
    const keyCheckSource = path.join(sourceRoot, KEY_CHECK_FILE);
    if (!fs.existsSync(keyCheckSource)) throw storageError("Dem AMU-Speicher fehlt der Schlüsselprüfwert.", "AMU_KEY_CHECK_MISSING");
    const keyCheckContent = fs.readFileSync(keyCheckSource);
    if (!keyCheckContent.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC)) {
      throw storageError("Der AMU-Schlüsselprüfwert ist ungültig.", "AMU_KEY_CHECK_INVALID");
    }
    writeExclusiveAndSync(path.join(prepared, KEY_CHECK_FILE), keyCheckContent);
    const { files } = listEncryptedFiles(sourceDirectory);
    const manifestFiles = [];
    for (const file of files) {
      const content = fs.readFileSync(file.path);
      if (!encryptedFileVersion(content)) {
        throw storageError(`Die AMU-Datei ${file.storageKey} ist nicht gültig verschlüsselt.`, "AMU_BACKUP_SOURCE_INVALID");
      }
      const targetPath = path.join(prepared, "blobs", ...file.storageKey.split("/"));
      safeMkdir(path.dirname(targetPath));
      writeExclusiveAndSync(targetPath, content);
      manifestFiles.push({ storageKey: file.storageKey, byteSize: content.length, sha256: sha256(content) });
    }
    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      ...manifestMetadata,
      keyCheck: { fileName: KEY_CHECK_FILE, byteSize: keyCheckContent.length, sha256: sha256(keyCheckContent) },
      files: manifestFiles,
    };
    writeExclusiveAndSync(path.join(prepared, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
    atomicReplaceDirectory(prepared, target);
    return { targetDirectory: target, fileCount: manifestFiles.length, manifest };
  } catch (error) {
    removePathQuietly(prepared);
    throw error;
  }
}

function validateEncryptionKeyForStorage({ sourceDirectory, encryptionKeys, activeKeyId } = {}) {
  const keys = normalizeEncryptionKeys(encryptionKeys);
  try {
    if (!keys.has(String(activeKeyId || ""))) throw storageError("Der aktive AMU-Schlüssel fehlt.", "AMU_ACTIVE_KEY_UNAVAILABLE");
    const keyCheckPath = path.join(path.resolve(sourceDirectory), KEY_CHECK_FILE);
    if (fs.existsSync(keyCheckPath)) {
      const checked = decryptDocument(fs.readFileSync(keyCheckPath), keys);
      try {
        if (!checked.buffer.equals(KEY_CHECK_PAYLOAD)) throw storageError("Der AMU-Schlüsselprüfwert ist ungültig.", "AMU_KEY_CHECK_INVALID");
      } finally { checked.buffer.fill(0); }
    }
    const { files } = listEncryptedFiles(sourceDirectory);
    for (const file of files) {
      const encrypted = fs.readFileSync(file.path);
      const checked = decryptDocument(encrypted, keys, encryptedFileVersion(encrypted) === 2 ? { aad: protectedBlobAad(file.storageKey) } : {});
      checked.buffer.fill(0);
    }
    return { ok: true, fileCount: files.length };
  } finally {
    for (const key of keys.values()) key.fill(0);
  }
}

function readAndVerifyBackup(backupDirectory, { includeContent = true } = {}) {
  const backup = path.resolve(backupDirectory);
  const manifestPath = path.join(backup, "manifest.json");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (error) { throw storageError("Das AMU-Backup enthält kein gültiges Manifest.", "AMU_BACKUP_MANIFEST_INVALID", error); }
  if (manifest?.format !== BACKUP_FORMAT || manifest?.version !== BACKUP_VERSION || !Array.isArray(manifest.files)) {
    throw storageError("Das AMU-Backupformat wird nicht unterstützt.", "AMU_BACKUP_MANIFEST_INVALID");
  }
  const keyCheckPath = path.join(backup, KEY_CHECK_FILE);
  const keyCheckContent = fs.readFileSync(keyCheckPath);
  if (manifest.keyCheck?.fileName !== KEY_CHECK_FILE || keyCheckContent.length !== Number(manifest.keyCheck?.byteSize)
    || sha256(keyCheckContent) !== String(manifest.keyCheck?.sha256 || "").toLowerCase()
    || !keyCheckContent.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC)) {
    throw storageError("Der Schlüsselprüfwert des AMU-Backups ist ungültig.", "AMU_BACKUP_KEY_CHECK_INVALID");
  }
  const seen = new Set();
  const verified = [];
  for (const raw of manifest.files) {
    const storageKey = validateStorageKey(raw.storageKey);
    if (seen.has(storageKey)) throw storageError("Das AMU-Backup enthält doppelte Speicherschlüssel.", "AMU_BACKUP_MANIFEST_INVALID");
    seen.add(storageKey);
    const filePath = path.join(backup, "blobs", ...storageKey.split("/"));
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw storageError("Das AMU-Backup enthält einen unzulässigen Dateieintrag.", "AMU_BACKUP_FILE_INVALID");
    // Metadata-only callers verify every byte but do not retain every document
    // in RAM. The content-returning contract remains available to older callers.
    const content = includeContent ? fs.readFileSync(filePath) : null;
    const header = content || Buffer.alloc(ENCRYPTED_FILE_MAGIC.length);
    if (!includeContent) {
      const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { fs.readSync(descriptor, header, 0, header.length, 0); }
      finally { fs.closeSync(descriptor); }
    }
    const actualHash = includeContent ? sha256(content) : sha256File(filePath);
    if (stat.size !== Number(raw.byteSize) || actualHash !== String(raw.sha256 || "").toLowerCase()
      || !encryptedFileVersion(header)) {
      throw storageError(`Die Integritätsprüfung für ${storageKey} ist fehlgeschlagen.`, "AMU_BACKUP_INTEGRITY_FAILED");
    }
    verified.push({ storageKey, ...(includeContent ? { content } : { path: filePath }), byteSize: stat.size, sha256: raw.sha256 });
  }
  const actual = listEncryptedFiles(path.join(backup, "blobs")).files.map((file) => file.storageKey);
  if (actual.length !== seen.size || actual.some((key) => !seen.has(key))) {
    throw storageError("Das AMU-Backup enthält Dateien, die nicht im Manifest stehen.", "AMU_BACKUP_MANIFEST_MISMATCH");
  }
  return { manifest, verified, keyCheckContent };
}

function verifyBackupReferences({ backupDirectory, requiredStorageKeys = [] } = {}) {
  const backup = readAndVerifyBackup(backupDirectory, { includeContent: false });
  const available = new Set(backup.verified.map((file) => file.storageKey));
  const required = new Set();
  for (const rawKey of requiredStorageKeys) {
    const storageKey = validateStorageKey(rawKey);
    if (required.has(storageKey)) {
      throw storageError("Die Datenbank verweist mehrfach auf dieselbe geschützte Datei.", "AMU_BACKUP_REFERENCE_DUPLICATE");
    }
    required.add(storageKey);
    if (!available.has(storageKey)) {
      throw storageError("Dem Sicherungspunkt fehlt eine in der Datenbank referenzierte geschützte Datei.", "AMU_BACKUP_REFERENCE_MISSING");
    }
  }
  return { ...backup, requiredStorageKeys: [...required] };
}

function restoreEncryptedFilesBackup({ backupDirectory, targetDirectory } = {}) {
  if (!backupDirectory || !targetDirectory) throw storageError("Backup- und Zielordner für die AMU-Wiederherstellung fehlen.", "AMU_BACKUP_PATH_REQUIRED");
  const target = path.resolve(targetDirectory);
  const prepared = `${target}.restore-${crypto.randomUUID()}`;
  const { manifest, verified, keyCheckContent } = readAndVerifyBackup(backupDirectory, { includeContent: false });
  safeMkdir(path.join(prepared, "blobs"));
  try {
    writeExclusiveAndSync(path.join(prepared, KEY_CHECK_FILE), keyCheckContent);
    for (const file of verified) {
      const targetPath = path.join(prepared, "blobs", ...file.storageKey.split("/"));
      safeMkdir(path.dirname(targetPath));
      fs.copyFileSync(file.path, targetPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(targetPath, 0o600);
      if (fs.lstatSync(targetPath).size !== file.byteSize || sha256File(targetPath) !== String(file.sha256).toLowerCase()) {
        throw storageError("Die kopierte AMU-Datei stimmt nicht mit dem Sicherungspunkt ueberein.", "AMU_BACKUP_INTEGRITY_FAILED");
      }
      const descriptor = fs.openSync(targetPath, "r+");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    atomicReplaceDirectory(prepared, target);
    return { targetDirectory: target, fileCount: verified.length, manifest };
  } catch (error) {
    removePathQuietly(prepared);
    throw error;
  }
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  createAmuStorage,
  detectDocumentType,
  sanitizeOriginalFilename,
  scanWithAvailableEngine,
  syncEncryptedFilesBackup,
  restoreEncryptedFilesBackup,
  validateEncryptionKeyForStorage,
  readAndVerifyBackup,
  verifyBackupReferences,
};
