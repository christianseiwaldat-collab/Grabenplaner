"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const M = require("../lib/passkey-management"), P = require("../lib/passkey-protocol");
function fixture() {
  const state = { credentials: [], audits: [], rotations: 0, adopted: 0, epoch: 1, live: true, changeDuringProof: false };
  const subject = { id: crypto.randomUUID(), principalKind: "employee", principalId: "EX-USER", userHandle: "opaque", authRevision: 1 };
  const session = { id: crypto.randomUUID(), employeeNumber: "EX-USER", authenticatedAt: "2026-10-25T12:00:00.000Z", absoluteExpiresAt: "2026-10-25T20:00:00.000Z" };
  const current = () => {
    if (!state.live) throw P.failure();
    return { session, kind: "employee", principalId: "EX-USER", actorPasswordHash: "synthetic-hash", displayName: "Beispiel",
      loginName: "EX-USER", authorityHash: P.hash("epoch:" + state.epoch) };
  };
  const proof = () => ({ subject: { ...subject }, credential: { subjectId: subject.id, credentialId: "syntheticCredential", publicKey: "secret-material", label: "Test" } });
  const repositories = { passkeys: {
    available: async () => true, subjectForPrincipal: async () => subject, subjectById: async () => subject,
    listCredentials: async () => state.credentials, ensureSubject: async () => subject,
    registerCredential: async input => { const value = { id: crypto.randomUUID(), revision: 1, ...input }; state.credentials.push(value); return value; },
    revokeCredential: async input => { const value = state.credentials.find(row => row.id === input.id && row.subjectId === input.subjectId && row.revision === input.expectedRevision); if (!value || value.revokedAt) return null; value.revokedAt = input.now; return value; },
  }, organizationPersonnel: { insertAudit: async (...input) => state.audits.push(input) } };
  const protocol = { registrationOptions: async input => input, verifyRegistration: async () => {
    const value = proof(); if (state.changeDuringProof) state.epoch++; return value;
  } };
  const controller = M.createPasskeyManagement({ repositories, config: P.configuration("https://login.example.invalid"), protocol,
    contextFor: async () => current(), guard: request => { if (!request.csrf) throw P.failure("CSRF", 403); }, rateLimit: () => {},
    verifyPassword: async value => value === "synthetic-current-password", transact: async work => {
      const snapshot = structuredClone(state); try { return await work(repositories); } catch (error) { Object.assign(state, snapshot); throw error; }
    }, rotate: async (_request, _repos, value) => { state.rotations++; return { session: { ...value, id: crypto.randomUUID() } }; },
    adopt: async () => { state.adopted++; } });
  const request = { csrf: true, body: {}, query: {}, params: {} };
  return { controller, repositories, state, subject, request, session };
}
test("Passkey enrollment requires CSRF and the current personal password; account targets are typed", async () => {
  const f = fixture();
  await assert.rejects(f.controller.registrationOptions({ ...f.request, csrf: false }), { code: "CSRF" });
  f.request.body = { label: "Mein Gerät", currentPassword: "wrong" };
  await assert.rejects(f.controller.registrationOptions(f.request), { code: "PASSKEY_CURRENT_PASSWORD_REQUIRED" });
  f.request.body.currentPassword = "synthetic-current-password";
  const result = await f.controller.registrationOptions(f.request);
  assert.equal(result.subject.id, f.subject.id); assert.equal(result.name, "Mein Gerät");
  assert.notEqual(result.authorityHash, "synthetic-hash");
  f.request.body.accountId = "EX-OTHER";
  await assert.rejects(f.controller.registrationOptions(f.request), { code: "PASSKEY_TARGET_INVALID" });
  f.request.body = { label: "Test", currentPassword: "synthetic-current-password", subjectId: f.subject.id };
  await assert.rejects(f.controller.registrationOptions(f.request), { code: "PASSKEY_INPUT_INVALID" });
});
test("Registration rechecks authority after proof and atomically couples key, audit and session rotation", async () => {
  const f = fixture(); f.request.body = { challengeId: crypto.randomUUID(), response: {} }; f.state.changeDuringProof = true;
  await assert.rejects(f.controller.registrationVerify(f.request, {}), { code: "PASSKEY_CONTEXT_CHANGED" });
  assert.equal(f.state.credentials.length, 0); assert.equal(f.state.rotations, 0); assert.equal(f.state.adopted, 0);
  f.state.changeDuringProof = false;
  assert.deepEqual(await f.controller.registrationVerify(f.request, {}), { ok: true, sessionChanged: true });
  assert.equal(f.state.credentials.length, 1); assert.equal(f.state.audits.length, 1); assert.equal(f.state.adopted, 1);
});
test("Revocation is owner/revision-bound and never adopts a failed transaction", async () => {
  const f = fixture(), id = crypto.randomUUID(); f.state.credentials.push({ id, subjectId: f.subject.id, revision: 1 });
  f.request.params.id = id; f.request.body = { revision: 2, currentPassword: "synthetic-current-password" };
  await assert.rejects(f.controller.revoke(f.request, {}), { code: "PASSKEY_CONTEXT_CHANGED" });
  assert.equal(f.state.adopted, 0); f.request.body.revision = 1;
  assert.equal((await f.controller.revoke(f.request, {})).ok, true);
  assert.equal(f.state.adopted, 1);
  await assert.rejects(f.controller.revoke(f.request, {}), { code: "PASSKEY_CONTEXT_CHANGED" });
});
test("Credential listing exposes only management metadata; unavailable databases keep the password path", async () => {
  const f = fixture(); f.state.credentials.push({ id: crypto.randomUUID(), label: "Test", revision: 3, publicKey: "must-stay-server-side", credentialId: "must-stay-server-side", authorityHash: "private" });
  const result = await f.controller.list(f.request);
  assert.equal(result.credentials[0].label, "Test");
  assert(!JSON.stringify(result).includes("must-stay-server-side")); assert(!Object.hasOwn(result.credentials[0], "authorityHash"));
  f.repositories.passkeys.available = async () => false;
  assert.equal((await f.controller.status()).available, false);
  await assert.rejects(f.controller.list(f.request), { code: "PASSKEY_UNAVAILABLE" });
});
test("Credential metadata is withheld when authority changes while reading the list", async () => {
  const f = fixture(); f.repositories.passkeys.listCredentials = async () => { f.state.epoch++; return []; };
  await assert.rejects(f.controller.list(f.request), { code: "PASSKEY_CONTEXT_CHANGED" });
});
