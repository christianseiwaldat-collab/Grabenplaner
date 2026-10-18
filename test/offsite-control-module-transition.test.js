"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const schema = require("../server-tools/linux/offsite/module-schema.json");
const { classify, fingerprint } = require("../server-tools/linux/lib/offsite-update-compat");

const prefix = "server-tools/linux/offsite/";
const paths = schema.managedArtifacts.map(name => name.slice(prefix.length));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const entries = paths.map(name => [name, hash(`synthetic-module:${name}`)]);

function installed(moduleVersion = 12, files = entries) {
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion,
    fingerprint: fingerprint(files),
    files: files.map(([path, sha256]) => ({ path, sha256 })),
  };
}

function candidate(moduleVersion = 12, files = entries) {
  return { offsiteModule: {
    schemaVersion: 1,
    moduleVersion,
    activationPolicy: "explicit-root-setup",
    fingerprint: fingerprint(files),
    installerSha256: new Map(files).get("install-grabenplaner-offsite.sh"),
    managedArtifacts: schema.managedArtifacts,
  } };
}

test("compatible control locking changes retain contract 12 and require explicit fingerprint migration", () => {
  assert.equal(schema.moduleVersion, 12);
  const changed = entries.map(([name, value]) => [name,
    name === "lib/assurance-control-broker.js" || name === "systemd/grabenplaner-offsite-assurance-control@.service.in"
      ? hash(`action-aware-locks:${name}`) : value]);
  assert.equal(classify(candidate(12, changed), installed()), "migration-required:12->12");
  assert.equal(classify(candidate(12, changed), installed(12, changed)), "compatible");
  assert.equal(classify(candidate(), installed()), "compatible");
});

test("module transition rejects downgrade, future versions and altered predecessor artifact sets", () => {
  assert.equal(classify(candidate(11), installed(12)), "invalid");
  assert.equal(classify(candidate(13), installed(12)), "invalid");
  assert.equal(classify(candidate(), installed(13)), "invalid");
  assert.equal(classify(candidate(), installed(12, entries.slice(1))), "invalid");
  assert.equal(classify(candidate(), installed(12, [...entries, ["lib/unreviewed.js", hash("extra")]])), "invalid");
});
