"use strict";

const crypto = require("node:crypto");

const SECRET_PREFIX = "gp-integration-secret:v1:";
const AAD_PREFIX = "grabenplaner-integration-secret-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 64;
const MAX_SECRET_BYTES = 64 * 1024;

class IntegrationSecretVaultError extends Error {
  constructor(message, code, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "IntegrationSecretVaultError";
    this.code = code;
  }
}

function vaultError(message, code, cause = null) {
  return new IntegrationSecretVaultError(message, code, cause);
}

function normalizeKeyId(value) {
  const keyId = String(value || "").trim();
  if (!keyId || Buffer.byteLength(keyId, "utf8") > MAX_KEY_ID_BYTES || !/^[A-Za-z0-9._-]+$/.test(keyId)) {
    throw vaultError("Die Schlüsselkennung für Schnittstellen ist ungültig.", "INTEGRATION_SECRET_KEY_ID_INVALID");
  }
  return keyId;
}

function normalizeKey(value) {
  let key;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) key = Buffer.from(value);
  else if (typeof value === "string") {
    const text = value.trim();
    key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  } else key = Buffer.alloc(0);
  if (key.length !== 32) {
    key.fill(0);
    throw vaultError("Der Schlüssel für Schnittstellen muss genau 32 Byte lang sein.", "INTEGRATION_SECRET_KEY_INVALID");
  }
  return key;
}

function normalizeContext(context = {}) {
  const normalized = {
    namespace: String(context.namespace || "integration-connector").trim(),
    connectorId: String(context.connectorId || "").trim(),
    field: String(context.field || "credential").trim(),
    purpose: String(context.purpose || "api-delivery").trim(),
  };
  if (!normalized.namespace || !normalized.connectorId || !normalized.field || !normalized.purpose
    || normalized.namespace.length > 80 || normalized.connectorId.length > 160
    || normalized.field.length > 80 || normalized.purpose.length > 80) {
    throw vaultError("Für das Schnittstellengeheimnis fehlt der Datensatzkontext.", "INTEGRATION_SECRET_CONTEXT_REQUIRED");
  }
  return normalized;
}

function contextAad(context) {
  return Buffer.from(`${AAD_PREFIX}\0${JSON.stringify(normalizeContext(context))}`, "utf8");
}

function createKeyResolver(options = {}) {
  if (typeof options.resolveKey === "function") return options.resolveKey;
  const entries = options.keys instanceof Map ? [...options.keys.entries()] : Object.entries(options.keys || {});
  const keys = new Map(entries.map(([keyId, key]) => [normalizeKeyId(keyId), normalizeKey(key)]));
  return (keyId) => keys.get(keyId) || null;
}

function createIntegrationSecretVault(options = {}) {
  const activeKeyId = normalizeKeyId(options.activeKeyId);
  const resolveKey = createKeyResolver(options);
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;

  function keyFor(keyId) {
    let resolved;
    try {
      resolved = resolveKey(keyId);
    } catch (error) {
      throw vaultError("Der Schlüssel für Schnittstellen ist nicht verfügbar.", "INTEGRATION_SECRET_KEY_UNAVAILABLE", error);
    }
    if (resolved === null || resolved === undefined) {
      throw vaultError("Der Schlüssel für Schnittstellen ist nicht verfügbar.", "INTEGRATION_SECRET_KEY_UNAVAILABLE");
    }
    return normalizeKey(resolved);
  }

  function seal(value, context) {
    const secret = Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(String(value ?? ""), "utf8");
    if (!secret.length || secret.length > MAX_SECRET_BYTES) {
      secret.fill(0);
      throw vaultError("Das Schnittstellengeheimnis ist leer oder zu groß.", "INTEGRATION_SECRET_VALUE_INVALID");
    }
    const keyIdBuffer = Buffer.from(activeKeyId, "utf8");
    let key = null;
    let iv;
    try {
      key = keyFor(activeKeyId);
      iv = Buffer.from(randomBytes(IV_BYTES));
      if (iv.length !== IV_BYTES) throw new Error("invalid IV length");
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(contextAad(context));
      const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
      const payload = Buffer.concat([
        Buffer.from([keyIdBuffer.length]),
        keyIdBuffer,
        iv,
        cipher.getAuthTag(),
        encrypted,
      ]);
      return `${SECRET_PREFIX}${payload.toString("base64url")}`;
    } catch (error) {
      if (error instanceof IntegrationSecretVaultError) throw error;
      throw vaultError("Das Schnittstellengeheimnis konnte nicht geschützt werden.", "INTEGRATION_SECRET_ENCRYPTION_FAILED", error);
    } finally {
      secret.fill(0);
      if (key) key.fill(0);
      if (iv) iv.fill(0);
    }
  }

  function decodeEnvelope(value) {
    const text = String(value || "");
    if (!text.startsWith(SECRET_PREFIX)) {
      throw vaultError("Das Schnittstellengeheimnis liegt nicht im geschützten Format vor.", "INTEGRATION_SECRET_FORMAT_INVALID");
    }
    let payload;
    const encoded = text.slice(SECRET_PREFIX.length);
    try {
      payload = Buffer.from(encoded, "base64url");
    } catch (error) {
      throw vaultError("Das geschützte Schnittstellengeheimnis ist ungültig.", "INTEGRATION_SECRET_FORMAT_INVALID", error);
    }
    if (payload.toString("base64url") !== encoded) {
      payload.fill(0);
      throw vaultError("Das Schnittstellengeheimnis ist beschädigt, vertauscht oder der Schlüssel fehlt.", "INTEGRATION_SECRET_INTEGRITY_FAILED");
    }
    const minimum = 1 + 1 + IV_BYTES + TAG_BYTES + 1;
    if (payload.length < minimum) {
      payload.fill(0);
      throw vaultError("Das geschützte Schnittstellengeheimnis ist ungültig.", "INTEGRATION_SECRET_FORMAT_INVALID");
    }
    const keyIdLength = payload[0];
    const headerLength = 1 + keyIdLength + IV_BYTES + TAG_BYTES;
    if (!keyIdLength || keyIdLength > MAX_KEY_ID_BYTES || payload.length <= headerLength) {
      payload.fill(0);
      throw vaultError("Das geschützte Schnittstellengeheimnis ist ungültig.", "INTEGRATION_SECRET_FORMAT_INVALID");
    }
    let offset = 1;
    const keyId = normalizeKeyId(payload.subarray(offset, offset + keyIdLength).toString("utf8"));
    offset += keyIdLength;
    const iv = Buffer.from(payload.subarray(offset, offset + IV_BYTES)); offset += IV_BYTES;
    const tag = Buffer.from(payload.subarray(offset, offset + TAG_BYTES)); offset += TAG_BYTES;
    const encrypted = Buffer.from(payload.subarray(offset));
    payload.fill(0);
    return { keyId, iv, tag, encrypted };
  }

  function unlockForConsumer(value, context) {
    const envelope = decodeEnvelope(value);
    const key = keyFor(envelope.keyId);
    let plaintext = null;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.iv);
      decipher.setAAD(contextAad(context));
      decipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([decipher.update(envelope.encrypted), decipher.final()]);
    } catch (error) {
      key.fill(0);
      envelope.iv.fill(0);
      envelope.tag.fill(0);
      envelope.encrypted.fill(0);
      throw vaultError("Das Schnittstellengeheimnis ist beschädigt, vertauscht oder der Schlüssel fehlt.", "INTEGRATION_SECRET_INTEGRITY_FAILED", error);
    }
    return { plaintext, dispose() {
      key.fill(0);
      envelope.iv.fill(0);
      envelope.tag.fill(0);
      envelope.encrypted.fill(0);
      if (plaintext) plaintext.fill(0);
    } };
  }

  async function useSecret(value, context, consumer) {
    if (typeof consumer !== "function") {
      throw vaultError("Für das Schnittstellengeheimnis fehlt die sichere Verwendung.", "INTEGRATION_SECRET_CONSUMER_REQUIRED");
    }
    const unlocked = unlockForConsumer(value, context);
    try { await consumer(unlocked.plaintext); }
    finally { unlocked.dispose(); }
  }

  // Startup/rollback backups have a synchronous contract. No plaintext-returning
  // getter is introduced; buffers are cleared even when the consumer fails.
  function useSecretSync(value, context, consumer) {
    if (typeof consumer !== "function") {
      throw vaultError("Für das Schnittstellengeheimnis fehlt die sichere Verwendung.", "INTEGRATION_SECRET_CONSUMER_REQUIRED");
    }
    const unlocked = unlockForConsumer(value, context);
    try {
      const result = consumer(unlocked.plaintext);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw vaultError("Die synchrone Geheimnisverwendung darf nicht asynchron fortgesetzt werden.", "INTEGRATION_SECRET_SYNC_CONSUMER_REQUIRED");
      }
    } finally { unlocked.dispose(); }
  }

  async function reseal(value, context) {
    let rotated = "";
    await useSecret(value, context, async (secret) => {
      rotated = seal(secret, context);
    });
    return rotated;
  }

  function inspect(value) {
    const envelope = decodeEnvelope(value);
    try {
      return { version: 1, keyId: envelope.keyId, protected: true };
    } finally {
      envelope.iv.fill(0);
      envelope.tag.fill(0);
      envelope.encrypted.fill(0);
    }
  }

  // Deliberately no decrypt/open/get method: plaintext is available only inside useSecret().
  return Object.freeze({ seal, useSecret, useSecretSync, reseal, inspect, activeKeyId });
}

module.exports = {
  IntegrationSecretVaultError,
  SECRET_PREFIX,
  createIntegrationSecretVault,
};
