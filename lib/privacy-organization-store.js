"use strict";

const crypto = require("node:crypto");
const { assertPersistenceProvider, PERSISTENCE_ERROR_CODES } = require("./persistence/contract");
const { createApplicationRepositories } = require("./persistence/application-repositories");
const {
  createPrivacyLedger,
  verifyPrivacyLedger,
  applyPrivacyCommand,
  projectPrivacyLedger,
} = require("./privacy-organization");
const { PRIVACY_ORGANIZATION_SETTING_KEY } = require("./privacy-organization-settings");

const PROTECTION_CONTEXT = Object.freeze({
  namespace: "privacy-organization",
  recordId: "ledger-v1",
  field: "ledger",
  employeeNumber: "system",
});
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const PRIVACY_ROLES = new Set(["hr", "admin"]);
const RECORD_KINDS = new Set(["organization", "activity", "dpia", "breach", "works_agreement"]);

function storeError(message, code, statusCode = 503) {
  return Object.assign(new Error(message), { name: "PrivacyOrganizationStoreError", code, statusCode });
}

function cloneJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (!value || typeof value !== "object" || depth > 64 || seen.has(value)) {
    throw storeError("Die Datenschutzaktion enthält ungültige Daten.", "PRIVACY_ORGANIZATION_COMMAND_INVALID", 400);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw storeError("Die Datenschutzaktion enthält ungültige Daten.", "PRIVACY_ORGANIZATION_COMMAND_INVALID", 400);
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value).filter(key => key !== "length" || !Array.isArray(value));
    if (Array.isArray(value) && (keys.length !== value.length
      || keys.some(key => typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length))) {
      throw storeError("Die Datenschutzaktion enthält ungültige Daten.", "PRIVACY_ORGANIZATION_COMMAND_INVALID", 400);
    }
    const result = Array.isArray(value) ? [] : {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !property || !Object.hasOwn(property, "value")
        || !property.enumerable || key === "__proto__") {
        throw storeError("Die Datenschutzaktion enthält ungültige Daten.", "PRIVACY_ORGANIZATION_COMMAND_INVALID", 400);
      }
      result[key] = cloneJson(property.value, seen, depth + 1);
    }
    if (Array.isArray(value) && result.length !== value.length) {
      throw storeError("Die Datenschutzaktion enthält ungültige Daten.", "PRIVACY_ORGANIZATION_COMMAND_INVALID", 400);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function actorCapabilities(actor) {
  const eligible = Boolean(actor?.personal === true && PRIVACY_ROLES.has(actor.role));
  return {
    read: eligible && actor.permissions?.includes("privacy_organization:read") === true,
    manage: eligible && actor.permissions?.includes("privacy_organization:manage") === true,
    approve: eligible && actor.permissions?.includes("privacy_organization:approve") === true,
  };
}

function requirePersonalActor(actor, { read = false } = {}) {
  if (!actor || actor.personal !== true || !PRIVACY_ROLES.has(actor.role)
    || typeof actor.employeeNumber !== "string" || !actor.employeeNumber.trim()
    || ["local", "system", "data_subject"].includes(actor.employeeNumber.toLowerCase())
    || !Array.isArray(actor.permissions) || (read && !actorCapabilities(actor).read)) {
    throw storeError("Für die Datenschutzorganisation fehlt ein berechtigtes persönliches Konto.",
      "PRIVACY_ORGANIZATION_PERMISSION_DENIED", 403);
  }
  return actor;
}

function createPrivacyOrganizationStore({
  provider,
  protectJson,
  parseProtectedJson,
  revalidateActor,
  initialOrganization,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  assertPersistenceProvider(provider);
  if ([protectJson, parseProtectedJson, revalidateActor, now, randomUUID]
    .some(callback => typeof callback !== "function")) {
    throw new TypeError("Datenschutzorganisation benötigt Verschlüsselung und erneute Kontoprüfung.");
  }
  const genesis = createPrivacyLedger({ initialOrganization: initialOrganization === undefined
    ? undefined : cloneJson(initialOrganization) });
  verifyPrivacyLedger(genesis);

  function instant() {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) throw new TypeError("Der Datenschutzzeitpunkt ist ungültig.");
    return value.toISOString();
  }

  async function load(repositories) {
    const rows = (await repositories.planningSettings.listSettings())
      .filter(row => row.key === PRIVACY_ORGANIZATION_SETTING_KEY);
    if (rows.length > 1) {
      throw storeError("Der Datenschutzverlauf konnte nicht sicher geprüft werden.", "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
    }
    if (!rows.length) return { present: false, ledger: cloneJson(genesis) };
    const encrypted = rows[0].value;
    if (typeof encrypted !== "string" || !encrypted.startsWith("enc:v2:")
      || Buffer.byteLength(encrypted) > MAX_LEDGER_BYTES * 2) {
      throw storeError("Der Datenschutzverlauf liegt nicht im geschützten Format vor.", "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
    }
    try {
      const ledger = cloneJson(await parseProtectedJson(encrypted, PROTECTION_CONTEXT));
      verifyPrivacyLedger(ledger);
      return { present: true, ledger };
    } catch {
      throw storeError("Der geschützte Datenschutzverlauf konnte nicht sicher geprüft werden.", "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
    }
  }

  function resultFor(ledger, actor) {
    return { ...projectPrivacyLedger(ledger, { now: instant() }), capabilities: actorCapabilities(actor) };
  }

  async function read(sessionContext) {
    return provider.transaction(async executor => {
      const repositories = createApplicationRepositories(executor);
      const actor = requirePersonalActor(await revalidateActor(sessionContext, repositories, { action: "read" }), { read: true });
      return resultFor((await load(repositories)).ledger, actor);
    }, { isolation: "serializable", readOnly: true });
  }

  // Internal startup/restore verification; this does not expose records or
  // create a substitute user, and it never writes an unpersisted initial draft.
  async function verifyIntegrity() {
    return provider.transaction(async executor => {
      const { present, ledger } = await load(createApplicationRepositories(executor));
      const verified = verifyPrivacyLedger(ledger);
      return { present, revision: verified.revision, receiptSha256: verified.receiptSha256 };
    }, { isolation: "serializable", readOnly: true });
  }

  async function command(input, sessionContext) {
    const captured = cloneJson(input);
    if (!captured || Array.isArray(captured) || !Number.isSafeInteger(captured.expectedRevision)
      || captured.expectedRevision < 0) {
      throw storeError("Bitte die aktuelle Revision der Datenschutzorganisation mitsenden.",
        "PRIVACY_ORGANIZATION_REVISION_REQUIRED", 400);
    }
    // Keep the original expected revision through every retry. Replaying a
    // stale editor draft against newer state must remain a conflict.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await provider.transaction(async executor => {
          const repositories = createApplicationRepositories(executor);
          const { ledger } = await load(repositories);
          const actor = requirePersonalActor(await revalidateActor(sessionContext, repositories,
            cloneJson(captured), cloneJson(ledger)), { read: true });
          if (ledger.revision !== captured.expectedRevision) {
            throw storeError("Die Datenschutzorganisation wurde inzwischen geändert. Bitte neu laden.",
              "PRIVACY_ORGANIZATION_REVISION_CONFLICT", 409);
          }
          const next = applyPrivacyCommand(ledger, captured, {
            actor, now: instant(), randomUUID,
          });
          verifyPrivacyLedger(next);
          if (next.revision !== ledger.revision + 1) {
            throw storeError("Die Datenschutzaktion besitzt keine lückenlose Revision.", "PRIVACY_ORGANIZATION_INTEGRITY_FAILED");
          }
          if (Buffer.byteLength(JSON.stringify(next)) > MAX_LEDGER_BYTES) {
            throw storeError("Der Datenschutzverlauf überschreitet die unterstützte Größe.", "PRIVACY_ORGANIZATION_LEDGER_LIMIT", 413);
          }
          const encrypted = await protectJson(next, PROTECTION_CONTEXT);
          if (typeof encrypted !== "string" || !encrypted.startsWith("enc:v2:")
            || encrypted.includes("\0") || Buffer.byteLength(encrypted) > MAX_LEDGER_BYTES * 2) {
            throw storeError("Der Datenschutzverlauf konnte nicht geschützt gespeichert werden.", "PRIVACY_ORGANIZATION_PROTECTION_FAILED");
          }
          const write = await repositories.planningSettings.upsertSetting({ key: PRIVACY_ORGANIZATION_SETTING_KEY, value: encrypted });
          const persisted = (await repositories.planningSettings.listSettings())
            .find(row => row.key === PRIVACY_ORGANIZATION_SETTING_KEY);
          if (write.rowsAffected !== 1 || persisted?.value !== encrypted) {
            throw storeError("Der Datenschutzverlauf wurde nicht vollständig gespeichert.", "PRIVACY_ORGANIZATION_WRITE_INCOMPLETE");
          }
          const event = next.events.at(-1);
          const kind = RECORD_KINDS.has(event.kind) ? event.kind : "organization";
          // Core also permits stable imported case IDs. Hash those identifiers
          // in the ordinary audit; names or document references cannot leak
          // simply because somebody used them as a custom identifier.
          const id = event.recordId === "organization" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.recordId)
            ? event.recordId : `sha256:${crypto.createHash("sha256").update(event.recordId).digest("hex")}`;
          const audit = await repositories.organizationPersonnel.insertAudit(actor.employeeNumber,
            "privacy-organization.command", "privacy_organization", id,
            JSON.stringify({ action: event.action, kind, id, revision: next.revision, receiptSha256: next.receiptSha256 }));
          if (audit.rowsAffected !== 1 || audit.returnedRows.length !== 1) {
            throw storeError("Der Datenschutzänderungsbeleg wurde nicht vollständig gespeichert.", "PRIVACY_ORGANIZATION_AUDIT_INCOMPLETE");
          }
          return resultFor(next, actor);
        }, { isolation: "serializable" });
      } catch (error) {
        if (provider.getCapabilities().providerId !== "postgresql"
          || error?.code !== PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION || attempt >= 3) throw error;
      }
    }
  }

  return Object.freeze({ read, command, verifyIntegrity });
}

module.exports = { createPrivacyOrganizationStore };
