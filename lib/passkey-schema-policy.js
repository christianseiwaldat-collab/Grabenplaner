"use strict";

// A release prerequisite, not an environment or per-request bypass.
function readPolicy(metadata) {
  const policy = metadata?.grabenplaner?.passkeysSchemaPolicy;
  if (policy !== "compatible" && policy !== "required") throw new Error("PG_PASSKEYS_RELEASE_POLICY");
  return policy;
}
const installedPolicy = () => readPolicy(require("../package.json"));
module.exports = { readPolicy, installedPolicy };
