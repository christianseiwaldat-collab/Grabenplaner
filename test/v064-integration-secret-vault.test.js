"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  SECRET_PREFIX,
  createIntegrationSecretVault,
} = require("../lib/integration-secret-vault");

const KEY_A = Buffer.alloc(32, 0x41);
const KEY_B = Buffer.alloc(32, 0x42);
const CONTEXT = {
  connectorId: "connector-17",
  field: "bearer-token",
  purpose: "payroll-delivery",
};

test("v0.64 Secret-Vault: AES-256-GCM speichert kein Klartextgeheimnis", async () => {
  const vault = createIntegrationSecretVault({ activeKeyId: "test-a", keys: { "test-a": KEY_A } });
  const plaintext = "sehr-geheimes-api-token-123";
  const sealed = vault.seal(plaintext, CONTEXT);

  assert.equal(sealed.startsWith(SECRET_PREFIX), true);
  assert.equal(sealed.includes(plaintext), false);
  assert.deepEqual(vault.inspect(sealed), { version: 1, keyId: "test-a", protected: true });
  assert.equal("open" in vault, false);
  assert.equal("decrypt" in vault, false);

  let digest = "";
  let exposedBuffer;
  const returned = await vault.useSecret(sealed, CONTEXT, async (secret) => {
    exposedBuffer = secret;
    digest = crypto.createHash("sha256").update(secret).digest("hex");
  });
  assert.equal(returned, undefined);
  assert.equal(digest, crypto.createHash("sha256").update(plaintext).digest("hex"));
  assert.ok(exposedBuffer.every((byte) => byte === 0), "temporärer Klartextpuffer muss nach Verwendung gelöscht sein");

  const consumerError = new Error("test transport failed");
  await assert.rejects(vault.useSecret(sealed, CONTEXT, async () => { throw consumerError; }), consumerError);
});

test("v0.64 Secret-Vault: AAD bindet ein Secret an Connector und Feld", async () => {
  const vault = createIntegrationSecretVault({ activeKeyId: "test-a", keys: { "test-a": KEY_A } });
  const sealed = vault.seal("token", CONTEXT);

  await assert.rejects(
    vault.useSecret(sealed, { ...CONTEXT, connectorId: "connector-18" }, async () => {}),
    { code: "INTEGRATION_SECRET_INTEGRITY_FAILED" },
  );
  await assert.rejects(
    vault.useSecret(sealed, { ...CONTEXT, field: "api-key" }, async () => {}),
    { code: "INTEGRATION_SECRET_INTEGRITY_FAILED" },
  );
});

test("v0.64 Secret-Vault: Manipulation und fehlender Schlüssel werden neutral abgelehnt", async () => {
  const vault = createIntegrationSecretVault({ activeKeyId: "test-a", keys: { "test-a": KEY_A } });
  const sealed = vault.seal("token", CONTEXT);
  const last = sealed.at(-1);
  const tampered = `${sealed.slice(0, -1)}${last === "A" ? "B" : "A"}`;

  await assert.rejects(vault.useSecret(tampered, CONTEXT, async () => {}), {
    code: "INTEGRATION_SECRET_INTEGRITY_FAILED",
  });

  const missingKeyVault = createIntegrationSecretVault({
    activeKeyId: "test-b",
    keys: { "test-b": KEY_B },
  });
  await assert.rejects(missingKeyVault.useSecret(sealed, CONTEXT, async () => {}), {
    code: "INTEGRATION_SECRET_KEY_UNAVAILABLE",
  });
});

test("v0.64 Secret-Vault: injizierbarer Resolver unterstützt Schlüsselrotation ohne Klartext-Rückgabe", async () => {
  const keys = new Map([["old", KEY_A], ["new", KEY_B]]);
  const oldVault = createIntegrationSecretVault({ activeKeyId: "old", resolveKey: (keyId) => keys.get(keyId) });
  const newVault = createIntegrationSecretVault({ activeKeyId: "new", resolveKey: (keyId) => keys.get(keyId) });
  const oldSealed = oldVault.seal("rotation-token", CONTEXT);
  const rotated = await newVault.reseal(oldSealed, CONTEXT);

  assert.equal(newVault.inspect(rotated).keyId, "new");
  assert.notEqual(rotated, oldSealed);
  let matches = false;
  await newVault.useSecret(rotated, CONTEXT, async (secret) => {
    matches = crypto.timingSafeEqual(secret, Buffer.from("rotation-token"));
  });
  assert.equal(matches, true);
});

test("v0.64 Secret-Vault: ungültige Kontexte, Schlüssel und Klartextformate scheitern geschlossen", async () => {
  assert.throws(() => createIntegrationSecretVault({ activeKeyId: "test", keys: { test: Buffer.alloc(31) } }), {
    code: "INTEGRATION_SECRET_KEY_INVALID",
  });
  const vault = createIntegrationSecretVault({ activeKeyId: "test-a", keys: { "test-a": KEY_A } });
  assert.throws(() => vault.seal("token", { connectorId: "" }), { code: "INTEGRATION_SECRET_CONTEXT_REQUIRED" });
  await assert.rejects(vault.useSecret("token-im-klartext", CONTEXT, async () => {}), {
    code: "INTEGRATION_SECRET_FORMAT_INVALID",
  });
  await assert.rejects(vault.useSecret(vault.seal("token", CONTEXT), CONTEXT), {
    code: "INTEGRATION_SECRET_CONSUMER_REQUIRED",
  });
});
