"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_ROOT = "/var/lib/grabenplaner-assurance";
const EVENT_FORMAT = "grabenplaner-recovery-assurance-event";
const HEAD_FORMAT = "grabenplaner-recovery-assurance-head";
const SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const EVENT_TYPES = Object.freeze([
  "full-assurance-started",
  "oauth-policy-passed",
  "backup-passed",
  "repository-check-passed",
  "restore-test-passed",
  "application-smoke-not-run",
  "application-smoke-passed",
  "application-smoke-failed",
  "full-assurance-passed",
  "full-assurance-failed",
  "configuration-change-queued",
  "update-queued",
]);
const TRIGGERS = Object.freeze([
  "scheduled-nightly",
  "scheduled-weekly",
  "oauth-config-changed",
  "offsite-config-changed",
  "binary-changed",
  "offsite-module-changed",
  "app-updated",
  "server-updated",
  "manual-cli",
  "manual-admin-ui",
]);
const ERROR_CODES = Object.freeze([
  "APPLICATION_SMOKE_FAILED",
  "ASSURANCE_RUN_FAILED",
  "CONFIGURATION_VERIFY_FAILED",
  "FULL_CHECK_FAILED",
  "MONITOR_CHECK_FAILED",
  "PREPARE_FAILED",
  "REPOSITORY_CHECK_FAILED",
  "RESTORE_TEST_FAILED",
  "UPDATE_VERIFY_FAILED",
  "UPLOAD_FAILED",
]);
const CONFIGURATION_TRIGGERS = new Set([
  "oauth-config-changed",
  "offsite-config-changed",
  "binary-changed",
  "offsite-module-changed",
]);
const UPDATE_TRIGGERS = new Set(["app-updated", "server-updated"]);
const TERMINAL_EVENTS = new Set(["full-assurance-passed", "full-assurance-failed"]);
const PHASE_PREFIX_EVENTS = Object.freeze([
  "oauth-policy-passed",
  "backup-passed",
  "repository-check-passed",
  "restore-test-passed",
]);
const APPLICATION_PHASE_EVENTS = Object.freeze([
  "application-smoke-not-run",
  "application-smoke-passed",
  "application-smoke-failed",
]);
const PHASE_EVENTS = Object.freeze([...PHASE_PREFIX_EVENTS, "application-smoke-passed"]);
const PHASE_EVENT_SET = new Set([...PHASE_PREFIX_EVENTS, ...APPLICATION_PHASE_EVENTS]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SHORT_HASH_PATTERN = /^[a-f0-9]{12}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EVENT_KEYS = new Set(["format", "schemaVersion", "sequence", "previousHash", "payload", "keyId", "eventHash", "signature"]);
const PAYLOAD_KEYS = new Set(["eventId", "runId", "eventType", "trigger", "occurredAt", "errorCode", "evidence"]);
const EVIDENCE_KEYS = new Set(["snapshotIdPrefix", "receiptSha256", "appVersion"]);
const HEAD_UNSIGNED_KEYS = new Set(["format", "schemaVersion", "eventCount", "lastSequence", "lastEventHash", "keyId", "generatedAt"]);
const HEAD_KEYS = new Set([...HEAD_UNSIGNED_KEYS, "signature"]);
const TEST_POLICY = Object.freeze({ name: "assurance-history-test-policy" });
const __internalTestOnly = Object.freeze({ policy: TEST_POLICY });

class AssuranceHistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssuranceHistoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssuranceHistoryError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, code = "ASSURANCE_SCHEMA_INVALID") {
  if (!isPlainObject(value) || Object.keys(value).length !== expected.size
    || Object.keys(value).some((key) => !expected.has(key))) {
    fail(code, "Der Recovery-Assurance-Nachweis besitzt kein freigegebenes Schema.");
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  fail("ASSURANCE_CANONICAL_INVALID", "Der Recovery-Assurance-Nachweis kann nicht kanonisiert werden.");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("ASSURANCE_TIMESTAMP_INVALID", "Der Recovery-Assurance-Zeitstempel ist ungueltig.");
  }
  return value;
}

function normalizeEvidence(value) {
  exactKeys(value, EVIDENCE_KEYS);
  const snapshotIdPrefix = value.snapshotIdPrefix === null ? null : String(value.snapshotIdPrefix || "").toLowerCase();
  const receiptSha256 = value.receiptSha256 === null ? null : String(value.receiptSha256 || "").toLowerCase();
  const appVersion = value.appVersion === null ? null : String(value.appVersion || "");
  if (snapshotIdPrefix !== null && !SHORT_HASH_PATTERN.test(snapshotIdPrefix)) {
    fail("ASSURANCE_EVIDENCE_INVALID", "Der Recovery-Assurance-Snapshotnachweis ist ungueltig.");
  }
  if (receiptSha256 !== null && !HASH_PATTERN.test(receiptSha256)) {
    fail("ASSURANCE_EVIDENCE_INVALID", "Der Recovery-Assurance-Belegnachweis ist ungueltig.");
  }
  if (appVersion !== null && !SEMVER_PATTERN.test(appVersion)) {
    fail("ASSURANCE_EVIDENCE_INVALID", "Die Recovery-Assurance-App-Version ist ungueltig.");
  }
  return { snapshotIdPrefix, receiptSha256, appVersion };
}

function normalizePayload(value) {
  exactKeys(value, PAYLOAD_KEYS);
  const eventId = String(value.eventId || "").toLowerCase();
  const runId = String(value.runId || "").toLowerCase();
  const eventType = String(value.eventType || "");
  const trigger = String(value.trigger || "");
  const errorCode = value.errorCode === null ? null : String(value.errorCode || "");
  if (!UUID_PATTERN.test(eventId) || !UUID_PATTERN.test(runId)) {
    fail("ASSURANCE_ID_INVALID", "Eine Recovery-Assurance-Kennung ist ungueltig.");
  }
  if (!EVENT_TYPES.includes(eventType) || !TRIGGERS.includes(trigger)) {
    fail("ASSURANCE_EVENT_INVALID", "Recovery-Assurance-Ereignis oder Ausloeser ist nicht freigegeben.");
  }
  if (eventType === "configuration-change-queued" && !CONFIGURATION_TRIGGERS.has(trigger)) {
    fail("ASSURANCE_EVENT_INVALID", "Der Ausloeser passt nicht zum Konfigurationsereignis.");
  }
  if (eventType === "update-queued" && !UPDATE_TRIGGERS.has(trigger)) {
    fail("ASSURANCE_EVENT_INVALID", "Der Ausloeser passt nicht zum Aktualisierungsereignis.");
  }
  if (eventType === "full-assurance-failed") {
    if (!ERROR_CODES.includes(errorCode)) fail("ASSURANCE_ERROR_CODE_INVALID", "Der Recovery-Assurance-Fehlercode ist nicht freigegeben.");
  } else if (errorCode !== null) {
    fail("ASSURANCE_ERROR_CODE_INVALID", "Nur ein fehlgeschlagener Assurance-Lauf darf einen Fehlercode enthalten.");
  }
  return {
    eventId,
    runId,
    eventType,
    trigger,
    occurredAt: normalizeTimestamp(value.occurredAt),
    errorCode,
    evidence: normalizeEvidence(value.evidence),
  };
}

function eventUnsigned(sequence, previousHash, payload, keyId) {
  return {
    format: EVENT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    sequence,
    previousHash,
    payload,
    keyId,
  };
}

function headUnsigned(eventCount, lastSequence, lastEventHash, keyId, generatedAt) {
  return {
    format: HEAD_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    eventCount,
    lastSequence,
    lastEventHash,
    keyId,
    generatedAt,
  };
}

function publicKeyId(publicKey) {
  const keyObject = publicKey instanceof crypto.KeyObject && publicKey.type === "public"
    ? publicKey
    : crypto.createPublicKey(publicKey);
  const der = keyObject.export({ format: "der", type: "spki" });
  return sha256(der);
}

function signDigest(privateKey, hexadecimalDigest) {
  return crypto.sign(null, Buffer.from(hexadecimalDigest, "hex"), privateKey).toString("base64");
}

function verifyDigest(publicKey, hexadecimalDigest, signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  let bytes;
  try { bytes = Buffer.from(signature, "base64"); } catch { return false; }
  return bytes.length === 64 && crypto.verify(null, Buffer.from(hexadecimalDigest, "hex"), publicKey, bytes);
}

function pathIsInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function normalizeRoot(root, policy) {
  const resolved = path.resolve(String(root || ""));
  if (!path.isAbsolute(String(root || "")) || resolved === path.parse(resolved).root || String(root || "").includes("\0")) {
    fail("ASSURANCE_ROOT_INVALID", "Der Recovery-Assurance-Wurzelpfad ist ungueltig.");
  }
  if (policy === TEST_POLICY) {
    const temporaryRoot = path.resolve(os.tmpdir());
    if (!pathIsInside(resolved, temporaryRoot)) {
      fail("ASSURANCE_TEST_ROOT_INVALID", "Der Recovery-Assurance-Testpfad muss unter dem System-Testordner liegen.");
    }
  } else if (resolved !== DEFAULT_ROOT) {
    fail("ASSURANCE_ROOT_INVALID", "Der Recovery-Assurance-Wurzelpfad weicht vom Produktionsvertrag ab.");
  }
  return resolved;
}

function assertWriterAuthority(policy) {
  if (policy === TEST_POLICY) return;
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    fail("ASSURANCE_ROOT_REQUIRED", "Recovery-Assurance-Nachweise duerfen nur durch root auf Linux geschrieben werden.");
  }
}

function expectedOwner(policy) {
  if (policy === TEST_POLICY && process.platform !== "win32") {
    return { uid: process.getuid(), gid: process.getgid() };
  }
  return { uid: 0, gid: 0 };
}

function assertDirectory(directory, mode, gid, policy) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail("ASSURANCE_DIRECTORY_INVALID", "Ein Recovery-Assurance-Ordner fehlt oder ist nicht sicher lesbar."); }
  // Windows reports a directory link count of one. The production writer is
  // Linux-only, so the POSIX link-count invariant stays mandatory there while
  // the explicit test policy remains portable on Windows.
  const unsafeLinkCount = process.platform !== "win32" && stat.nlink < 2;
  if (!stat.isDirectory() || stat.isSymbolicLink() || unsafeLinkCount) {
    fail("ASSURANCE_DIRECTORY_INVALID", "Ein Recovery-Assurance-Ordner ist unzulaessig.");
  }
  if (process.platform !== "win32") {
    const owner = expectedOwner(policy);
    if (stat.uid !== owner.uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) {
      fail("ASSURANCE_DIRECTORY_PERMISSIONS_INVALID", "Ein Recovery-Assurance-Ordner ist nicht ausreichend geschuetzt.");
    }
  }
}

function secureRead(file, { maximumBytes, mode, gid, policy }) {
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) fail("ASSURANCE_FILE_UNSAFE", "Eine Recovery-Assurance-Datei ist unzulaessig.");
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes
      || stat.dev !== before.dev || stat.ino !== before.ino) {
      fail("ASSURANCE_FILE_UNSAFE", "Eine Recovery-Assurance-Datei wurde ausgetauscht oder hat eine unzulaessige Groesse.");
    }
    if (process.platform !== "win32") {
      const owner = expectedOwner(policy);
      if (stat.uid !== owner.uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) {
        fail("ASSURANCE_FILE_PERMISSIONS_INVALID", "Eine Recovery-Assurance-Datei ist nicht ausreichend geschuetzt.");
      }
    }
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof AssuranceHistoryError) throw error;
    fail("ASSURANCE_FILE_UNREADABLE", "Eine Recovery-Assurance-Datei ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function setOwnership(file, mode, gid, policy) {
  fs.chmodSync(file, mode);
  if (process.platform !== "win32") {
    const owner = expectedOwner(policy);
    fs.chownSync(file, owner.uid, gid);
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function temporaryName(directory, baseName) {
  return path.join(directory, `.${baseName}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
}

function writeTemporary(file, content, mode, gid, policy) {
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0), mode);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, mode);
    if (process.platform !== "win32") {
      const owner = expectedOwner(policy);
      fs.fchownSync(descriptor, owner.uid, gid);
    }
  } finally { fs.closeSync(descriptor); }
}

function atomicCreate(file, content, mode, gid, policy) {
  const directory = path.dirname(file);
  const temporary = temporaryName(directory, path.basename(file));
  try {
    writeTemporary(temporary, content, mode, gid, policy);
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* already absent */ }
    if (error?.code === "EEXIST") fail("ASSURANCE_FILE_EXISTS", "Ein Recovery-Assurance-Nachweis existiert bereits.");
    throw error;
  }
}

function atomicReplace(file, content, mode, gid, policy) {
  const directory = path.dirname(file);
  const temporary = temporaryName(directory, path.basename(file));
  try {
    writeTemporary(temporary, content, mode, gid, policy);
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already absent */ }
  }
}

function ensureDirectory(directory, mode, gid, policy) {
  let created = false;
  try { fs.mkdirSync(directory, { mode }); created = true; } catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (created) setOwnership(directory, mode, gid, policy);
  assertDirectory(directory, mode, gid, policy);
}

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { fail("ASSURANCE_JSON_INVALID", "Ein Recovery-Assurance-Nachweis enthaelt kein gueltiges JSON."); }
}

function validateEvent(value, publicKey, expectedKeyId) {
  exactKeys(value, EVENT_KEYS);
  if (value.format !== EVENT_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || (value.previousHash !== null && !HASH_PATTERN.test(String(value.previousHash || "")))
    || value.keyId !== expectedKeyId || !HASH_PATTERN.test(String(value.eventHash || ""))) {
    fail("ASSURANCE_EVENT_SCHEMA_INVALID", "Ein Recovery-Assurance-Ereignis ist ungueltig.");
  }
  const payload = normalizePayload(value.payload);
  if (canonicalJson(payload) !== canonicalJson(value.payload)) {
    fail("ASSURANCE_EVENT_SCHEMA_INVALID", "Ein Recovery-Assurance-Ereignis ist nicht kanonisch gespeichert.");
  }
  const unsigned = eventUnsigned(value.sequence, value.previousHash, payload, value.keyId);
  const expectedHash = sha256(canonicalJson(unsigned));
  if (expectedHash !== value.eventHash || !verifyDigest(publicKey, expectedHash, value.signature)) {
    fail("ASSURANCE_EVENT_SIGNATURE_INVALID", "Signatur oder Hash eines Recovery-Assurance-Ereignisses ist ungueltig.");
  }
  return { ...unsigned, eventHash: expectedHash, signature: value.signature };
}

function validateHead(value, publicKey, expectedKeyId) {
  exactKeys(value, HEAD_KEYS);
  if (value.format !== HEAD_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0
    || value.lastSequence !== value.eventCount || value.keyId !== expectedKeyId
    || (value.eventCount === 0 ? value.lastEventHash !== null : !HASH_PATTERN.test(String(value.lastEventHash || "")))) {
    fail("ASSURANCE_HEAD_SCHEMA_INVALID", "Der Recovery-Assurance-Kopf ist ungueltig.");
  }
  const unsigned = headUnsigned(value.eventCount, value.lastSequence, value.lastEventHash, value.keyId,
    normalizeTimestamp(value.generatedAt));
  const digest = sha256(canonicalJson(unsigned));
  if (!verifyDigest(publicKey, digest, value.signature)) {
    fail("ASSURANCE_HEAD_SIGNATURE_INVALID", "Die Signatur des Recovery-Assurance-Kopfs ist ungueltig.");
  }
  return { ...unsigned, signature: value.signature };
}

function historyFileName(sequence, eventHash) {
  return `${String(sequence).padStart(12, "0")}-${eventHash}.json`;
}

function readKeys(root, statusGid, policy) {
  const privatePath = path.join(root, "signing-private.pem");
  const publicPath = path.join(root, "signing-public.pem");
  const owner = expectedOwner(policy);
  const privatePem = secureRead(privatePath, { maximumBytes: MAX_KEY_BYTES, mode: 0o600, gid: owner.gid, policy });
  const publicPem = secureRead(publicPath, { maximumBytes: MAX_KEY_BYTES, mode: 0o440, gid: statusGid, policy });
  let privateKey;
  let publicKey;
  try {
    privateKey = crypto.createPrivateKey(privatePem);
    publicKey = crypto.createPublicKey(publicPem);
  } catch { fail("ASSURANCE_KEY_INVALID", "Ein Recovery-Assurance-Signaturschluessel ist ungueltig."); }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    fail("ASSURANCE_KEY_INVALID", "Recovery-Assurance erfordert Ed25519-Signaturschluessel.");
  }
  const challenge = crypto.randomBytes(32);
  if (!crypto.verify(null, challenge, publicKey, crypto.sign(null, challenge, privateKey))) {
    fail("ASSURANCE_KEY_MISMATCH", "Private und oeffentliche Recovery-Assurance-Schluessel passen nicht zusammen.");
  }
  return { privateKey, publicKey, keyId: publicKeyId(publicKey) };
}

function readPublicKey(root, statusGid, policy) {
  const publicPem = secureRead(path.join(root, "signing-public.pem"), {
    maximumBytes: MAX_KEY_BYTES, mode: 0o440, gid: statusGid, policy,
  });
  let publicKey;
  try { publicKey = crypto.createPublicKey(publicPem); }
  catch { fail("ASSURANCE_KEY_INVALID", "Der oeffentliche Recovery-Assurance-Schluessel ist ungueltig."); }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("ASSURANCE_KEY_INVALID", "Recovery-Assurance erfordert einen Ed25519-Schluessel.");
  return { publicKey, keyId: publicKeyId(publicKey) };
}

function readEvents(root, statusGid, policy, publicKey, keyId) {
  const historyRoot = path.join(root, "history");
  assertDirectory(historyRoot, 0o750, statusGid, policy);
  let entries;
  try { entries = fs.readdirSync(historyRoot, { withFileTypes: true }); }
  catch { fail("ASSURANCE_HISTORY_UNREADABLE", "Der Recovery-Assurance-Verlauf ist nicht sicher lesbar."); }
  if (entries.some((entry) => !entry.isFile() || !/^\d{12}-[a-f0-9]{64}\.json$/.test(entry.name))) {
    fail("ASSURANCE_HISTORY_ENTRY_INVALID", "Der Recovery-Assurance-Verlauf enthaelt einen unzulaessigen Eintrag.");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const events = [];
  let previousHash = null;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < entries.length; index += 1) {
    const sequence = index + 1;
    const value = parseJson(secureRead(path.join(historyRoot, entries[index].name), {
      maximumBytes: MAX_JSON_BYTES, mode: 0o640, gid: statusGid, policy,
    }));
    const event = validateEvent(value, publicKey, keyId);
    if (event.sequence !== sequence || event.previousHash !== previousHash
      || entries[index].name !== historyFileName(sequence, event.eventHash)) {
      fail("ASSURANCE_HISTORY_CHAIN_INVALID", "Die Recovery-Assurance-Hashkette ist unterbrochen.");
    }
    const occurredMs = Date.parse(event.payload.occurredAt);
    if (occurredMs < previousTime) fail("ASSURANCE_HISTORY_TIME_INVALID", "Der Recovery-Assurance-Verlauf ist zeitlich widerspruechlich.");
    previousTime = occurredMs;
    previousHash = event.eventHash;
    events.push(event);
  }
  validateHistorySemantics(events);
  return events;
}

function validateHistorySemantics(events) {
  const runs = new Map();
  for (const event of events) {
    const payload = event.payload;
    const state = runs.get(payload.runId) || { started: null, terminal: null, phases: new Map() };
    if (payload.eventType === "full-assurance-started") {
      if (state.started || state.terminal) fail("ASSURANCE_RUN_ORDER_INVALID", "Ein Assurance-Lauf wurde mehrfach oder nach seinem Abschluss gestartet.");
      state.started = event;
    } else if (PHASE_EVENT_SET.has(payload.eventType)) {
      if (!state.started || state.terminal || state.started.payload.trigger !== payload.trigger
        || state.phases.has(payload.eventType)
        || Date.parse(payload.occurredAt) < Date.parse(state.started.payload.occurredAt)) {
        fail("ASSURANCE_RUN_ORDER_INVALID", "Eine Assurance-Pruefphase ist widerspruechlich.");
      }
      const phaseIndex = PHASE_PREFIX_EVENTS.indexOf(payload.eventType);
      const applicationPhase = APPLICATION_PHASE_EVENTS.includes(payload.eventType);
      const existingApplicationPhase = APPLICATION_PHASE_EVENTS.some((phase) => state.phases.has(phase));
      if ((phaseIndex >= 0 && phaseIndex !== state.phases.size)
        || (applicationPhase && (state.phases.size !== PHASE_PREFIX_EVENTS.length || existingApplicationPhase))) {
        fail("ASSURANCE_RUN_ORDER_INVALID", "Die Assurance-Pruefphasen sind nicht in der freigegebenen Reihenfolge.");
      }
      state.phases.set(payload.eventType, event);
    } else if (TERMINAL_EVENTS.has(payload.eventType)) {
      if (!state.started || state.terminal || state.started.payload.trigger !== payload.trigger
        || Date.parse(payload.occurredAt) < Date.parse(state.started.payload.occurredAt)) {
        fail("ASSURANCE_RUN_ORDER_INVALID", "Der Abschluss eines Assurance-Laufs ist widerspruechlich.");
      }
      const successfulApplicationPhase = state.phases.has("application-smoke-passed")
        || state.phases.has("application-smoke-not-run");
      if (payload.eventType === "full-assurance-passed"
        && (PHASE_PREFIX_EVENTS.some((phase) => !state.phases.has(phase)) || !successfulApplicationPhase)) {
        fail("ASSURANCE_RUN_INCOMPLETE", "Ein erfolgreicher Assurance-Lauf benoetigt alle freigegebenen Pruefphasen.");
      }
      if ((payload.errorCode === "APPLICATION_SMOKE_FAILED") !== state.phases.has("application-smoke-failed")) {
        fail("ASSURANCE_RUN_ORDER_INVALID", "App-Smoke-Phase und Assurance-Fehlercode stimmen nicht ueberein.");
      }
      state.terminal = event;
    } else if (state.terminal) {
      fail("ASSURANCE_RUN_ORDER_INVALID", "Nach dem Abschluss eines Assurance-Laufs darf kein Ereignis folgen.");
    }
    runs.set(payload.runId, state);
  }
  return runs;
}

function readHead(root, statusGid, policy, publicKey, keyId) {
  return validateHead(parseJson(secureRead(path.join(root, "head.json"), {
    maximumBytes: MAX_JSON_BYTES, mode: 0o640, gid: statusGid, policy,
  })), publicKey, keyId);
}

function validateHeadAgainstEvents(head, events, { allowPrefix = false } = {}) {
  if (head.eventCount > events.length || (!allowPrefix && head.eventCount !== events.length)) {
    fail("ASSURANCE_HEAD_HISTORY_MISMATCH", "Recovery-Assurance-Kopf und Verlauf stimmen nicht ueberein.");
  }
  const expectedHash = head.eventCount === 0 ? null : events[head.eventCount - 1].eventHash;
  if (head.lastSequence !== head.eventCount || head.lastEventHash !== expectedHash) {
    fail("ASSURANCE_HEAD_HISTORY_MISMATCH", "Recovery-Assurance-Kopf und Verlauf stimmen nicht ueberein.");
  }
  if (head.eventCount > 0 && Date.parse(head.generatedAt) < Date.parse(events[head.eventCount - 1].payload.occurredAt)) {
    fail("ASSURANCE_HEAD_HISTORY_MISMATCH", "Der Recovery-Assurance-Kopf ist zeitlich widerspruechlich.");
  }
}

function signedHead(events, keyId, privateKey, now = new Date()) {
  const last = events.at(-1) || null;
  const unsigned = headUnsigned(events.length, events.length, last?.eventHash || null, keyId, now.toISOString());
  const signature = signDigest(privateKey, sha256(canonicalJson(unsigned)));
  return { ...unsigned, signature };
}

function initializeHistory({ root = DEFAULT_ROOT, statusGid, policy } = {}) {
  assertWriterAuthority(policy);
  const resolvedRoot = normalizeRoot(root, policy);
  if (!Number.isSafeInteger(statusGid) || statusGid < 0) fail("ASSURANCE_GID_INVALID", "Die Recovery-Assurance-Statusgruppe ist ungueltig.");
  ensureDirectory(resolvedRoot, 0o750, statusGid, policy);
  ensureDirectory(path.join(resolvedRoot, "history"), 0o750, statusGid, policy);
  const privatePath = path.join(resolvedRoot, "signing-private.pem");
  const publicPath = path.join(resolvedRoot, "signing-public.pem");
  const headPath = path.join(resolvedRoot, "head.json");
  const existing = [privatePath, publicPath, headPath].map((file) => fs.existsSync(file));
  if (existing.some(Boolean)) {
    if (!existing.every(Boolean)) fail("ASSURANCE_INITIALIZATION_INCOMPLETE", "Die Recovery-Assurance-Initialisierung ist unvollstaendig.");
    const keys = readKeys(resolvedRoot, statusGid, policy);
    const events = readEvents(resolvedRoot, statusGid, policy, keys.publicKey, keys.keyId);
    const head = readHead(resolvedRoot, statusGid, policy, keys.publicKey, keys.keyId);
    validateHeadAgainstEvents(head, events);
    return { ok: true, initialized: false, keyId: keys.keyId, eventCount: events.length };
  }
  let privateKey;
  let publicKey;
  ({ privateKey, publicKey } = crypto.generateKeyPairSync("ed25519"));
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
  const publicPem = publicKey.export({ format: "pem", type: "spki" });
  const keyId = publicKeyId(publicKey);
  const owner = expectedOwner(policy);
  atomicCreate(privatePath, privatePem, 0o600, owner.gid, policy);
  atomicCreate(publicPath, publicPem, 0o440, statusGid, policy);
  const head = signedHead([], keyId, privateKey);
  atomicCreate(headPath, `${JSON.stringify(head, null, 2)}\n`, 0o640, statusGid, policy);
  return { ok: true, initialized: true, keyId, eventCount: 0 };
}

function inspectHistory({ root = DEFAULT_ROOT, statusGid, policy } = {}) {
  const resolvedRoot = normalizeRoot(root, policy);
  if (!Number.isSafeInteger(statusGid) || statusGid < 0) fail("ASSURANCE_GID_INVALID", "Die Recovery-Assurance-Statusgruppe ist ungueltig.");
  if (policy !== TEST_POLICY) assertWriterAuthority(policy);
  assertDirectory(resolvedRoot, 0o750, statusGid, policy);
  const { publicKey, keyId } = readPublicKey(resolvedRoot, statusGid, policy);
  const events = readEvents(resolvedRoot, statusGid, policy, publicKey, keyId);
  const head = readHead(resolvedRoot, statusGid, policy, publicKey, keyId);
  validateHeadAgainstEvents(head, events);
  return {
    ok: true,
    eventCount: events.length,
    lastSequence: head.lastSequence,
    lastEventHash: head.lastEventHash,
    keyId,
    events: events.map((event) => ({
      sequence: event.sequence,
      eventHash: event.eventHash,
      payload: event.payload,
    })),
  };
}

function normalizeAppendInput({ eventType, runId, trigger, errorCode = null, evidence = {}, now = new Date() }) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) fail("ASSURANCE_TIMESTAMP_INVALID", "Der Recovery-Assurance-Zeitstempel ist ungueltig.");
  return normalizePayload({
    eventId: crypto.randomUUID(),
    runId: String(runId || "").toLowerCase(),
    eventType,
    trigger,
    occurredAt: date.toISOString(),
    errorCode,
    evidence: {
      snapshotIdPrefix: evidence.snapshotIdPrefix ?? null,
      receiptSha256: evidence.receiptSha256 ?? null,
      appVersion: evidence.appVersion ?? null,
    },
  });
}

function appendEvent({ root = DEFAULT_ROOT, statusGid, eventType, runId, trigger, errorCode = null, evidence, now, policy } = {}) {
  assertWriterAuthority(policy);
  const resolvedRoot = normalizeRoot(root, policy);
  if (!Number.isSafeInteger(statusGid) || statusGid < 0) fail("ASSURANCE_GID_INVALID", "Die Recovery-Assurance-Statusgruppe ist ungueltig.");
  assertDirectory(resolvedRoot, 0o750, statusGid, policy);
  const keys = readKeys(resolvedRoot, statusGid, policy);
  const events = readEvents(resolvedRoot, statusGid, policy, keys.publicKey, keys.keyId);
  const head = readHead(resolvedRoot, statusGid, policy, keys.publicKey, keys.keyId);
  validateHeadAgainstEvents(head, events, { allowPrefix: true });
  if (head.eventCount !== events.length) {
    const repaired = signedHead(events, keys.keyId, keys.privateKey,
      new Date(Math.max(Date.now(), Date.parse(events.at(-1).payload.occurredAt))));
    atomicReplace(path.join(resolvedRoot, "head.json"), `${JSON.stringify(repaired, null, 2)}\n`, 0o640, statusGid, policy);
  }
  const payload = normalizeAppendInput({ eventType, runId, trigger, errorCode, evidence, now: now || new Date() });
  const runs = validateHistorySemantics(events);
  const run = runs.get(payload.runId) || { started: null, terminal: null, phases: new Map() };
  if (TERMINAL_EVENTS.has(payload.eventType) && run.terminal) {
    const existing = run.terminal.payload;
    if (existing.eventType !== payload.eventType || existing.trigger !== payload.trigger
      || existing.errorCode !== payload.errorCode || canonicalJson(existing.evidence) !== canonicalJson(payload.evidence)) {
      fail("ASSURANCE_TERMINAL_CONFLICT", "Der Assurance-Lauf besitzt bereits einen abweichenden Abschluss.");
    }
    return {
      ok: true,
      idempotent: true,
      sequence: run.terminal.sequence,
      eventHash: run.terminal.eventHash,
      runId: payload.runId,
      eventType: payload.eventType,
    };
  }
  if (payload.eventType === "full-assurance-started" && (run.started || run.terminal)) {
    fail("ASSURANCE_START_CONFLICT", "Der Assurance-Lauf wurde bereits gestartet oder abgeschlossen.");
  }
  if (TERMINAL_EVENTS.has(payload.eventType)) {
    if (!run.started || run.started.payload.trigger !== payload.trigger) {
      fail("ASSURANCE_RUN_ORDER_INVALID", "Der Assurance-Lauf kann ohne passenden Start nicht abgeschlossen werden.");
    }
    const successfulApplicationPhase = run.phases.has("application-smoke-passed")
      || run.phases.has("application-smoke-not-run");
    if (payload.eventType === "full-assurance-passed"
      && (PHASE_PREFIX_EVENTS.some((phase) => !run.phases.has(phase)) || !successfulApplicationPhase)) {
      fail("ASSURANCE_RUN_INCOMPLETE", "Ein erfolgreicher Assurance-Lauf benoetigt alle freigegebenen Pruefphasen.");
    }
    if ((payload.errorCode === "APPLICATION_SMOKE_FAILED") !== run.phases.has("application-smoke-failed")) {
      fail("ASSURANCE_RUN_ORDER_INVALID", "App-Smoke-Phase und Assurance-Fehlercode stimmen nicht ueberein.");
    }
  } else if (PHASE_EVENT_SET.has(payload.eventType)) {
    if (!run.started || run.started.payload.trigger !== payload.trigger || run.phases.has(payload.eventType)) {
      fail("ASSURANCE_RUN_ORDER_INVALID", "Die Assurance-Pruefphase kann nicht erfasst werden.");
    }
    const phaseIndex = PHASE_PREFIX_EVENTS.indexOf(payload.eventType);
    const applicationPhase = APPLICATION_PHASE_EVENTS.includes(payload.eventType);
    const existingApplicationPhase = APPLICATION_PHASE_EVENTS.some((phase) => run.phases.has(phase));
    if ((phaseIndex >= 0 && phaseIndex !== run.phases.size)
      || (applicationPhase && (run.phases.size !== PHASE_PREFIX_EVENTS.length || existingApplicationPhase))) {
      fail("ASSURANCE_RUN_ORDER_INVALID", "Die Assurance-Pruefphase ist nicht in der freigegebenen Reihenfolge.");
    }
  } else if (run.terminal) {
    fail("ASSURANCE_RUN_ORDER_INVALID", "Der Assurance-Lauf ist bereits abgeschlossen.");
  }
  if (events.length && Date.parse(payload.occurredAt) < Date.parse(events.at(-1).payload.occurredAt)) {
    fail("ASSURANCE_HISTORY_TIME_INVALID", "Das neue Assurance-Ereignis liegt vor dem bisherigen Verlauf.");
  }
  const sequence = events.length + 1;
  const previousHash = events.at(-1)?.eventHash || null;
  const unsigned = eventUnsigned(sequence, previousHash, payload, keys.keyId);
  const eventHash = sha256(canonicalJson(unsigned));
  const event = { ...unsigned, eventHash, signature: signDigest(keys.privateKey, eventHash) };
  validateEvent(event, keys.publicKey, keys.keyId);
  const eventPath = path.join(resolvedRoot, "history", historyFileName(sequence, eventHash));
  atomicCreate(eventPath, `${JSON.stringify(event, null, 2)}\n`, 0o640, statusGid, policy);
  const nextEvents = [...events, event];
  validateHistorySemantics(nextEvents);
  const nextHead = signedHead(nextEvents, keys.keyId, keys.privateKey,
    new Date(Math.max(Date.now(), Date.parse(payload.occurredAt))));
  atomicReplace(path.join(resolvedRoot, "head.json"), `${JSON.stringify(nextHead, null, 2)}\n`, 0o640, statusGid, policy);
  return { ok: true, idempotent: false, sequence, eventHash, runId: payload.runId, eventType: payload.eventType };
}

function usage() {
  process.stderr.write("Ungueltiger Aufruf des Recovery-Assurance-Verlaufs.\n");
  process.exit(2);
}

function parseCli(argv) {
  const args = [...argv];
  const command = String(args.shift() || "");
  const options = {};
  while (args.length) {
    const key = String(args.shift() || "");
    if (!key.startsWith("--") || Object.hasOwn(options, key.slice(2))) usage();
    if (key === "--allow-non-root") {
      options["allow-non-root"] = true;
      continue;
    }
    if (!args.length) usage();
    options[key.slice(2)] = String(args.shift());
  }
  const root = String(options.root || "");
  const gidText = String(options["status-gid"] || "");
  if (!root || !/^\d+$/.test(gidText)) usage();
  const statusGid = Number(gidText);
  let policy;
  if (options["allow-non-root"] === true) {
    if (process.env.NODE_ENV !== "test") usage();
    policy = TEST_POLICY;
  }
  delete options.root;
  delete options["status-gid"];
  delete options["allow-non-root"];
  return { root, statusGid, policy, command, options };
}

function main() {
  const { root, statusGid, policy, command, options } = parseCli(process.argv.slice(2));
  let result;
  if (command === "init" && Object.keys(options).length === 0) {
    result = initializeHistory({ root, statusGid, policy });
  } else if (command === "inspect" && Object.keys(options).length === 0) {
    result = inspectHistory({ root, statusGid, policy });
  } else if (command === "record") {
    const expected = new Set(["event-type", "run-id", "trigger", "error-code", "snapshot-prefix", "receipt-sha256", "app-version"]);
    if (Object.keys(options).some((key) => !expected.has(key)) || !options["event-type"] || !options["run-id"] || !options.trigger) usage();
    result = appendEvent({
      root,
      statusGid,
      policy,
      eventType: options["event-type"],
      runId: options["run-id"],
      trigger: options.trigger,
      errorCode: options["error-code"] || null,
      evidence: {
        snapshotIdPrefix: options["snapshot-prefix"] || null,
        receiptSha256: options["receipt-sha256"] || null,
        appVersion: options["app-version"] || null,
      },
    });
  } else usage();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error?.code || "ASSURANCE_HISTORY_FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  __internalTestOnly,
  appendEvent,
  canonicalJson,
  DEFAULT_ROOT,
  ERROR_CODES,
  EVENT_FORMAT,
  EVENT_TYPES,
  HEAD_FORMAT,
  initializeHistory,
  inspectHistory,
  PHASE_EVENTS,
  publicKeyId,
  SCHEMA_VERSION,
  TRIGGERS,
  validateEvent,
  validateHead,
};
