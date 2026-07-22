"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { recoveryTrendRuns } = require("./system-center-metrics");

const DEFAULT_ASSURANCE_ROOT = "/var/lib/grabenplaner-assurance";
const DEFAULT_EVENT_DIRECTORY = path.join(DEFAULT_ASSURANCE_ROOT, "history");
const DEFAULT_HEAD_PATH = path.join(DEFAULT_ASSURANCE_ROOT, "head.json");
const DEFAULT_PUBLIC_KEY_PATH = path.join(DEFAULT_ASSURANCE_ROOT, "signing-public.pem");
const EVENT_FORMAT = "grabenplaner-recovery-assurance-event";
const HEAD_FORMAT = "grabenplaner-recovery-assurance-head";
const SCHEMA_VERSION = 1;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_HEAD_BYTES = 16 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_HISTORY_FILES = 10_000;
const MAX_RETURNED_EVENTS = 30;
const MAX_RETURNED_RUNS = 12;
const DEFAULT_MAXIMUM_RUN_AGE_HOURS = 24 * 100;

const EVENT_KEYS = new Set([
  "format", "schemaVersion", "sequence", "previousHash", "payload", "keyId", "eventHash", "signature",
]);
const PAYLOAD_KEYS = new Set([
  "eventId", "runId", "eventType", "trigger", "occurredAt", "errorCode", "evidence",
]);
const EVIDENCE_KEYS = new Set(["snapshotIdPrefix", "receiptSha256", "appVersion"]);
const HEAD_KEYS = new Set([
  "format", "schemaVersion", "eventCount", "lastSequence", "lastEventHash", "keyId", "generatedAt", "signature",
]);
const EVENT_TYPES = new Set([
  "full-assurance-started", "full-assurance-passed", "full-assurance-failed", "configuration-change-queued",
  "update-queued", "backup-passed", "repository-check-passed", "restore-test-passed",
  "application-smoke-passed", "application-smoke-failed", "application-smoke-not-run", "oauth-policy-passed",
]);
const TRIGGERS = new Set([
  "scheduled-nightly", "scheduled-weekly", "oauth-config-changed", "offsite-config-changed", "binary-changed",
  "offsite-module-changed", "app-updated", "server-updated", "manual-cli", "manual-admin-ui",
]);
const ERROR_CODES = new Set([
  "APPLICATION_SMOKE_FAILED",
  "ASSURANCE_RUN_FAILED", "CONFIGURATION_VERIFY_FAILED", "FULL_CHECK_FAILED", "MONITOR_CHECK_FAILED",
  "PREPARE_FAILED", "REPOSITORY_CHECK_FAILED", "RESTORE_TEST_FAILED", "UPDATE_VERIFY_FAILED", "UPLOAD_FAILED",
]);
const CONFIGURATION_TRIGGERS = new Set([
  "oauth-config-changed", "offsite-config-changed", "binary-changed", "offsite-module-changed",
]);
const UPDATE_TRIGGERS = new Set(["app-updated", "server-updated"]);
const PHASE_EVENTS = Object.freeze([
  "oauth-policy-passed",
  "backup-passed",
  "repository-check-passed",
  "restore-test-passed",
  "application-smoke-passed",
  "application-smoke-failed",
  "application-smoke-not-run",
]);
const PHASE_EVENT_SET = new Set(PHASE_EVENTS);
const PHASE_ORDER = Object.freeze([
  "oauth-policy", "backup", "repository-check", "restore-test", "application-smoke",
]);

function phaseGroup(eventType) {
  if (["application-smoke-passed", "application-smoke-failed", "application-smoke-not-run"].includes(eventType)) {
    return "application-smoke";
  }
  return String(eventType || "").replace(/-passed$/, "");
}

class RecoveryAssuranceStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecoveryAssuranceStatusError";
    this.code = code;
  }
}

function assuranceError(code, message) {
  return new RecoveryAssuranceStatusError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))
    || [...keys].some((key) => !Object.hasOwn(value, key))) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", `${label} entspricht nicht dem freigegebenen Schema.`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Eine RAS-Zahl ist ungueltig.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Ein RAS-Wert ist ungueltig.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function publicKeyId(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function parseUtcTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", `${label} ist kein kanonischer UTC-Zeitstempel.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", `${label} ist ungueltig.`);
  }
  return value;
}

function parseSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw assuranceError("RAS_HISTORY_SIGNATURE_INVALID", "Eine RAS-Signatur ist ungueltig.");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) {
    throw assuranceError("RAS_HISTORY_SIGNATURE_INVALID", "Eine RAS-Signatur ist ungueltig.");
  }
  return signature;
}

function parsePayload(value) {
  assertExactKeys(value, PAYLOAD_KEYS, "Der RAS-Ereignisinhalt");
  const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!canonicalUuid.test(value.eventId) || !canonicalUuid.test(value.runId)) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Eine RAS-Vorgangskennung ist ungueltig.");
  }
  parseUtcTimestamp(value.occurredAt, "occurredAt");
  if (!EVENT_TYPES.has(value.eventType) || !TRIGGERS.has(value.trigger)) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Die RAS-Ereignisklassifikation ist ungueltig.");
  }
  if ((value.eventType === "configuration-change-queued" && !CONFIGURATION_TRIGGERS.has(value.trigger))
    || (value.eventType === "update-queued" && !UPDATE_TRIGGERS.has(value.trigger))) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "RAS-Ereignis und Ausloeser widersprechen einander.");
  }
  if (value.eventType === "full-assurance-failed") {
    if (!ERROR_CODES.has(value.errorCode)) {
      throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Der RAS-Fehlercode ist ungueltig.");
    }
  } else if (value.errorCode !== null) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Nur ein fehlgeschlagener RAS-Lauf darf einen Fehlercode enthalten.");
  }
  assertExactKeys(value.evidence, EVIDENCE_KEYS, "Der RAS-Nachweis");
  if ((value.evidence.snapshotIdPrefix !== null && !/^[a-f0-9]{12}$/.test(value.evidence.snapshotIdPrefix))
    || (value.evidence.receiptSha256 !== null && !/^[a-f0-9]{64}$/.test(value.evidence.receiptSha256))
    || (value.evidence.appVersion !== null
      && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.evidence.appVersion))) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Der RAS-Nachweis ist ungueltig.");
  }
  return value;
}

function eventUnsigned(value) {
  return {
    format: value.format,
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    previousHash: value.previousHash,
    payload: value.payload,
    keyId: value.keyId,
  };
}

function parseEvent(value, publicKey, expectedKeyId) {
  assertExactKeys(value, EVENT_KEYS, "Der RAS-Beleg");
  if (value.format !== EVENT_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || (value.previousHash !== null && !/^[a-f0-9]{64}$/.test(value.previousHash))
    || value.keyId !== expectedKeyId || !/^[a-f0-9]{64}$/.test(value.eventHash)) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Der RAS-Beleg ist ungueltig.");
  }
  parsePayload(value.payload);
  const expectedHash = canonicalHash(eventUnsigned(value));
  if (value.eventHash !== expectedHash) {
    throw assuranceError("RAS_HISTORY_HASH_INVALID", "Die RAS-Pruefsumme stimmt nicht.");
  }
  const signature = parseSignature(value.signature);
  if (!crypto.verify(null, Buffer.from(value.eventHash, "hex"), publicKey, signature)) {
    throw assuranceError("RAS_HISTORY_SIGNATURE_INVALID", "Die RAS-Signatur stimmt nicht.");
  }
  return value;
}

function headUnsigned(value) {
  return {
    format: value.format,
    schemaVersion: value.schemaVersion,
    eventCount: value.eventCount,
    lastSequence: value.lastSequence,
    lastEventHash: value.lastEventHash,
    keyId: value.keyId,
    generatedAt: value.generatedAt,
  };
}

function parseHead(value, publicKey, expectedKeyId) {
  assertExactKeys(value, HEAD_KEYS, "Der RAS-Kopfbeleg");
  if (value.format !== HEAD_FORMAT || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || !Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0
    || (value.lastEventHash !== null && !/^[a-f0-9]{64}$/.test(value.lastEventHash)) || value.keyId !== expectedKeyId
    || value.eventCount !== value.lastSequence) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Der RAS-Kopfbeleg ist ungueltig.");
  }
  parseUtcTimestamp(value.generatedAt, "generatedAt");
  if ((value.eventCount === 0) !== (value.lastEventHash === null)) {
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Der leere RAS-Kopfbeleg ist widerspruechlich.");
  }
  const hash = canonicalHash(headUnsigned(value));
  if (!crypto.verify(null, Buffer.from(hash, "hex"), publicKey, parseSignature(value.signature))) {
    throw assuranceError("RAS_HISTORY_SIGNATURE_INVALID", "Die Signatur des RAS-Kopfbelegs stimmt nicht.");
  }
  return value;
}

function assertSafeDirectory(directory, options) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error?.code === "ENOENT") throw assuranceError("RAS_HISTORY_MISSING", "Die Recovery-Pruefhistorie fehlt.");
    throw assuranceError("RAS_HISTORY_UNREADABLE", "Die Recovery-Pruefhistorie ist nicht sicher lesbar.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.nlink < 2 || (stat.mode & 0o7777) !== 0o750 || (stat.mode & 0o022) !== 0))
    || (options.requireRootOwner && typeof stat.uid === "number" && stat.uid !== 0)
    || (options.expectedGid !== null && typeof stat.gid === "number" && stat.gid !== options.expectedGid)) {
    throw assuranceError("RAS_HISTORY_PERMISSIONS_INVALID", "Der Recovery-Pruefpfad ist unsicher.");
  }
  return stat;
}

function readSafeFile(file, maximumBytes, options, expectedMode) {
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) {
      throw assuranceError("RAS_HISTORY_FILE_UNSAFE", "Eine Recovery-Pruefdatei ist unzulaessig.");
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1
      || stat.size < 1 || stat.size > maximumBytes
      || (process.platform !== "win32" && ((stat.mode & 0o7777) !== expectedMode || (stat.mode & 0o022) !== 0))
      || (options.requireRootOwner && typeof stat.uid === "number" && stat.uid !== 0)
      || (options.expectedGid !== null && typeof stat.gid === "number" && stat.gid !== options.expectedGid)) {
      throw assuranceError("RAS_HISTORY_FILE_UNSAFE", "Eine Recovery-Pruefdatei ist nicht sicher lesbar.");
    }
    const content = fs.readFileSync(descriptor);
    if (content.length < 1 || content.length > maximumBytes) {
      throw assuranceError("RAS_HISTORY_FILE_UNSAFE", "Eine Recovery-Pruefdatei hat eine unzulaessige Groesse.");
    }
    return content;
  } catch (error) {
    if (error instanceof RecoveryAssuranceStatusError) throw error;
    if (error?.code === "ENOENT") throw assuranceError("RAS_HISTORY_MISSING", "Die Recovery-Pruefhistorie fehlt.");
    throw assuranceError("RAS_HISTORY_UNREADABLE", "Die Recovery-Pruefhistorie ist nicht sicher lesbar.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJsonFile(file, maximumBytes, options, expectedMode = 0o640) {
  let value;
  try { value = JSON.parse(readSafeFile(file, maximumBytes, options, expectedMode).toString("utf8").replace(/^\uFEFF/, "")); }
  catch (error) {
    if (error instanceof RecoveryAssuranceStatusError) throw error;
    throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Eine Recovery-Pruefdatei enthaelt kein gueltiges JSON.");
  }
  return value;
}

function parsePublicKey(buffer) {
  let key;
  try { key = crypto.createPublicKey(buffer); }
  catch { throw assuranceError("RAS_HISTORY_PUBLIC_KEY_INVALID", "Der RAS-Pruefschluessel ist ungueltig."); }
  if (key.asymmetricKeyType !== "ed25519") {
    throw assuranceError("RAS_HISTORY_PUBLIC_KEY_INVALID", "Der RAS-Pruefschluessel wird nicht unterstuetzt.");
  }
  return key;
}

function publicEvent(event) {
  const payload = event.payload;
  return {
    sequence: event.sequence,
    eventId: payload.eventId,
    runId: payload.runId,
    occurredAt: payload.occurredAt,
    eventType: payload.eventType,
    trigger: payload.trigger,
    errorCode: payload.errorCode,
    evidence: {
      snapshotIdPrefix: payload.evidence.snapshotIdPrefix,
      receiptSha256Prefix: payload.evidence.receiptSha256 ? payload.evidence.receiptSha256.slice(0, 12) : null,
      appVersion: payload.evidence.appVersion,
    },
  };
}

function validateEventSemantics(events) {
  const runs = new Map();
  for (const event of events) {
    const payload = event.payload;
    const state = runs.get(payload.runId) || { started: null, terminal: null, phases: new Map() };
    if (payload.eventType === "full-assurance-started") {
      if (state.started || state.terminal) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Ein RAS-Lauf wurde widerspruechlich gestartet.");
      }
      state.started = event;
    } else if (PHASE_EVENT_SET.has(payload.eventType)) {
      const group = phaseGroup(payload.eventType);
      if (!state.started || state.terminal || state.started.payload.trigger !== payload.trigger
        || state.phases.has(group)
        || Date.parse(payload.occurredAt) < Date.parse(state.started.payload.occurredAt)) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Eine RAS-Pruefphase ist widerspruechlich.");
      }
      const phaseIndex = PHASE_ORDER.indexOf(group);
      if (phaseIndex !== state.phases.size) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Die RAS-Pruefphasen sind falsch geordnet.");
      }
      state.phases.set(group, event);
    } else if (["full-assurance-passed", "full-assurance-failed"].includes(payload.eventType)) {
      if (!state.started || state.terminal || state.started.payload.trigger !== payload.trigger
        || Date.parse(payload.occurredAt) < Date.parse(state.started.payload.occurredAt)) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Der Abschluss eines RAS-Laufs ist widerspruechlich.");
      }
      if (payload.eventType === "full-assurance-passed"
        && (PHASE_ORDER.some((phase) => !state.phases.has(phase))
          || state.phases.get("application-smoke")?.payload.eventType === "application-smoke-failed")) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Ein erfolgreicher RAS-Lauf ist unvollstaendig.");
      }
      if ((payload.errorCode === "APPLICATION_SMOKE_FAILED")
        !== (state.phases.get("application-smoke")?.payload.eventType === "application-smoke-failed")) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "App-Smoke-Phase und RAS-Abschluss widersprechen einander.");
      }
      state.terminal = event;
    } else if (state.terminal) {
      throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Nach Abschluss eines RAS-Laufs folgt ein unzulaessiges Ereignis.");
    }
    runs.set(payload.runId, state);
  }
}

function recentRunSummaries(events, maximum = MAX_RETURNED_RUNS) {
  const runs = new Map();
  for (const event of events) {
    const payload = event.payload;
    if (!["full-assurance-started", "full-assurance-passed", "full-assurance-failed", ...PHASE_EVENTS].includes(payload.eventType)) continue;
    const state = runs.get(payload.runId) || {
      runIdPrefix: String(payload.runId || "").slice(0, 8),
      trigger: payload.trigger,
      startedAt: null,
      completedAt: null,
      status: "running",
      errorCode: null,
      appVersion: null,
      snapshotIdPrefix: null,
      receiptSha256Prefix: null,
      phases: Object.fromEntries(PHASE_ORDER.map((id) => [id, { id, status: "pending", occurredAt: null }])),
    };
    if (payload.eventType === "full-assurance-started") state.startedAt = payload.occurredAt;
    else if (PHASE_EVENT_SET.has(payload.eventType)) {
      const group = phaseGroup(payload.eventType);
      state.phases[group] = {
        id: payload.eventType,
        status: payload.eventType === "application-smoke-not-run" ? "not_run"
          : payload.eventType === "application-smoke-failed" ? "failed" : "passed",
        occurredAt: payload.occurredAt,
      };
    } else {
      state.completedAt = payload.occurredAt;
      state.status = payload.eventType === "full-assurance-passed" ? "passed" : "failed";
      state.errorCode = payload.errorCode || null;
    }
    state.appVersion = payload.evidence.appVersion || state.appVersion;
    state.snapshotIdPrefix = payload.evidence.snapshotIdPrefix || state.snapshotIdPrefix;
    state.receiptSha256Prefix = payload.evidence.receiptSha256
      ? payload.evidence.receiptSha256.slice(0, 12) : state.receiptSha256Prefix;
    runs.set(payload.runId, state);
  }
  return [...runs.values()]
    .filter((run) => run.startedAt)
    .map((run) => ({
      ...run,
      durationSeconds: run.completedAt
        ? Math.max(0, Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000))
        : null,
      phases: PHASE_ORDER.map((id) => run.phases[id]),
    }))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, Math.max(0, Math.min(MAX_RETURNED_RUNS, Number(maximum) || MAX_RETURNED_RUNS)));
}

function fallbackDiagnostics(configured, error = null) {
  const enabled = configured === true;
  return {
    configured: enabled,
    state: enabled ? "error" : "unconfigured",
    statusAvailable: false,
    integrityVerified: false,
    severity: enabled ? "critical" : "info",
    lastErrorCode: enabled ? (error?.code || "RAS_HISTORY_UNAVAILABLE") : null,
    summary: enabled
      ? "Die signierte Recovery-Pruefhistorie konnte nicht sicher bestaetigt werden."
      : "Recovery Assurance ist nicht eingerichtet.",
    checkedAt: new Date().toISOString(),
    generatedAt: null,
    ageHours: null,
    maximumAgeHours: DEFAULT_MAXIMUM_RUN_AGE_HOURS,
    stale: enabled,
    eventCount: 0,
    lastSequence: 0,
    lastEventHashPrefix: null,
    events: [],
    recentRuns: [],
    trendRuns: [],
  };
}

function resolveOptions(options = {}) {
  const configured = options.configured === true;
  const root = path.resolve(String(options.rootPath || DEFAULT_ASSURANCE_ROOT));
  const eventDirectory = path.resolve(String(options.eventDirectory || path.join(root, "history")));
  const headPath = path.resolve(String(options.headPath || path.join(root, "head.json")));
  const publicKeyPath = path.resolve(String(options.publicKeyPath || path.join(root, "signing-public.pem")));
  if (!path.isAbsolute(root) || root === path.parse(root).root
    || eventDirectory !== path.join(root, "history")
    || headPath !== path.join(root, "head.json")
    || publicKeyPath !== path.join(root, "signing-public.pem")) {
    throw assuranceError("RAS_HISTORY_PATH_INVALID", "Der Recovery-Pruefpfad ist ungueltig.");
  }
  const requestedMaximum = Number(options.maximumReturnedEvents ?? MAX_RETURNED_EVENTS);
  const requestedMaximumRunAgeHours = Number(options.maximumRunAgeHours ?? DEFAULT_MAXIMUM_RUN_AGE_HOURS);
  return {
    configured,
    root,
    eventDirectory,
    headPath,
    publicKeyPath,
    requireRootOwner: options.requireRootOwner === undefined ? process.platform === "linux" : options.requireRootOwner === true,
    expectedGid: Number.isSafeInteger(options.expectedGid) && options.expectedGid >= 0 ? options.expectedGid : null,
    maximumReturnedEvents: Number.isSafeInteger(requestedMaximum)
      ? Math.max(0, Math.min(MAX_RETURNED_EVENTS, requestedMaximum)) : MAX_RETURNED_EVENTS,
    maximumRunAgeHours: Number.isFinite(requestedMaximumRunAgeHours)
      ? Math.max(24, Math.min(24 * 400, requestedMaximumRunAgeHours))
      : DEFAULT_MAXIMUM_RUN_AGE_HOURS,
    nowMs: options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now()),
  };
}

function readRecoveryAssuranceStatus(options = {}) {
  let requestedConfigured = false;
  try {
    if (!isPlainObject(options)) options = {};
    requestedConfigured = options.configured === true;
  } catch (error) {
    return fallbackDiagnostics(false, assuranceError("RAS_HISTORY_UNAVAILABLE", "Die Recovery-Pruefhistorie ist nicht sicher lesbar."));
  }
  let resolved;
  try { resolved = resolveOptions(options); }
  catch (error) { return fallbackDiagnostics(requestedConfigured, error); }
  if (!resolved.configured) return fallbackDiagnostics(false);
  try {
    const rootStat = assertSafeDirectory(resolved.root, resolved);
    if (resolved.expectedGid === null && process.platform !== "win32") resolved.expectedGid = rootStat.gid;
    assertSafeDirectory(resolved.eventDirectory, resolved);
    const publicKey = parsePublicKey(readSafeFile(resolved.publicKeyPath, MAX_PUBLIC_KEY_BYTES, resolved, 0o440));
    const keyId = publicKeyId(publicKey);
    const head = parseHead(readJsonFile(resolved.headPath, MAX_HEAD_BYTES, resolved), publicKey, keyId);
    const names = fs.readdirSync(resolved.eventDirectory);
    if (names.length > MAX_HISTORY_FILES) {
      throw assuranceError("RAS_HISTORY_TOO_LARGE", "Die Recovery-Pruefhistorie ist groesser als der freigegebene Leserahmen.");
    }
    const pattern = /^(\d{12})-([a-f0-9]{64})\.json$/;
    const indexed = names.map((name) => {
      const match = name.match(pattern);
      if (!match) throw assuranceError("RAS_HISTORY_FILE_UNSAFE", "Die Recovery-Pruefhistorie enthaelt eine unbekannte Datei.");
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw assuranceError("RAS_HISTORY_SCHEMA_INVALID", "Eine RAS-Sequenz ist ungueltig.");
      }
      return { name, sequence, eventHash: match[2] };
    }).sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name));
    if (indexed.length !== head.eventCount) {
      throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "RAS-Kopfbeleg und Ereigniszahl stimmen nicht ueberein.");
    }
    let previousHash = null;
    let previousOccurredAt = null;
    const events = [];
    for (let index = 0; index < indexed.length; index += 1) {
      const entry = indexed[index];
      const event = parseEvent(readJsonFile(path.join(resolved.eventDirectory, entry.name), MAX_EVENT_BYTES, resolved), publicKey, keyId);
      const expectedSequence = index + 1;
      if (entry.sequence !== expectedSequence || event.sequence !== expectedSequence
        || event.eventHash !== entry.eventHash || event.previousHash !== previousHash) {
        throw assuranceError("RAS_HISTORY_CHAIN_INVALID", "Die signierte RAS-Kette ist unvollstaendig oder falsch geordnet.");
      }
      if (previousOccurredAt && Date.parse(event.payload.occurredAt) < Date.parse(previousOccurredAt)) {
        throw assuranceError("RAS_HISTORY_TIME_INVALID", "Die RAS-Zeitfolge ist unplausibel.");
      }
      if (Number.isFinite(resolved.nowMs) && Date.parse(event.payload.occurredAt) > resolved.nowMs + 5 * 60 * 1000) {
        throw assuranceError("RAS_HISTORY_TIME_INVALID", "Ein RAS-Zeitstempel liegt unplausibel in der Zukunft.");
      }
      previousHash = event.eventHash;
      previousOccurredAt = event.payload.occurredAt;
      events.push(event);
    }
    validateEventSemantics(events);
    if (head.lastSequence !== indexed.length || head.lastEventHash !== previousHash
      || (events.length && Date.parse(head.generatedAt) < Date.parse(events.at(-1).payload.occurredAt))
      || (Number.isFinite(resolved.nowMs) && Date.parse(head.generatedAt) > resolved.nowMs + 5 * 60 * 1000)) {
      throw assuranceError("RAS_HISTORY_HEAD_INVALID", "Der RAS-Kopfbeleg passt nicht zur signierten Historie.");
    }
    const returned = events.slice(-resolved.maximumReturnedEvents).reverse().map(publicEvent);
    const recentRuns = recentRunSummaries(events);
    const trendRuns = recoveryTrendRuns(events, {
      now: new Date(Number.isFinite(resolved.nowMs) ? resolved.nowMs : Date.now()),
    });
    const statusEvent = [...events].reverse().find((event) => event.payload.eventType.startsWith("full-assurance-")
      || ["configuration-change-queued", "update-queued"].includes(event.payload.eventType));
    const completedAt = statusEvent?.payload.eventType === "full-assurance-passed"
      ? statusEvent.payload.occurredAt : null;
    const ageHours = completedAt && Number.isFinite(resolved.nowMs)
      ? Math.max(0, (resolved.nowMs - Date.parse(completedAt)) / 3600000)
      : null;
    const stale = statusEvent?.payload.eventType === "full-assurance-passed"
      && (!Number.isFinite(ageHours) || ageHours > resolved.maximumRunAgeHours);
    const state = statusEvent?.payload.eventType === "full-assurance-failed"
      ? "error" : statusEvent?.payload.eventType === "full-assurance-passed" && !stale ? "ok" : "warning";
    return {
      configured: true,
      state,
      statusAvailable: true,
      integrityVerified: true,
      severity: state === "error" ? "critical" : state === "warning" ? "warning" : "info",
      lastErrorCode: state === "error" ? statusEvent.payload.errorCode : null,
      summary: events.length
        ? stale
          ? "Die signierte Recovery-Pruefhistorie ist gueltig; der letzte vollstaendige Lauf ist jedoch zu alt."
          : "Die signierte Recovery-Pruefhistorie wurde vollstaendig bestaetigt."
        : "Recovery Assurance ist eingerichtet; es liegen noch keine Pruefereignisse vor.",
      checkedAt: new Date(Number.isFinite(resolved.nowMs) ? resolved.nowMs : Date.now()).toISOString(),
      generatedAt: head.generatedAt,
      ageHours: Number.isFinite(ageHours) ? Math.round(ageHours * 100) / 100 : null,
      maximumAgeHours: resolved.maximumRunAgeHours,
      stale,
      eventCount: head.eventCount,
      lastSequence: head.lastSequence,
      lastEventHashPrefix: head.lastEventHash ? head.lastEventHash.slice(0, 12) : null,
      events: returned,
      recentRuns,
      trendRuns,
    };
  } catch (error) {
    return fallbackDiagnostics(true, error instanceof RecoveryAssuranceStatusError
      ? error : assuranceError("RAS_HISTORY_UNREADABLE", "Die Recovery-Pruefhistorie ist nicht sicher lesbar."));
  }
}

module.exports = {
  DEFAULT_ASSURANCE_ROOT,
  DEFAULT_EVENT_DIRECTORY,
  DEFAULT_HEAD_PATH,
  DEFAULT_PUBLIC_KEY_PATH,
  EVENT_FORMAT,
  HEAD_FORMAT,
  SCHEMA_VERSION,
  MAX_EVENT_BYTES,
  MAX_HEAD_BYTES,
  MAX_HISTORY_FILES,
  MAX_RETURNED_EVENTS,
  MAX_RETURNED_RUNS,
  DEFAULT_MAXIMUM_RUN_AGE_HOURS,
  RecoveryAssuranceStatusError,
  canonicalJson,
  canonicalHash,
  eventUnsigned,
  headUnsigned,
  publicKeyId,
  recentRunSummaries,
  readRecoveryAssuranceStatus,
};
