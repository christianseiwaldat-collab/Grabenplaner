"use strict";

const OPERATIONAL_CONTRACT_VERSION = 1;
const OPERATIONAL_CAPABILITY_KEYS = Object.freeze([
  "databaseBackup",
  "restore",
  "integrityCheck",
  "recoveryAssurance",
  "systemCenterStatus",
  "pairedDocumentBackup",
  "pointInTimeRecovery",
]);
const OPERATIONAL_PROFILES = new Set(["supported", "development-contract"]);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;

class PersistenceOperationsContractError extends Error {
  constructor(code = "PERSISTENCE_OPERATIONS_CONTRACT_INVALID") {
    super("Der Datenbank-Betriebsvertrag ist ungültig.");
    this.name = "PersistenceOperationsContractError";
    this.code = code;
  }
}

function contractError(code) {
  return new PersistenceOperationsContractError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed) {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw contractError();
  }
}

function canonicalTimestamp(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === "" || value === undefined)) return null;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw contractError();
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizeCapability(value, {
  generatedAtMs,
  profile,
} = {}) {
  exactKeys(value, [
    "implemented",
    "configured",
    "verified",
    "reasonCode",
    "lastVerifiedAt",
    "maximumAgeHours",
  ]);
  if (typeof value.implemented !== "boolean"
    || typeof value.configured !== "boolean"
    || typeof value.verified !== "boolean"
    || (value.reasonCode !== null && !REASON_CODE_PATTERN.test(String(value.reasonCode || "")))
    || (value.maximumAgeHours !== null && (
      !Number.isSafeInteger(value.maximumAgeHours)
      || value.maximumAgeHours < 1
      || value.maximumAgeHours > 24 * 400
    ))) {
    throw contractError();
  }
  const lastVerifiedAt = canonicalTimestamp(value.lastVerifiedAt, { nullable: true });
  if (value.verified !== Boolean(lastVerifiedAt)
    || (!value.implemented && (value.configured || value.verified))
    || (!value.configured && value.verified)
    || (value.verified && value.reasonCode !== null)) {
    throw contractError();
  }
  const ageHours = lastVerifiedAt === null
    ? null
    : Math.max(0, (generatedAtMs - Date.parse(lastVerifiedAt)) / 3_600_000);
  const future = lastVerifiedAt !== null && Date.parse(lastVerifiedAt) > generatedAtMs + 5 * 60 * 1000;
  const stale = lastVerifiedAt !== null
    && value.maximumAgeHours !== null
    && ageHours > value.maximumAgeHours;
  let state = "available";
  if (!value.implemented) state = "unavailable";
  else if (!value.configured) state = "not-configured";
  else if (!value.verified) state = "not-verified";
  else if (future || stale) state = "stale";
  const effective = profile === "supported" && state === "available";
  return {
    implemented: value.implemented,
    configured: value.configured,
    verified: value.verified,
    effective,
    state,
    reasonCode: state === "available" ? null : value.reasonCode,
    lastVerifiedAt,
    maximumAgeHours: value.maximumAgeHours,
    ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
  };
}

function createOperationalCapabilityReport({
  providerId,
  profile,
  backupMethod,
  restoreMethod,
  artifactFormat,
  generatedAt = new Date().toISOString(),
  capabilities,
} = {}) {
  if (!PROVIDER_PATTERN.test(String(providerId || ""))
    || !OPERATIONAL_PROFILES.has(profile)
    || !METHOD_PATTERN.test(String(backupMethod || ""))
    || !METHOD_PATTERN.test(String(restoreMethod || ""))
    || !METHOD_PATTERN.test(String(artifactFormat || ""))) {
    throw contractError();
  }
  const normalizedGeneratedAt = canonicalTimestamp(generatedAt);
  exactKeys(capabilities, OPERATIONAL_CAPABILITY_KEYS);
  const generatedAtMs = Date.parse(normalizedGeneratedAt);
  const normalizedCapabilities = Object.fromEntries(
    OPERATIONAL_CAPABILITY_KEYS.map((key) => [
      key,
      normalizeCapability(capabilities[key], { generatedAtMs, profile }),
    ]),
  );
  return deepFreeze({
    contractVersion: OPERATIONAL_CONTRACT_VERSION,
    providerId,
    profile,
    productActivation: profile === "supported",
    backupMethod,
    restoreMethod,
    artifactFormat,
    generatedAt: normalizedGeneratedAt,
    capabilities: normalizedCapabilities,
  });
}

function assertOperationsAdapter(adapter) {
  if (!isPlainObject(adapter)) throw contractError();
  exactKeys(adapter, [
    "getCapabilityReport",
    "preflight",
    "createSnapshot",
    "verifySnapshot",
    "restoreIntoEmptyTarget",
    "verifyRestoredTarget",
    "readDiagnostics",
    "close",
  ]);
  for (const method of Object.keys(adapter)) {
    if (typeof adapter[method] !== "function") throw contractError();
  }
}

function createPersistenceOperationsFacade(adapter) {
  assertOperationsAdapter(adapter);
  let state = "open";
  let active = 0;
  let closePromise = null;
  const waiters = new Set();

  function begin(operation) {
    if (state !== "open") {
      throw contractError(state === "closed"
        ? "PERSISTENCE_OPERATIONS_CLOSED"
        : "PERSISTENCE_OPERATIONS_CLOSING");
    }
    active += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      active = Math.max(0, active - 1);
      if (active === 0) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    };
  }

  async function invoke(operation, input) {
    const finish = begin(operation);
    try {
      return await adapter[operation](input);
    } finally {
      finish();
    }
  }

  const facade = {
    getCapabilityReport() {
      return adapter.getCapabilityReport();
    },
    preflight(input) {
      return invoke("preflight", input);
    },
    createSnapshot(input) {
      return invoke("createSnapshot", input);
    },
    verifySnapshot(input) {
      return invoke("verifySnapshot", input);
    },
    restoreIntoEmptyTarget(input) {
      return invoke("restoreIntoEmptyTarget", input);
    },
    verifyRestoredTarget(input) {
      return invoke("verifyRestoredTarget", input);
    },
    readDiagnostics(input) {
      return invoke("readDiagnostics", input);
    },
    close() {
      if (closePromise) return closePromise;
      state = "closing";
      closePromise = (async () => {
        if (active > 0) await new Promise((resolve) => waiters.add(resolve));
        await adapter.close();
        state = "closed";
      })();
      return closePromise;
    },
  };
  return Object.freeze(facade);
}

module.exports = {
  OPERATIONAL_CAPABILITY_KEYS,
  OPERATIONAL_CONTRACT_VERSION,
  PersistenceOperationsContractError,
  createOperationalCapabilityReport,
  createPersistenceOperationsFacade,
};
