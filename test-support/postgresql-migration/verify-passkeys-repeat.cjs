"use strict";
const assert = require("node:assert/strict");
async function verifyPasskeysRepeat(client, migration = require("../../lib/persistence/postgresql/core/passkeys")) {
  const result = await migration.migrate(client);
  assert.equal(result?.applied, false, "Passkey migration must be idempotent after the upgrade/restore qualification");
  assert.equal(result.digest, migration.digest, "Repeated Passkey migration must retain its qualified source digest");
  return result;
}
module.exports = { verifyPasskeysRepeat };
