"use strict";
const P = require("./passkey-protocol");
const { strictBody } = require("./passkey-management");

function accountBinding(user) {
  return P.hash(JSON.stringify([user.employee_number, user.account_id || null, user.password_hash,
    user.password_policy_version, user.must_change_password, user.role, user.active, user.employee_active, user.locked_until]));
}
async function finalizeCredentialUse(repositories, proof, now = new Date()) {
  const subject = await repositories.passkeys.subjectById(proof.subject.id);
  if (!P.sameSubject(subject, proof.subject)) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
  const credential = await repositories.passkeys.updateCredentialUse({ id: proof.credential.id, subjectId: subject.id,
    expectedAuthRevision: subject.authRevision, expectedRevision: proof.credential.revision,
    expectedCounter: proof.credential.counter, expectedAuthorityHash: proof.credential.authorityHash,
    newCounter: proof.newCounter, backedUp: proof.backedUp, now: now.toISOString() });
  if (!credential) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
  return credential;
}
function reauthenticationBodyValid(body, otherKeys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const key = Object.hasOwn(body, "passkey") ? "passkey" : "currentPassword";
  if (Object.keys(body).sort().join("\0") !== [...otherKeys, key].sort().join("\0")) return false;
  if (key === "currentPassword") return typeof body.currentPassword === "string" && body.currentPassword.length > 0 && body.currentPassword.length <= 512;
  const proof = body.passkey;
  return Boolean(proof && typeof proof === "object" && !Array.isArray(proof)
    && Object.keys(proof).sort().join(",") === "challengeId,response"
    && typeof proof.challengeId === "string" && /^[a-f0-9-]{36}$/.test(proof.challengeId)
    && proof.response && typeof proof.response === "object" && !Array.isArray(proof.response));
}
function createPasskeyAuthentication({ repositories, protocol, guard, browserBinding, accountFor, assertAccount,
  transact, createSession, adopt, responseFor, failed }) {
  async function options(request, response) {
    guard(request, { anonymous: true }); strictBody(request.body, []);
    const bindingHash = browserBinding(request, response, true);
    return protocol.authenticationOptions({ bindingHash });
  }
  async function verify(request, response) {
    guard(request, { anonymous: true });
    const body = strictBody(request.body, ["challengeId", "response"]);
    let proof, transition;
    try {
      proof = await protocol.verifyAuthentication({ challengeId: body.challengeId, response: body.response,
        bindingHash: browserBinding(request, response, false) });
      const user = await accountFor(repositories, proof.subject); assertAccount(user);
      transition = await transact(async repos => {
        const current = await accountFor(repos, proof.subject); assertAccount(current);
        if (accountBinding(current) !== accountBinding(user)) throw P.failure("PASSKEY_CONTEXT_CHANGED", 409);
        await finalizeCredentialUse(repos, proof);
        const transition = await createSession(request, repos, proof.subject, current);
        await repos.organizationPersonnel.insertAudit(proof.subject.principalKind === "organization"
          ? `account:${proof.subject.principalId}` : proof.subject.principalId,
        "passkey.login.accepted", "passkey", proof.credential.id);
        return transition;
      });
    } catch (error) { await failed(request); throw error; }
    await adopt(request, response, transition);
    return responseFor(request, transition);
  }
  return { options, verify };
}
function registerPasskeyAuthenticationRoutes(app, controller) {
  for (const [suffix, handler] of [["options", controller.options], ["verify", controller.verify]]) {
    app.post("/api/portal/v1/auth/passkeys/" + suffix, async (request, response) => {
      response.setHeader("Cache-Control", "no-store"); response.json(await handler(request, response));
    });
  }
}
module.exports = { accountBinding, finalizeCredentialUse, reauthenticationBodyValid, createPasskeyAuthentication, registerPasskeyAuthenticationRoutes };
