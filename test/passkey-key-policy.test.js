"use strict";

// Synthetic fmt:none ceremonies and genuine signatures exercise the maintained
// WebAuthn verifier. Only persistence is in memory; no private key is serialized.
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { isoCBOR } = require("@simplewebauthn/server/helpers");
const P = require("../lib/passkey-protocol");
const config = P.configuration("https://login.example.invalid"), encode = bytes => Buffer.from(bytes).toString("base64url");
const decode = text => Uint8Array.from(Buffer.from(text, "base64url"));

function material({ type = "ec", bits = 2048, exponent = 65537, curve = "prime256v1", algorithm = -7, coseCurve = 1 } = {}) {
  const pair = crypto.generateKeyPairSync(type, type === "rsa" ? { modulusLength: bits, publicExponent: exponent } : { namedCurve: curve });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const cose = type === "rsa"
    ? new Map([[1, 3], [3, algorithm], [-1, decode(jwk.n)], [-2, decode(jwk.e)]])
    : new Map([[1, 2], [3, algorithm], [-1, coseCurve], [-2, decode(jwk.x)], [-3, decode(jwk.y)]]);
  return { cose, privateKey: pair.privateKey };
}

function fixture(key) {
  const subject = { id: crypto.randomUUID(), principalKind: "employee", principalId: "SYNTHETIC-ONLY",
    userHandle: crypto.randomBytes(32).toString("base64url"), authRevision: 1 };
  const id = crypto.randomBytes(32), challenges = new Map();
  let credential = null;
  const repository = {
    available: async () => true, purgeChallenges: async () => 0, listCredentials: async () => credential ? [credential] : [],
    issueChallenge: async value => { challenges.set(value.id, structuredClone(value)); return value; },
    consumeChallenge: async ({ id, purpose, bindingHash, now }) => {
      const value = challenges.get(id);
      if (!value || value.consumedAt || value.purpose !== purpose || value.bindingHash !== bindingHash || value.expiresAt <= now) return null;
      value.consumedAt = now; return structuredClone(value);
    },
    subjectById: async value => value === subject.id ? structuredClone(subject) : null,
    credential: async value => credential?.credentialId === value ? structuredClone(credential) : null,
  };
  const protocol = P.createPasskeyProtocol({ repository, config });
  const binding = { bindingHash: P.hash("synthetic browser"), sessionHash: P.hash("synthetic session"), authorityHash: P.hash("synthetic authority") };
  const publicKey = () => Buffer.from(isoCBOR.encode(key.cose));
  const install = () => { credential = { id: crypto.randomUUID(), subjectId: subject.id, credentialId: encode(id), publicKey: encode(publicKey()),
    counter: 0, revision: 1, authorityHash: P.subjectBinding(subject), deviceType: "singleDevice", backedUp: false, transports: ["internal"], revokedAt: null }; };
  async function registration() {
    const issued = await protocol.registrationOptions({ ...binding, subject, displayName: "Synthetic key-policy test", loginName: subject.principalId, name: "Synthetic key" });
    const size = Buffer.alloc(2); size.writeUInt16BE(id.length);
    const authData = Buffer.concat([crypto.createHash("sha256").update(config.rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4),
      Buffer.alloc(16), size, id, publicKey()]);
    const clientDataJSON = encode(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: issued.options.challenge, origin: config.origin, crossOrigin: false })));
    return { ...binding, challengeId: issued.challengeId, response: { id: encode(id), rawId: encode(id), type: "public-key", response: {
      clientDataJSON, attestationObject: encode(isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", Uint8Array.from(authData)]]))), transports: ["internal"],
    } } };
  }
  async function authentication() {
    const issued = await protocol.authenticationOptions({ bindingHash: binding.bindingHash });
    const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: issued.options.challenge, origin: config.origin, crossOrigin: false }));
    const counter = Buffer.alloc(4); counter.writeUInt32BE(1);
    const authData = Buffer.concat([crypto.createHash("sha256").update(config.rpId).digest(), Buffer.from([0x05]), counter]);
    const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(client).digest()]), key.privateKey);
    return { bindingHash: binding.bindingHash, challengeId: issued.challengeId, response: { id: encode(id), rawId: encode(id), type: "public-key", response: {
      clientDataJSON: encode(client), authenticatorData: encode(authData), signature: encode(signature), userHandle: subject.userHandle,
    } } };
  }
  return { protocol, challenges, subject, install, registration, authentication };
}

test("real RSA-2048/RS256 and P-256/ES256 registration and signed authentication remain compatible", async () => {
  for (const key of [material({ type: "rsa", algorithm: -257 }), material({ type: "rsa", exponent: 3, algorithm: -257 }), material()]) {
    const f = fixture(key), registration = await f.registration();
    const accepted = await f.protocol.verifyRegistration(registration);
    assert.equal(accepted.credential.credentialId, registration.response.id);
    f.install();
    const request = await f.authentication(), proof = await f.protocol.verifyAuthentication(request);
    assert.equal(proof.newCounter, 1); assert.equal(proof.subject.id, f.subject.id);
    await assert.rejects(f.protocol.verifyAuthentication(request), { code: "PASSKEY_CHALLENGE_EXPIRED" });
  }
});

test("weak RSA and real EC/algorithm mismatches fail enrollment and previously stored-key authentication, burning both nonces", async () => {
  const cases = [
    ["RSA-1024/RS256", material({ type: "rsa", bits: 1024, algorithm: -257 })],
    ["P-384 mislabeled ES256", material({ curve: "secp384r1", coseCurve: 2 })],
    ["P-256 mislabeled RS256", material({ algorithm: -257 })],
  ];
  for (const [name, key] of cases) {
    const f = fixture(key), registration = await f.registration();
    await assert.rejects(f.protocol.verifyRegistration(registration), { code: "PASSKEY_VERIFICATION_FAILED" }, name);
    assert(f.challenges.get(registration.challengeId).consumedAt, name);
    await assert.rejects(f.protocol.verifyRegistration(registration), { code: "PASSKEY_CHALLENGE_EXPIRED" }, name);
    // Historical/imported records must not bypass the same policy on use.
    f.install();
    const request = await f.authentication();
    await assert.rejects(f.protocol.verifyAuthentication(request), { code: "PASSKEY_VERIFICATION_FAILED" }, name);
    assert(f.challenges.get(request.challengeId).consumedAt, name);
    await assert.rejects(f.protocol.verifyAuthentication(request), { code: "PASSKEY_CHALLENGE_EXPIRED" }, name);
  }
});

test("malformed or private key material is rejected even for none-attestation registrations", async () => {
  const ec = material(), rsa = material({ type: "rsa", algorithm: -257 });
  const cases = [
    ["invalid EC point", ec, map => { map.set(-2, new Uint8Array(32)); map.set(-3, new Uint8Array(32)); }],
    ["short EC coordinate", ec, map => map.set(-2, new Uint8Array(31))],
    ["EC private component", ec, map => map.set(-4, Uint8Array.of(7))],
    ["zero RSA modulus", rsa, map => map.set(-1, new Uint8Array(256))],
    ["leading-zero RSA modulus", rsa, map => map.set(-1, Uint8Array.from([0, ...map.get(-1)]))],
    ["even RSA modulus", rsa, map => { const n = map.get(-1); n[n.length - 1] &= 254; }],
    ["actual RSA modulus below 2048 bits", rsa, map => { const n = map.get(-1); n[0] = (n[0] & 63) | 64; }],
    ["RSA modulus above 8192 bits", rsa, map => { const n = new Uint8Array(1025); n[0] = 128; n[n.length - 1] = 1; map.set(-1, n); }],
    ["RSA exponent empty", rsa, map => map.set(-2, new Uint8Array())],
    ["RSA exponent one", rsa, map => map.set(-2, Uint8Array.of(1))],
    ["RSA exponent even", rsa, map => map.set(-2, Uint8Array.of(2))],
    ["RSA exponent noncanonical", rsa, map => map.set(-2, Uint8Array.of(0, 3))],
    ["RSA exponent oversized", rsa, map => map.set(-2, Uint8Array.of(1, 0, 0, 0, 1))],
    ["RSA private component", rsa, map => map.set(-3, Uint8Array.of(7))],
    ["unrequested algorithm", ec, map => map.set(3, -35)],
  ];
  for (const [name, base, mutate] of cases) {
    const cose = new Map([...base.cose].map(([label, value]) => [label, value instanceof Uint8Array ? value.slice() : value]));
    mutate(cose);
    const f = fixture({ ...base, cose }), request = await f.registration();
    await assert.rejects(f.protocol.verifyRegistration(request), { code: "PASSKEY_VERIFICATION_FAILED" }, name);
    assert(f.challenges.get(request.challengeId).consumedAt, name);
    await assert.rejects(f.protocol.verifyRegistration(request), { code: "PASSKEY_CHALLENGE_EXPIRED" }, name);
  }
});
