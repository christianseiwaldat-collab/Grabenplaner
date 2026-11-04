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

function installed(moduleVersion = 13, files = entries) {
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion,
    fingerprint: fingerprint(files),
    files: files.map(([path, sha256]) => ({ path, sha256 })),
  };
}

function candidate(moduleVersion = 13, files = entries) {
  return { offsiteModule: {
    schemaVersion: 1,
    moduleVersion,
    activationPolicy: "explicit-root-setup",
    fingerprint: fingerprint(files),
    installerSha256: new Map(files).get("install-grabenplaner-offsite.sh"),
    managedArtifacts: schema.managedArtifacts,
  } };
}

test("current module13 and predecessor12 require explicit fingerprint migration", () => {
  assert.equal(schema.moduleVersion, 13);
  const changed = entries.map(([name, value]) => [name,
    name === "lib/assurance-control-broker.js" || name === "systemd/grabenplaner-offsite-assurance-control@.service.in"
      ? hash(`action-aware-locks:${name}`) : value]);
  assert.equal(classify(candidate(13, changed), installed()), "migration-required:13->13");
  assert.equal(classify(candidate(13, changed), installed(13, changed)), "compatible");
  assert.equal(classify(candidate(), installed()), "compatible");
});

test("module transition rejects downgrade, future versions and altered predecessor artifact sets", () => {
  assert.equal(classify(candidate(11), installed(12)), "invalid");
  assert.equal(classify(candidate(13), installed(12)), "migration-required:12->13");
  assert.equal(classify(candidate(12), installed(13)), "invalid");
  assert.equal(classify(candidate(14), installed(13)), "invalid");
  assert.equal(classify(candidate(), installed(14)), "invalid");
  assert.equal(classify(candidate(), installed(12, entries.slice(1))), "invalid");
  assert.equal(classify(candidate(), installed(12, [...entries, ["lib/unreviewed.js", hash("extra")]])), "invalid");
});
