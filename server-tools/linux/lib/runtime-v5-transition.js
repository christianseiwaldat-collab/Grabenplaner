"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const MUTABLE_RUNTIME = Object.freeze([
  "server-tools/linux/runtime-schema.json",
  "server-tools/linux/grabenplaner.service.in",
  "server-tools/linux/grabenplaner-bootstrap.service.in",
]);
const OFFSITE_DELTA = new Set([
  "server-tools/linux/offsite/grabenplaner-offsite-pre-update.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-prepare.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh",
  "server-tools/linux/offsite/lib/assurance-history.js",
  "server-tools/linux/offsite/lib/offsite-stage.js",
  "server-tools/linux/offsite/lib/offsite-contract.js",
  "server-tools/linux/offsite/install-grabenplaner-offsite.sh",
]);
function read(root, relative) {
  assert(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."));
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  return fs.readFileSync(file, "utf8");
}
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
function validateTransition(oldRoot, candidateRoot) {
  const before = JSON.parse(read(oldRoot, MUTABLE_RUNTIME[0]));
  const after = JSON.parse(read(candidateRoot, MUTABLE_RUNTIME[0]));
  assert.equal(before.deploymentSchemaVersion, 4);
  assert.equal(after.deploymentSchemaVersion, 5);
  assert.deepEqual({ ...before, deploymentSchemaVersion: 5 }, after);
  assert.equal(after.migrationPolicy, "explicit-maintenance");
  assert.equal(after.managedArtifacts.length, 11);
  for (const relative of before.managedArtifacts) {
    const previous = read(oldRoot, relative), next = read(candidateRoot, relative);
    if (MUTABLE_RUNTIME.includes(relative)) {
      assert.equal(previous.split("TimeoutStartSec=120s\n").length, 2);
      assert.equal(previous.split("TimeoutStopSec=120s\n").length, 2);
      assert.equal(next, previous.replace("TimeoutStartSec=120s\n", "TimeoutStartSec=1500s\n")
        .replace("TimeoutStopSec=120s\n", "TimeoutStopSec=1500s\n"));
    } else assert.equal(next, previous, "Unapproved runtime delta: " + relative);
  }
  const offsitePath = "server-tools/linux/offsite/module-schema.json";
  const previousOffsite = JSON.parse(read(oldRoot, offsitePath));
  const nextOffsite = JSON.parse(read(candidateRoot, offsitePath));
  assert.equal(previousOffsite.moduleVersion, 6);
  assert.equal(nextOffsite.moduleVersion, 7);
  assert.deepEqual({ ...previousOffsite, moduleVersion: 7 }, nextOffsite);
  for (const relative of previousOffsite.managedArtifacts) {
    if (!OFFSITE_DELTA.has(relative)) assert.equal(read(candidateRoot, relative), read(oldRoot, relative), "Unapproved offsite delta: " + relative);
  }
  return { fromSchema: 4, toSchema: 5, offsiteFrom: 6, offsiteTo: 7, mutableRuntime: MUTABLE_RUNTIME };
}
function validateInvocation({ transitionFile, marker, script, packageSha256, uid = process.getuid?.() }) {
  assert.equal(uid, 0);
  const parent = path.dirname(marker);
  assert.match(parent, /^\/opt\/grabenplaner\/\.runtime-v5-migration\.[A-Za-z0-9]+$/);
  assert.equal(transitionFile, path.join(parent, "transition.json"));
  assert.equal(script, path.join(parent, "extract/server-tools/linux/update-grabenplaner-server.sh"));
  const dir = fs.lstatSync(parent), stat = fs.lstatSync(transitionFile);
  assert(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === 0 && (dir.mode & 0o777) === 0o711);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && (stat.mode & 0o777) === 0o600);
  const value = JSON.parse(fs.readFileSync(transitionFile, "utf8"));
  assert.equal(value.format, "grabenplaner-runtime-v5-transition");
  assert.equal(value.packageSha256, packageSha256);
  assert.equal(value.candidateRoot, path.join(parent, "extract"));
  assert.match(value.installedOffsiteReceiptSha256, /^[a-f0-9]{64}$/);
  return value;
}
function boundOffsiteReceipt(previous, candidate) {
  assert.equal(previous.moduleVersion, 6);
  assert.equal(candidate.moduleVersion, 7);
  assert.equal(previous.format, "grabenplaner-linux-offsite-installed-contract");
  assert.equal(candidate.format, previous.format);
  assert(previous.providerBinding && !candidate.providerBinding);
  return { ...candidate, providerBinding: previous.providerBinding };
}
module.exports = { MUTABLE_RUNTIME, validateTransition, validateInvocation, boundOffsiteReceipt };
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "verify") console.log(JSON.stringify(validateTransition(...args)));
    else if (command === "invocation") {
      const [transitionFile, marker, script, packageSha256] = args;
      console.log(JSON.stringify(validateInvocation({ transitionFile, marker, script, packageSha256 })));
    } else if (command === "bind-offsite") {
      const [previousFile, candidateFile, output] = args;
      const result = boundOffsiteReceipt(JSON.parse(fs.readFileSync(previousFile, "utf8")), JSON.parse(fs.readFileSync(candidateFile, "utf8")));
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } else throw new Error("Unsupported command");
  } catch (error) { console.error("Runtime-v5 transition rejected: " + error.message); process.exitCode = 1; }
}
