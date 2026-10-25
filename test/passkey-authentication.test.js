"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const A = require("../lib/passkey-authentication"), P = require("../lib/passkey-protocol");
function fixture() {
  const subject = { id: crypto.randomUUID(), principalKind: "employee", principalId: "EX-USER", userHandle: "opaque", authRevision: 1 };
  const state = { user: { employee_number: "EX-USER", password_hash: "synthetic-hash", password_policy_version: 1, active: true, employee_active: true },
    counter: 0, revision: 1, subject, revoked: false, sessions: 0, audits: 0, adopted: 0, failAudit: false, changeBeforeTransaction: null };
  const proof = { subject: structuredClone(subject), credential: { id: crypto.randomUUID(), subjectId: subject.id, revision: 1, counter: 0, authorityHash: P.subjectBinding(subject) }, newCounter: 0, backedUp: true };
  const repositories = { passkeys: { subjectById: async () => state.subject,
    updateCredentialUse: async input => {
      if (state.revoked || state.revision !== input.expectedRevision || state.counter !== input.expectedCounter) return null;
      state.revision++; state.counter = input.newCounter; return { id: proof.credential.id };
    } }, organizationPersonnel: { insertAudit: async () => { if (state.failAudit) throw Error("synthetic audit failure"); state.audits++; } } };
  let tail = Promise.resolve();
  const transact = async work => {
    const previous = tail; let release; tail = new Promise(done => { release = done; }); await previous;
    state.changeBeforeTransaction?.(); state.changeBeforeTransaction = null;
    const snapshot = structuredClone(state);
    try { return await work(repositories); } catch (error) { const adopted = state.adopted; Object.assign(state, snapshot, { adopted }); throw error; } finally { release(); }
  };
  const controller = A.createPasskeyAuthentication({ repositories, protocol: { authenticationOptions: async input => input,
    verifyAuthentication: async () => structuredClone(proof) }, guard: () => {}, browserBinding: () => P.hash("browser"),
    accountFor: async () => structuredClone(state.user), assertAccount: user => {
      if (!user.active || !user.employee_active || user.must_change_password || user.password_policy_version !== 1 || user.locked_until) throw P.failure();
    }, transact, createSession: async () => { state.sessions++; return { id: crypto.randomUUID() }; },
    adopt: async () => { state.adopted++; }, responseFor: () => ({ ok: true }), failed: async () => {} });
  return { state, proof, repositories, controller, request: { body: { challengeId: crypto.randomUUID(), response: {} } } };
}
test("Passkey login rechecks fresh account state before CAS and never adopts a rejected transaction", async () => {
  for (const fields of [{ active: false }, { employee_active: false }, { must_change_password: true },
    { password_policy_version: 0 }, { locked_until: "future" }, { password_hash: "new-password" }]) {
    const f = fixture(); f.state.changeBeforeTransaction = () => Object.assign(f.state.user, fields);
    await assert.rejects(f.controller.verify(f.request, {}));
    assert.equal(f.state.adopted, 0); assert.equal(f.state.sessions, 0); assert.equal(f.state.revision, 1);
  }
});
test("Subject epoch and credential revocation or revision changes prevent stale passkey login", async () => {
  for (const mutate of [state => { state.subject.authRevision++; }, state => { state.revoked = true; }, state => { state.revision++; }]) {
    const f = fixture(); f.state.changeBeforeTransaction = () => mutate(f.state);
    await assert.rejects(f.controller.verify(f.request, {}), { code: "PASSKEY_CONTEXT_CHANGED" });
    assert.equal(f.state.adopted, 0); assert.equal(f.state.sessions, 0);
  }
});
test("Parallel zero-counter proofs have exactly one committed session and one credential revision winner", async () => {
  const f = fixture(); const result = await Promise.allSettled([f.controller.verify(f.request, {}), f.controller.verify(f.request, {})]);
  assert.equal(result.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(f.state.sessions, 1); assert.equal(f.state.adopted, 1); assert.equal(f.state.audits, 1); assert.equal(f.state.revision, 2);
});
test("An audit failure rolls credential and session mutations back without browser credentials", async () => {
  const f = fixture(); f.state.failAudit = true;
  await assert.rejects(f.controller.verify(f.request, {}), /synthetic audit failure/);
  assert.equal(f.state.sessions, 0); assert.equal(f.state.revision, 1); assert.equal(f.state.adopted, 0);
});
test("Reauthentication input accepts one bounded password or one server-verifiable passkey with exact operation fields", () => {
  const base = { confirmation: "EXPLICIT", folderLabel: "Test" }, passkey = { challengeId: crypto.randomUUID(), response: {} };
  assert(A.reauthenticationBodyValid({ ...base, currentPassword: "current" }, ["confirmation", "folderLabel"]));
  assert(A.reauthenticationBodyValid({ ...base, passkey }, ["confirmation", "folderLabel"]));
  for (const value of [{ ...base, passkey, currentPassword: "" }, { ...base, passkey, trusted: true },
    { ...base, passkey: { ...passkey, verified: true } }, { ...base, currentPassword: "a".repeat(513) }, { ...base, currentPassword: "" }]) {
    assert.equal(A.reauthenticationBodyValid(value, ["confirmation", "folderLabel"]), false);
  }
});
