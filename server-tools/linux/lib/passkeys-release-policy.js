"use strict";

// Package source, never an environment switch, selects the schema prerequisite.
// A compatibility release understands both exact schemas but cannot create one.
const fs = require("node:fs");
const { readPolicy } = require("../../../lib/passkey-schema-policy");

function verifyNormalReceipt(receipt, metadata) {
  const policy = readPolicy(metadata);
  const present = receipt?.passkeysState === "present";
  if (receipt?.verified !== true || receipt.salesUnchanged !== true || receipt.schemaUnchanged !== true
    || receipt.passkeysSchemaPolicy !== policy || !/^[a-f0-9]{64}$/.test(receipt.coreBefore || "") || receipt.coreAfter !== receipt.coreBefore
    || receipt.applied !== false || receipt.passkeys?.applied !== false
    || receipt.passkeys?.digest !== require("../../../lib/persistence/postgresql/core/passkeys").digest
    || receipt.passkeysVerified !== present || receipt.passkeys?.deferred !== !present
    || (!present && (receipt.passkeysState !== "absent" || policy !== "compatible"))) {
    throw new Error("PG_PASSKEYS_NORMAL_UPDATE_RECEIPT");
  }
  return { verified: true, policy, passkeysState: receipt.passkeysState };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error("PG_PASSKEYS_RELEASE_ARGUMENTS");
    verifyNormalReceipt(JSON.parse(fs.readFileSync(process.argv[2], "utf8")),
      JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
  } catch { process.stderr.write("PG_PASSKEYS_NORMAL_UPDATE_RECEIPT\n"); process.exitCode = 1; }
}
module.exports = { readPolicy, verifyNormalReceipt };
