"use strict";
const P = require("./passkey-protocol");

const publicCredential = value => ({ id: value.id, label: value.label, createdAt: value.createdAt,
  lastUsedAt: value.lastUsedAt, revision: value.revision, deviceType: value.deviceType, backedUp: value.backedUp });
function targetId(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw P.failure("PASSKEY_TARGET_INVALID", 400);
  return value;
}
function strictBody(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw P.failure("PASSKEY_INPUT_INVALID", 400);
  return body;
}
function contextBinding(context) {
  return { bindingHash: P.hash("gp-passkey-browser-v1:" + context.session.id),
    sessionHash: P.hash(JSON.stringify([context.session.id, context.session.authenticatedAt, context.session.absoluteExpiresAt])),
    authorityHash: context.authorityHash };
}
function assertContext(current, expected) {
  if (current.authorityHash !== expected.authorityHash || current.session.id !== expected.session.id
    || current.kind !== expected.kind || current.principalId !== expected.principalId) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
}

// Context and transaction callbacks are supplied by the application's existing
// authorization/session boundary. No proof returned by the client is trusted.
function createPasskeyManagement({ repositories, transact, config, contextFor, guard, rateLimit,
  verifyPassword, rotate, adopt, acceptPassword = async () => {}, now = () => new Date(), protocol: suppliedProtocol, enabled = () => true }) {
  const protocol = suppliedProtocol || P.createPasskeyProtocol({ repository: repositories.passkeys, config });
  async function ready() {
    if (!enabled() || !config || !await repositories.passkeys.available()) throw P.failure("PASSKEY_UNAVAILABLE", 503);
  }
  async function context(request, repos, accountId, operation = "register") {
    return contextFor(request, repos, { accountId, operation });
  }
  async function password(request, current, value) {
    rateLimit(request);
    if (typeof value !== "string" || !value || value.length > 512
      || !await verifyPassword(value, current.actorPasswordHash, request, current)) throw P.failure("PASSKEY_CURRENT_PASSWORD_REQUIRED", 403);
  }
  async function status() { return { available: Boolean(enabled() && config && await repositories.passkeys.available()), origin: config?.origin || null }; }
  async function list(request) {
    await ready();
    const accountId = targetId(request.query?.accountId), current = await context(request, repositories, accountId, "list");
    const subject = await repositories.passkeys.subjectForPrincipal({ kind: current.kind, id: current.principalId });
    const credentials = subject ? await repositories.passkeys.listCredentials({ subjectId: subject.id }) : [];
    assertContext(await context(request, repositories, accountId, "list"), current);
    return { available: true, target: { kind: current.kind, displayName: current.displayName, enrollmentAllowed: current.enrollmentAllowed !== false }, credentials: credentials.map(publicCredential) };
  }
  async function registrationOptions(request) {
    guard(request); await ready();
    const body = strictBody(request.body, ["label", "currentPassword", "accountId"]), accountId = targetId(body.accountId);
    const current = await context(request, repositories, accountId);
    await password(request, current, body.currentPassword);
    const fresh = await transact(async repos => {
      const fresh = await context(request, repos, accountId); assertContext(fresh, current);
      await acceptPassword(repos, fresh);
      const subject = await repos.passkeys.ensureSubject({ kind: fresh.kind, id: fresh.principalId, now: now().toISOString() });
      return { ...fresh, subject };
    });
    return protocol.registrationOptions({ subject: fresh.subject, displayName: fresh.displayName, loginName: fresh.loginName,
      ...contextBinding(fresh), name: P.label(body.label) });
  }
  async function registrationVerify(request, response) {
    guard(request); await ready();
    const body = strictBody(request.body, ["challengeId", "response", "accountId"]), accountId = targetId(body.accountId);
    const current = await context(request, repositories, accountId);
    const proof = await protocol.verifyRegistration({ challengeId: body.challengeId, response: body.response, ...contextBinding(current) });
    const result = await transact(async repos => {
      const fresh = await context(request, repos, accountId); assertContext(fresh, current);
      const subject = await repos.passkeys.subjectById(proof.subject.id);
      if (!P.sameSubject(subject, proof.subject) || subject.principalKind !== fresh.kind || subject.principalId !== fresh.principalId) throw P.failure();
      const saved = await repos.passkeys.registerCredential({ ...proof.credential, expectedAuthRevision: subject.authRevision, now: now().toISOString() });
      if (!saved) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
      await repos.organizationPersonnel.insertAudit(fresh.session.employeeNumber, "passkey.registered", "passkey", saved.id,
        JSON.stringify({ kind: fresh.kind, principalId: fresh.principalId }));
      return rotate(request, repos, fresh.session);
    });
    await adopt(request, response, result);
    return { ok: true, sessionChanged: true };
  }
  async function revoke(request, response) {
    guard(request); await ready();
    const body = strictBody(request.body, ["revision", "currentPassword", "accountId"]), accountId = targetId(body.accountId);
    const current = await context(request, repositories, accountId, "revoke");
    await password(request, current, body.currentPassword);
    const result = await transact(async repos => {
      const fresh = await context(request, repos, accountId, "revoke"); assertContext(fresh, current);
      await acceptPassword(repos, fresh);
      const subject = await repos.passkeys.subjectForPrincipal({ kind: fresh.kind, id: fresh.principalId });
      if (!subject) throw P.failure();
      const saved = await repos.passkeys.revokeCredential({ id: request.params.id, subjectId: subject.id,
        expectedRevision: body.revision, now: now().toISOString() });
      if (!saved) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
      await repos.organizationPersonnel.insertAudit(fresh.session.employeeNumber, "passkey.revoked", "passkey", saved.id,
        JSON.stringify({ kind: fresh.kind, principalId: fresh.principalId }));
      return rotate(request, repos, fresh.session);
    });
    await adopt(request, response, result);
    return { ok: true, sessionChanged: true };
  }
  return { status, list, registrationOptions, registrationVerify, revoke, protocol };
}
function registerPasskeyManagementRoutes(app, controller) {
  const prefix = "/api/portal/v1/passkeys";
  app.get(prefix + "/status", async (_request, response) => { response.setHeader("Cache-Control", "no-store"); response.json(await controller.status()); });
  for (const [method, suffix, handler] of [["get", "/credentials", controller.list], ["post", "/register/options", controller.registrationOptions],
    ["post", "/register/verify", controller.registrationVerify], ["post", "/credentials/:id/revoke", controller.revoke]]) {
    app[method](prefix + suffix, async (request, response) => {
      response.setHeader("Cache-Control", "no-store"); response.json(await handler(request, response));
    });
  }
}
module.exports = { createPasskeyManagement, registerPasskeyManagementRoutes, contextBinding, assertContext, strictBody, targetId, publicCredential };
