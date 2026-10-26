"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readPolicy, verifyNormalReceipt } = require("../server-tools/linux/lib/passkeys-release-policy");
const digest = require("../lib/persistence/postgresql/core/passkeys").digest;
const metadata = policy => ({ grabenplaner: { passkeysSchemaPolicy: policy } });
const receipt = (present, policy="compatible") => ({ verified: true, salesUnchanged: true, schemaUnchanged: true, applied: false,
  passkeysSchemaPolicy:policy,coreBefore:"a".repeat(64),coreAfter:"a".repeat(64),
  passkeysState: present ? "present" : "absent", passkeysVerified: present,
  passkeys: { applied: false, deferred: !present, digest } });

test("only the source package selects compatible or required Passkey schemas", () => {
  for (const policy of ["compatible", "required"]) assert.equal(readPolicy(metadata(policy)), policy);
  for (const value of [undefined, {}, metadata(undefined), metadata(""), metadata("optional"), metadata(true)]) {
    assert.throws(() => readPolicy(value), /PG_PASSKEYS_RELEASE_POLICY/);
  }
});
test("the normal updater accepts exact verified schemas without DDL and marks deferred activation honestly", () => {
  for (const policy of ["compatible", "required"]) {
    assert.deepEqual(verifyNormalReceipt(receipt(true,policy), metadata(policy)), { verified: true, policy, passkeysState: "present" });
  }
  assert.equal(verifyNormalReceipt(receipt(false), metadata("compatible")).passkeysState, "absent");
  assert.throws(() => verifyNormalReceipt(receipt(false), metadata("required")), /PG_PASSKEYS_NORMAL_UPDATE_RECEIPT/);
});
test("partial, contradictory, mutating and wrong-plan migration receipts cannot release an application start", () => {
  for (const present of [false, true]) {
    const changes = [{ verified: false }, { salesUnchanged: false }, { schemaUnchanged: false }, { applied: true },
      {passkeysSchemaPolicy:"required"},{coreBefore:"bad"},{coreAfter:"b".repeat(64)},
      { passkeysState: "unknown" }, { passkeysVerified: !present }, { passkeys: undefined },
      { passkeys: { ...receipt(present).passkeys, applied: true } },
      { passkeys: { ...receipt(present).passkeys, deferred: present } },
      { passkeys: { ...receipt(present).passkeys, digest: "0".repeat(64) } }];
    for (const change of changes) assert.throws(() => verifyNormalReceipt({ ...receipt(present), ...change }, metadata("compatible")), /PG_PASSKEYS_NORMAL_UPDATE_RECEIPT/);
    for (const field of ["verified", "salesUnchanged", "schemaUnchanged", "applied", "passkeysState", "passkeysVerified"]) {
      const incomplete = receipt(present); delete incomplete[field];
      assert.throws(() => verifyNormalReceipt(incomplete, metadata("compatible")), /PG_PASSKEYS_NORMAL_UPDATE_RECEIPT/);
    }
  }
});
