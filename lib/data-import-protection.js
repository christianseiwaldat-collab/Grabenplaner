"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { canonical, fail, id, LIMITS } = require("./data-import-contract");

// Composition must supply managed keys. This module never provisions keys or reads credentials.
// Keep indexKey stable across encryption-key rotation, otherwise source identity changes.
function createDataImportProtection({ encryptionKey, indexKey, keyId, compression = false }) {
  if (typeof compression !== "boolean") fail("IMPORT_PROTECTION_MODE_INVALID");
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || !Buffer.isBuffer(indexKey) || indexKey.length !== 32) fail("IMPORT_PROTECTION_KEY_INVALID");
  id(keyId);
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)) fail("IMPORT_PROTECTION_KEY_INVALID");
  const encryption = Buffer.from(encryptionKey), index = Buffer.from(indexKey);
  const blockEncryption = Buffer.from(crypto.hkdfSync("sha256", encryption, Buffer.alloc(0),
    Buffer.from("grabenplaner:data-import:evidence-block:aes-256-gcm:v1"), 32));
  let destroyed = false;
  function active() { if (destroyed) fail("IMPORT_PROTECTION_UNAVAILABLE"); }
  function seal(value, context, block) {
    active(); const bytes = Buffer.from(canonical(value)); let packed;
    try {
      if (bytes.length > LIMITS.rowBytes * 6) fail("IMPORT_PROTECTED_PAYLOAD_TOO_LARGE", 413);
      if (compression && bytes.length >= 512) packed = zlib.deflateRawSync(bytes, { level: 1 });
      const compressed = Boolean(packed && packed.length + 32 < bytes.length * 0.88);
      const version = compressed ? 2 : 1, domain = block ? "gp-import-evidence-block" : "gp-import-payload";
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", block ? blockEncryption : encryption, iv);
      cipher.setAAD(Buffer.from(canonical([domain, version, keyId, context])));
      const ciphertext = Buffer.concat([cipher.update(compressed ? packed : bytes), cipher.final()]);
      return [`gp-import-${block ? "block-" : ""}v${version}`, keyId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
    } finally { bytes.fill(0); packed?.fill(0); }
  }
  function open(envelope, context, block) {
    active(); let bytes, packed;
    try {
      if (typeof envelope !== "string" || envelope.length > LIMITS.rowBytes * 9) throw new Error();
      const parts = envelope.split(":"), prefix = `gp-import-${block ? "block-" : ""}v`;
      const version = parts[0] === prefix + "1" ? 1 : parts[0] === prefix + "2" ? 2 : 0;
      if (parts.length !== 5 || !version || parts[1] !== keyId) throw new Error();
      const decode = value => { const decoded = Buffer.from(value, "base64"); if (decoded.toString("base64") !== value) throw new Error(); return decoded; };
      const iv = decode(parts[2]), tag = decode(parts[3]); if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = crypto.createDecipheriv("aes-256-gcm", block ? blockEncryption : encryption, iv);
      decipher.setAAD(Buffer.from(canonical([block ? "gp-import-evidence-block" : "gp-import-payload", version, keyId, context])));
      decipher.setAuthTag(tag);
      // Authenticate first; only authenticated bounded plaintext is decompressed.
      packed = Buffer.concat([decipher.update(decode(parts[4])), decipher.final()]);
      bytes = version === 2 ? zlib.inflateRawSync(packed, { maxOutputLength: LIMITS.rowBytes * 6 }) : packed;
      if (bytes.length > LIMITS.rowBytes * 6) throw new Error();
      return JSON.parse(bytes.toString("utf8"));
    } catch { fail(block ? "IMPORT_PROTECTED_BLOCK_INVALID" : "IMPORT_PROTECTED_PAYLOAD_INVALID"); }
    finally { bytes?.fill(0); packed?.fill(0); }
  }
  return Object.freeze({
    digest(value) { active(); return crypto.createHmac("sha256", index).update("gp-import-index:v1:").update(canonical(value)).digest("hex"); },
    seal: (value, context) => seal(value, context, false),
    open: (envelope, context) => open(envelope, context, false),
    sealBlock: (value, context) => seal(value, context, true),
    openBlock: (envelope, context) => open(envelope, context, true),
    destroy() { destroyed = true; encryption.fill(0); blockEncryption.fill(0); index.fill(0); },
  });
}
module.exports = { createDataImportProtection };
