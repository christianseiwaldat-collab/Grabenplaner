"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const TTL_MS = 120000;
const ALGORITHMS = Object.freeze([-7, -257]);
const PURPOSES = Object.freeze(["register", "authenticate", "reauthenticate"]);
const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const base64 = (value, maximum = 16384) => typeof value === "string" && value.length > 0 && value.length <= maximum
  && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
let libraryPromise;
const defaultLibrary = () => libraryPromise ||= import("@simplewebauthn/server");
let helpersPromise;

async function assertCredentialKeyPolicy(publicKey) {
  try {
    if (!(publicKey instanceof Uint8Array) || !publicKey.length || publicKey.length > 4096) throw failure();
    const { decodeCredentialPublicKey } = await (helpersPromise ||= import("@simplewebauthn/server/helpers"));
    const key = decodeCredentialPublicKey(publicKey);
    const bytes = (value, minimum, maximum = minimum) => {
      if (!(value instanceof Uint8Array) || value.length < minimum || value.length > maximum) throw failure();
      return Buffer.from(value);
    };
    let jwk;
    if (key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1) {
      if ([...key.keys()].some(label => typeof label === "number" && label < -3)) throw failure();
      jwk = { kty: "EC", crv: "P-256", x: bytes(key.get(-2), 32).toString("base64url"),
        y: bytes(key.get(-3), 32).toString("base64url") };
    } else if (key.get(1) === 3 && key.get(3) === -257) {
      const modulus = bytes(key.get(-1), 256, 1024), exponent = bytes(key.get(-2), 1, 4);
      if (!modulus[0] || !(modulus.at(-1) & 1) || !exponent[0]
        || [...key.keys()].some(label => typeof label === "number" && label < -2)) throw failure();
      const numericExponent = BigInt("0x" + exponent.toString("hex"));
      if (numericExponent < 3n || numericExponent % 2n !== 1n) throw failure();
      jwk = { kty: "RSA", n: modulus.toString("base64url"), e: exponent.toString("base64url") };
    } else throw failure();
    // This is key-policy validation, not a replacement signature verifier.
    // The maintained WebAuthn library verifies every ceremony. Node validates
    // the EC point and reports the actual RSA modulus length independently.
    const imported = crypto.createPublicKey({ key: jwk, format: "jwk" });
    if (jwk.kty === "EC") {
      if (imported.asymmetricKeyType !== "ec" || imported.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw failure();
    } else if (imported.asymmetricKeyType !== "rsa" || !Number.isSafeInteger(imported.asymmetricKeyDetails?.modulusLength)
      || imported.asymmetricKeyDetails.modulusLength < 2048
      || imported.asymmetricKeyDetails?.modulusLength > 8192) throw failure();
  } catch { throw failure(); }
}

function failure(code = "PASSKEY_VERIFICATION_FAILED", status = 401) {
  return Object.assign(new Error(code === "PASSKEY_UNAVAILABLE"
    ? "Passkeys sind für diese GP-Adresse noch nicht verfügbar. Bitte mit Passwort anmelden."
    : code === "PASSKEY_CHALLENGE_EXPIRED"
      ? "Die Passkey-Anfrage ist abgelaufen oder wurde bereits verwendet. Bitte erneut beginnen."
      : "Die Passkey-Bestätigung konnte nicht angenommen werden. Bitte erneut beginnen."), { code, status });
}

function configuration(origin) {
  try {
    const url = new URL(origin);
    // Never derive an RP from request headers, accept a parent domain implicitly,
    // or silently allow another origin. Moving the login host is an explicit migration.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/" || net.isIP(url.hostname) || !url.hostname.includes(".")
      || url.origin !== origin) return null;
    return Object.freeze({ origin: url.origin, rpId: url.hostname, rpName: "Grabenplaner" });
  } catch { return null; }
}

function label(value) {
  if (typeof value !== "string" || !value.isWellFormed()) throw failure("PASSKEY_LABEL_INVALID", 400);
  const result = value.trim();
  if (!result || result.length > 80 || /[\x00-\x1f\x7f]/.test(result)) throw failure("PASSKEY_LABEL_INVALID", 400);
  return result;
}

function responseValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "public-key"
    || !base64(value.id, 2048) || value.id !== value.rawId || !value.response
    || typeof value.response !== "object" || Array.isArray(value.response)) throw failure();
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure(); }
  if (Buffer.byteLength(encoded) > 65536) throw failure("PASSKEY_RESPONSE_TOO_LARGE", 413);
  // GP does not support authentication from cross-origin embedded frames.
  // Enforce that policy explicitly; keep all WebAuthn cryptography in the library.
  if (!base64(value.response.clientDataJSON, 22000)) throw failure();
  try {
    const bytes = Buffer.from(value.response.clientDataJSON, "base64url");
    if (bytes.length > 16384) throw failure();
    const client = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!client || typeof client !== "object" || Array.isArray(client)
      || (Object.hasOwn(client, "crossOrigin") && client.crossOrigin !== false)
      || Object.hasOwn(client, "topOrigin")) throw failure();
  } catch { throw failure(); }
  return value;
}

function subjectBinding(subject) {
  return hash(JSON.stringify(["gp-passkey-subject-v1", subject.id, subject.principalKind, subject.principalId, subject.authRevision]));
}

function sameSubject(left, right) {
  return left && right && left.id === right.id && left.principalKind === right.principalKind && left.principalId === right.principalId
    && left.userHandle === right.userHandle && left.authRevision === right.authRevision;
}

// Only protocol work lives here. Authentication/credential mutations are finalized
// by a caller-owned application transaction which rechecks account and session state.
// Consuming a challenge is a separate atomic write: even invalid signatures burn it.
function createPasskeyProtocol({ repository, config, library = defaultLibrary, now = Date.now } = {}) {
  if (!repository) throw new TypeError("A passkey repository is required");
  async function ready() {
    if (!config || !await repository.available()) throw failure("PASSKEY_UNAVAILABLE", 503);
  }
  async function issue({ purpose, subject = null, bindingHash, sessionHash = null, authorityHash = null, payload = {} }, options) {
    if (!PURPOSES.includes(purpose) || !hex(bindingHash) || (purpose !== "authenticate"
      && (!subject || !hex(sessionHash) || !hex(authorityHash)))) throw failure("PASSKEY_CONTEXT_INVALID", 400);
    const createdAt = new Date(now()).toISOString(), expiresAt = new Date(now() + TTL_MS).toISOString();
    await repository.purgeChallenges({ now: createdAt, limit: 200 });
    const id = crypto.randomUUID();
    const created = await repository.issueChallenge({ id, purpose, subjectId: subject?.id || null,
      expectedAuthRevision: subject?.authRevision ?? null, challenge: options.challenge,
      bindingHash, sessionHash, authorityHash, rpId: config.rpId, origin: config.origin,
      payload, createdAt, expiresAt });
    if (!created) throw failure("PASSKEY_RATE_LIMITED", 429);
    return { challengeId: id, options, expiresAt };
  }
  async function consume({ challengeId, purpose, bindingHash, sessionHash = null, authorityHash = null }) {
    await ready();
    if (typeof challengeId !== "string" || !/^[a-f0-9-]{36}$/.test(challengeId)
      || !PURPOSES.includes(purpose) || !hex(bindingHash)) throw failure();
    const challenge = await repository.consumeChallenge({ id: challengeId, purpose, bindingHash, now: new Date(now()).toISOString() });
    if (!challenge) throw failure("PASSKEY_CHALLENGE_EXPIRED");
    if (challenge.rpId !== config.rpId || challenge.origin !== config.origin
      || challenge.sessionHash !== sessionHash || challenge.authorityHash !== authorityHash) throw failure();
    return challenge;
  }
  async function registrationOptions({ subject, displayName, loginName, bindingHash, sessionHash, authorityHash, name }) {
    await ready();
    if (!base64(subject?.userHandle, 86) || Buffer.from(subject.userHandle, "base64url").length !== 32) throw failure();
    const active = await repository.listCredentials({ subjectId: subject.id });
    if (active.length >= 10) throw failure("PASSKEY_CREDENTIAL_LIMIT", 409);
    const options = await (await library()).generateRegistrationOptions({
      rpName: config.rpName, rpID: config.rpId, userID: Uint8Array.from(Buffer.from(subject.userHandle, "base64url")),
      userName: String(loginName), userDisplayName: String(displayName || loginName),
      challenge: crypto.randomBytes(32), timeout: TTL_MS, attestationType: "none", supportedAlgorithmIDs: [...ALGORITHMS],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: active.map(credential => ({ id: credential.credentialId, transports: credential.transports })),
    });
    return issue({ purpose: "register", subject, bindingHash, sessionHash, authorityHash, payload: { label: label(name) } }, options);
  }
  async function authenticationOptions({ purpose = "authenticate", subject = null, bindingHash, sessionHash = null, authorityHash = null, payload = {} }) {
    await ready();
    if (!["authenticate", "reauthenticate"].includes(purpose)) throw failure();
    const options = await (await library()).generateAuthenticationOptions({ rpID: config.rpId,
      challenge: crypto.randomBytes(32), timeout: TTL_MS, userVerification: "required",
      ...(subject ? { allowCredentials: (await repository.listCredentials({ subjectId: subject.id })).map(credential => ({ id: credential.credentialId, transports: credential.transports })) } : {}),
    });
    if (subject && !options.allowCredentials?.length) throw failure("PASSKEY_NOT_REGISTERED", 409);
    return issue({ purpose, subject, bindingHash, sessionHash, authorityHash, payload }, options);
  }
  async function verifyRegistration(input) {
    const challenge = await consume({ ...input, purpose: "register" });
    const response = responseValue(input.response);
    const subject = await repository.subjectById(challenge.subjectId);
    if (!subject || subject.authRevision !== challenge.expectedAuthRevision) throw failure();
    let result;
    try { result = await (await library()).verifyRegistrationResponse({ response,
      expectedChallenge: challenge.challenge, expectedOrigin: config.origin, expectedRPID: config.rpId,
      expectedType: "webauthn.create", requireUserPresence: true, requireUserVerification: true,
      supportedAlgorithmIDs: [...ALGORITHMS] }); } catch { throw failure(); }
    const info = result.registrationInfo;
    if (!result.verified || !info?.userVerified || info.origin !== config.origin || info.rpID !== config.rpId) throw failure();
    const credential = info.credential;
    if (!base64(credential?.id, 2048) || credential.id !== response.id || !(credential.publicKey instanceof Uint8Array)
      || !credential.publicKey.length || credential.publicKey.length > 16384) throw failure();
    await assertCredentialKeyPolicy(credential.publicKey);
    return { challenge, subject, credential: { credentialId: credential.id, subjectId: subject.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter,
      transports: (credential.transports || []).filter(transport => TRANSPORTS.has(transport)),
      deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
      authorityHash: subjectBinding(subject), label: label(challenge.payload.label), createdAt: new Date(now()).toISOString() } };
  }
  async function verifyAuthentication(input) {
    const purpose = input.purpose || "authenticate";
    if (!["authenticate", "reauthenticate"].includes(purpose)) throw failure();
    const challenge = await consume({ ...input, purpose });
    const response = responseValue(input.response);
    const credential = await repository.credential(response.id);
    const subject = credential && await repository.subjectById(credential.subjectId);
    if (!subject || credential.revokedAt || credential.authorityHash !== subjectBinding(subject)
      || (challenge.subjectId && (subject.id !== challenge.subjectId || subject.authRevision !== challenge.expectedAuthRevision))
      || (!challenge.subjectId && response.response.userHandle !== subject.userHandle)
      || (response.response.userHandle !== null && response.response.userHandle !== undefined
        && response.response.userHandle !== subject.userHandle)) throw failure();
    await assertCredentialKeyPolicy(Buffer.from(credential.publicKey, "base64url"));
    let result;
    try { result = await (await library()).verifyAuthenticationResponse({ response,
      expectedChallenge: challenge.challenge, expectedOrigin: config.origin, expectedRPID: config.rpId,
      expectedType: "webauthn.get", requireUserVerification: true,
      credential: { id: credential.credentialId, publicKey: Uint8Array.from(Buffer.from(credential.publicKey, "base64url")),
        counter: credential.counter, transports: credential.transports } }); } catch { throw failure(); }
    const info = result.authenticationInfo;
    if (!result.verified || !info?.userVerified || info.credentialID !== credential.credentialId
      || info.origin !== config.origin || info.rpID !== config.rpId
      // Backup eligibility is immutable; the backup state of a multi-device
      // credential may legitimately change after registration.
      || info.credentialDeviceType !== credential.deviceType) throw failure();
    return { challenge, subject, credential, newCounter: info.newCounter,
      deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, usedAt: new Date(now()).toISOString() };
  }
  return Object.freeze({ registrationOptions, authenticationOptions, verifyRegistration, verifyAuthentication });
}

module.exports = { TTL_MS, ALGORITHMS, PURPOSES, configuration, createPasskeyProtocol, subjectBinding, sameSubject, label, failure, hash, base64 };
