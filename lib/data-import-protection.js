"use strict";

const crypto = require("node:crypto");
const { canonical, fail, id, LIMITS } = require("./data-import-contract");

// Composition must supply managed keys. This module never provisions keys or reads credentials.
// Keep indexKey stable across encryption-key rotation, otherwise source identity changes.
function createDataImportProtection({ encryptionKey, indexKey, keyId }) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || !Buffer.isBuffer(indexKey) || indexKey.length !== 32) fail("IMPORT_PROTECTION_KEY_INVALID");
  id(keyId);
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)) fail("IMPORT_PROTECTION_KEY_INVALID");
  const encryption = Buffer.from(encryptionKey), index = Buffer.from(indexKey);
  let destroyed = false;
  function active() { if (destroyed) fail("IMPORT_PROTECTION_UNAVAILABLE"); }
  return Object.freeze({
    digest(value) { active(); return crypto.createHmac("sha256", index).update("gp-import-index:v1:").update(canonical(value)).digest("hex"); },
    seal(value, context) {
      active(); const bytes = Buffer.from(canonical(value));
      try {
        if (bytes.length > LIMITS.rowBytes * 6) fail("IMPORT_PROTECTED_PAYLOAD_TOO_LARGE", 413);
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryption, iv);
        cipher.setAAD(Buffer.from(canonical(["gp-import-payload", 1, keyId, context])));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return ["gp-import-v1", keyId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
      } finally { bytes.fill(0); }
    },
    open(envelope, context) {
      active(); let bytes;
      try {
        if (typeof envelope !== "string" || envelope.length > LIMITS.rowBytes * 9) throw new Error();
        const parts = envelope.split(":");
        if (parts.length !== 5 || parts[0] !== "gp-import-v1" || parts[1] !== keyId) throw new Error();
        const decode = value => { const decoded = Buffer.from(value, "base64"); if (decoded.toString("base64") !== value) throw new Error(); return decoded; };
        const iv = decode(parts[2]), tag = decode(parts[3]); if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = crypto.createDecipheriv("aes-256-gcm", encryption, iv);
        decipher.setAAD(Buffer.from(canonical(["gp-import-payload", 1, keyId, context]))); decipher.setAuthTag(tag);
        bytes = Buffer.concat([decipher.update(decode(parts[4])), decipher.final()]);
        return JSON.parse(bytes.toString("utf8"));
      } catch { fail("IMPORT_PROTECTED_PAYLOAD_INVALID"); }
      finally { bytes?.fill(0); }
    },
    destroy() { destroyed = true; encryption.fill(0); index.fill(0); },
  });
}
module.exports = { createDataImportProtection };
