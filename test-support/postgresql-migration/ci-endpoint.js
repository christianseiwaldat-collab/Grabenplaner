"use strict";
const assert = require("node:assert/strict");

// The CI bootstrap creates these two disposable databases and restricted roles.
// Local rehearsals retain their own explicit port allowlist.
function assertSyntheticEndpoint(value, domain, localPorts, env = process.env) {
  assert.ok(["core", "sales"].includes(domain));
  const url = new URL(value);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, `/gp_migration_${domain}`);
  assert.ok(["app", "reader", "migrator"].some(role => url.username === `gp_${domain}_${role}`));
  if (env.GP_CI_POSTGRESQL_FIXTURE === "github-actions-service-v1") {
    assert.equal(env.CI, "true");
    assert.equal(env.GITHUB_ACTIONS, "true");
    const admin = new URL(env.TEST_POSTGRESQL_URL);
    assert.equal(admin.hostname, "127.0.0.1");
    assert.equal(admin.port, "5432");
    assert.equal(admin.pathname, "/grabenplaner_test");
    assert.equal(admin.username, "postgres");
    assert.equal(url.port, admin.port);
  } else {
    assert.ok(localPorts.includes(url.port), "the explicitly isolated local cluster is required");
  }
  return url;
}

module.exports = { assertSyntheticEndpoint };
