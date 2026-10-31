"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const P = require("../lib/passkey-protocol");
const config = P.configuration("https://login.example.invalid");
const subject = () => ({ id: crypto.randomUUID(), principalKind: "employee", principalId: "SYNTHETIC-ONLY",
  userHandle: crypto.randomBytes(32).toString("base64url"), authRevision: 1 });

function fixture() {
  let at = Date.parse("2026-10-25T12:00:00.000Z");
  const owner = subject(), challenges = new Map(), credentials = new Map();
  const repository = {
    available: async () => true, listCredentials: async () => [...credentials.values()].filter(item => !item.revokedAt),
    purgeChallenges: async ({ now }) => { for (const [id, value] of challenges) if (value.expiresAt <= now) challenges.delete(id); },
    issueChallenge: async value => { challenges.set(value.id, structuredClone(value)); return value; },
    consumeChallenge: async ({ id, purpose, bindingHash, now }) => {
      const value = challenges.get(id);
      if (!value || value.consumedAt || value.purpose !== purpose || value.bindingHash !== bindingHash || value.expiresAt <= now
        || value.subjectId && value.expectedAuthRevision !== owner.authRevision) return null;
      value.consumedAt = now; return structuredClone(value);
    },
    subjectById: async id => id === owner.id ? structuredClone(owner) : null,
    credential: async id => structuredClone(credentials.get(id) || null),
  };
  const binding = { bindingHash: P.hash("synthetic-browser"), sessionHash: P.hash("synthetic-session"), authorityHash: P.hash("synthetic-account") };
  const protocol = P.createPasskeyProtocol({ repository, config, now: () => at });
  return { protocol, repository, owner, credentials, challenges, binding, advance: ms => { at += ms; } };
}

test("Passkey RP is an exact configured HTTPS origin, never a parent/header/IP-derived scope", () => {
  assert.deepEqual(config, { origin: "https://login.example.invalid", rpId: "login.example.invalid", rpName: "Grabenplaner" });
  for (const origin of ["http://login.example.invalid", "https://user:secret@login.example.invalid", "https://login.example.invalid/path",
    "https://login.example.invalid/?x=1", "https://127.0.0.1", "https://localhost", "https://login.example.invalid/"]) assert.equal(P.configuration(origin), null, origin);
  assert.equal(config.rpId.includes("SYNTHETIC-ONLY"), false);
});

test("Passkey registration uses a random opaque handle, required resident key and local verification with no attestation", async () => {
  const f = fixture();
  const result = await f.protocol.registrationOptions({ ...f.binding, subject: f.owner, name: "Mein Sicherheitsschlüssel", loginName: "EX-USER", displayName: "Beispiel" });
  assert.equal(result.options.user.id, f.owner.userHandle);
  assert.equal(Buffer.from(result.options.user.id, "base64url").length, 32);
  assert.equal(result.options.authenticatorSelection.residentKey, "required");
  assert.equal(result.options.authenticatorSelection.userVerification, "required");
  assert.equal(result.options.attestation, "none");
  assert.deepEqual(result.options.pubKeyCredParams.map(item => item.alg), [-7, -257]);
  const challenge = f.challenges.get(result.challengeId);
  assert.equal(challenge.subjectId, f.owner.id); assert.equal(challenge.expectedAuthRevision, 1);
  assert.equal(challenge.origin, config.origin); assert.equal(challenge.expiresAt, "2026-10-25T12:02:00.000Z");
});

test("Malformed cryptographic registration burns its challenge; parallel replay can never verify twice", async () => {
  const f = fixture();
  const result = await f.protocol.registrationOptions({ ...f.binding, subject: f.owner, name: "Beispiel", loginName: "EX" });
  const request = { ...f.binding, challengeId: result.challengeId, response: {} };
  const attempts = await Promise.allSettled([f.protocol.verifyRegistration(request), f.protocol.verifyRegistration(request)]);
  assert(attempts.every(item => item.status === "rejected"));
  assert.equal(attempts.filter(item => item.reason.code === "PASSKEY_CHALLENGE_EXPIRED").length, 1);
  assert(f.challenges.get(result.challengeId).consumedAt);
});

test("Browser, purpose, session, principal epoch and expiry bindings reject swapped ceremonies", async () => {
  for (const variant of ["browser", "purpose", "session", "authority", "epoch", "expiry"]) {
    const f = fixture();
    const result = await f.protocol.registrationOptions({ ...f.binding, subject: f.owner, name: "Beispiel", loginName: "EX" });
    const input = { ...f.binding, challengeId: result.challengeId, response: {} };
    if (variant === "browser") input.bindingHash = P.hash("another-browser");
    if (variant === "purpose") f.challenges.get(result.challengeId).purpose = "authenticate";
    if (variant === "session") input.sessionHash = P.hash("another-session");
    if (variant === "authority") input.authorityHash = P.hash("another-authority");
    if (variant === "epoch") f.owner.authRevision++;
    if (variant === "expiry") f.advance(P.TTL_MS);
    await assert.rejects(f.protocol.verifyRegistration(input), error => /^PASSKEY_/.test(error.code), variant);
  }
});

test("Registration capacity, invalid labels and missing database/configuration fail closed", async () => {
  const f = fixture();
  for (const name of [null, 15, "", "a".repeat(81), "bad\nlabel"]) {
    await assert.rejects(f.protocol.registrationOptions({ ...f.binding, subject: f.owner, name, loginName: "EX" }), { code: "PASSKEY_LABEL_INVALID" });
  }
  for (let index = 0; index < 10; index++) f.credentials.set(String(index), {});
  await assert.rejects(f.protocol.registrationOptions({ ...f.binding, subject: f.owner, name: "Beispiel", loginName: "EX" }), { code: "PASSKEY_CREDENTIAL_LIMIT" });
  f.repository.available = async () => false;
  await assert.rejects(f.protocol.authenticationOptions({ bindingHash: f.binding.bindingHash }), { code: "PASSKEY_UNAVAILABLE" });
  const missing = P.createPasskeyProtocol({ repository: f.repository, config: null });
  await assert.rejects(missing.authenticationOptions({ bindingHash: f.binding.bindingHash }), { code: "PASSKEY_UNAVAILABLE" });
});

test("Registration rejects embedded-frame client data before invoking the verifier", async () => {
  for (const fields of [{ crossOrigin: true }, { crossOrigin: "false" }, { topOrigin: config.origin }]) {
    const f = fixture(); let calls = 0;
    const protocol = P.createPasskeyProtocol({ repository: f.repository, config,
      library: async () => ({ ...(await import("@simplewebauthn/server")), verifyRegistrationResponse: () => { calls++; throw Error("must not run"); } }) });
    const options = await protocol.registrationOptions({ ...f.binding, subject: f.owner, name: "Test", loginName: "EX" });
    const id = crypto.randomBytes(32).toString("base64url");
    await assert.rejects(protocol.verifyRegistration({ ...f.binding, challengeId: options.challengeId,
      response: { id, rawId: id, type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({
        type: "webauthn.create", challenge: options.options.challenge, origin: config.origin, ...fields,
      })).toString("base64url") } } }), { code: "PASSKEY_VERIFICATION_FAILED" });
    assert.equal(calls, 0);
  }
});
