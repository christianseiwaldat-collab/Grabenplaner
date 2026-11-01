"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const repository = path.resolve(__dirname, ".."), helperRelative = "server-tools/linux/lib/offsite-postgresql-only-compat.js";

if (process.platform === "linux" && process.getuid() !== 0) {
  test("root-owned Offsite12/13 transition contracts and negatives", { timeout: 180000 }, () => {
    const old = require("../test-support/legacy-baseline").legacyPath("server-tools/linux/offsite");
    const result = spawnSync("sudo", ["-n", "env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
      "GP_TEST_OFFSITE12_SOURCE=" + old, process.execPath, "--test", "--test-reporter=tap", __filename], {
      encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
    assert.match(result.stdout, /^# pass 3$/m);
    assert.match(result.stdout, /^# fail 0$/m);
  });
} else {
  const enabled = process.platform === "linux";
  let temporary, oldModule, candidateModule, candidateHelper, receipt, oldBytes, candidateContract;
  const run = (...args) => spawnSync(process.execPath, [candidateHelper, ...args], { encoding: "utf8", timeout: 60000 });
  const verify = () => run("verify", oldModule, candidateModule, receipt);
  const writeJson = (file, value) => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  function copyModule(source, target) {
    const schema = JSON.parse(fs.readFileSync(path.join(source, "module-schema.json"), "utf8"));
    for (const relative of ["module-schema.json", ...schema.managedArtifacts.map(file => file.slice("server-tools/linux/offsite/".length))]) {
      const from = path.join(source, relative), to = path.join(target, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to); fs.chownSync(to, 0, 0); fs.chmodSync(to, fs.statSync(from).mode & 0o755);
    }
  }
  test.before(() => {
    if (!enabled) return;
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-offsite13-root-contract-")); fs.chmodSync(temporary, 0o700);
    oldModule = path.join(temporary, "previous/module");
    candidateModule = path.join(temporary, "candidate/server-tools/linux/offsite");
    candidateHelper = path.join(temporary, "candidate", helperRelative);
    const oldSource = process.env.GP_TEST_OFFSITE12_SOURCE || require("../test-support/legacy-baseline").legacyPath("server-tools/linux/offsite");
    assert.ok(oldSource.includes("gp-historical-baseline-"), "only the explicitly extracted synthetic baseline may be read");
    copyModule(oldSource, oldModule); copyModule(path.join(repository, "server-tools/linux/offsite"), candidateModule);
    fs.mkdirSync(path.dirname(candidateHelper), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(repository, helperRelative), candidateHelper); fs.chownSync(candidateHelper, 0, 0); fs.chmodSync(candidateHelper, 0o600);
    const previous = spawnSync(process.execPath, [path.join(oldModule, "lib/offsite-contract.js"), "contract", oldModule], { encoding: "utf8" });
    assert.equal(previous.status, 0, previous.stderr);
    const value = JSON.parse(previous.stdout);
    value.providerBinding = { format: "grabenplaner-offsite-provider-binding", schemaVersion: 1,
      providerId: "google_drive", remoteName: "synthetic", backend: "drive", authentication: "dedicated_oauth",
      endpoint: null, region: null, scope: "drive.file", configSha256: "a".repeat(64), policySha256: "b".repeat(64),
      repositoryLayout: "google-drive-direct-safe-path-v1", storageRoot: null };
    receipt = path.join(temporary, "previous.json"); writeJson(receipt, value); oldBytes = fs.readFileSync(receipt);
    const current = spawnSync(process.execPath, [path.join(candidateModule, "lib/offsite-contract.js"), "contract", candidateModule], { encoding: "utf8" });
    assert.equal(current.status, 0, current.stderr);
    candidateContract = path.join(temporary, "candidate-contract.json"); writeJson(candidateContract, JSON.parse(current.stdout));
    // Assert fixture ownership independently before testing the production guard.
    function inspect(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
        if (entry.isDirectory()) inspect(file);
        else assert.deepEqual({ uid: stat.uid, gid: stat.gid, links: stat.nlink, writable: stat.mode & 0o022 },
          { uid: 0, gid: 0, links: 1, writable: 0 }, file);
      }
    }
    inspect(temporary);
  });
  test.after(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

  test("exact module-only 12/13 delta preserves provider binding, units and original receipt", { skip: !enabled }, () => {
    const proof = verify(); assert.equal(proof.status, 0, proof.stderr);
    assert.deepEqual(JSON.parse(proof.stdout).changed, ["install-grabenplaner-offsite.sh", "lib/application-smoke.js", "lib/offsite-common.sh", "lib/offsite-contract.js"]);
    const output = path.join(temporary, "bound13.json"), bound = run("bind", receipt, candidateContract, output);
    assert.equal(bound.status, 0, bound.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)).providerBinding, JSON.parse(oldBytes).providerBinding);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const check = spawnSync(process.execPath, [path.join(candidateModule, "lib/offsite-contract.js"), "verify-installed-bound", candidateModule, output], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr); assert.deepEqual(fs.readFileSync(receipt), oldBytes);
    const smoke = spawnSync(process.execPath, [path.join(candidateModule, "lib/application-smoke.js")], { encoding: "utf8" });
    assert.equal(smoke.status, 1); assert.match(smoke.stderr, /PG_PAIRED_MAINTENANCE_REQUIRED/);
    assert.doesNotMatch(smoke.stderr, /MODULE_NOT_FOUND/);
  });
  test("unreviewed unit bytes, removed mandatory delta and changed old installation all fail closed", { skip: !enabled }, () => {
    for (const [base, relative, mutate, expected] of [
      [candidateModule, "systemd/grabenplaner-offsite-check.service.in", bytes => Buffer.concat([bytes, Buffer.from("\n# unreviewed\n")]), "PG_OFFSITE13_UNREVIEWED_DELTA"],
      [candidateModule, "lib/offsite-common.sh", () => fs.readFileSync(path.join(oldModule, "lib/offsite-common.sh")), "PG_OFFSITE13_REQUIRED_DELTA"],
      [oldModule, "lib/offsite-common.sh", bytes => Buffer.concat([bytes, Buffer.from("\n# unreviewed\n")]), "PG_OFFSITE13_CONTRACT"],
    ]) {
      const file = path.join(base, relative), before = fs.readFileSync(file);
      try { fs.writeFileSync(file, mutate(before)); const result = verify(); assert.equal(result.status, 1); assert.ok(result.stderr.includes(expected), result.stderr); }
      finally { fs.writeFileSync(file, before); }
    }
    assert.equal(verify().status, 0);
  });
  test("wrong source root, malformed provider binding, changed contract and existing output cannot be adopted", { skip: !enabled }, () => {
    assert.match(run("verify", oldModule, oldModule, receipt).stderr, /PG_OFFSITE13_CANDIDATE_ROOT/);
    try {
      const bad = JSON.parse(oldBytes); delete bad.providerBinding; writeJson(receipt, bad);
      assert.equal(verify().status, 1);
    } finally { fs.writeFileSync(receipt, oldBytes); }
    const current = fs.readFileSync(candidateContract);
    try {
      const bad = JSON.parse(current); bad.fingerprint = "0".repeat(64); writeJson(candidateContract, bad);
      assert.equal(run("bind", receipt, candidateContract, path.join(temporary, "must-not-exist")).status, 1);
      assert.equal(fs.existsSync(path.join(temporary, "must-not-exist")), false);
    } finally { fs.writeFileSync(candidateContract, current); }
    assert.match(run("bind", receipt, candidateContract, path.join(temporary, "bound13.json")).stderr, /EEXIST/);
    assert.deepEqual(fs.readFileSync(receipt), oldBytes);
  });
}
