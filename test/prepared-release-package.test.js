"use strict";
const nodeTest = require("node:test");
const test = (name, body) => nodeTest(name, { skip: process.platform !== "linux" && "safe mutation requires Linux directory-FD support" }, body);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;
const P = require("../server-tools/package/prepared-release-package.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const python = process.platform === "win32" ? "python" : "python3";
const zipWriter = String.raw`
import json, stat, sys, zipfile
data = json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED) as archive:
    for row in data:
        entry = zipfile.ZipInfo(row['name'])
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777 if row.get('link') else stat.S_IFREG | 0o644) << 16
        archive.writestr(entry, row['data'].encode())
`;
function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-prepared-release-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, "store"); fs.mkdirSync(store);
  const files = { "package.json": '{"name":"synthetic-gp","version":"0.0.1-test"}\n',
    "server.js": "throw new Error('Candidate code must never execute during preparation');\n" };
  if (options.large) files["public/fixture.bin"] = "x".repeat(2 * 1024 ** 2);
  const manifestFiles = Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }));
  const manifest = { format: "grabenplaner-server-package", schemaVersion: 1,
    platform: "linux", architecture: "x64", dependenciesMode: "source-install", nodeRuntimeIncluded: false,
    nodeRuntimeSha256: null, appVersion: "0.0.1-test", sourceCommit: "a".repeat(40), files: manifestFiles };
  if (options.changeManifest) options.changeManifest(manifest);
  const manifestBytes = JSON.stringify(manifest) + "\n";
  let entries = [...Object.entries(files).map(([name, data]) => ({ name, data })),
    { name: "grabenplaner-server-manifest.json", data: manifestBytes }];
  if (options.changeEntries) entries = options.changeEntries(entries);
  const archive = path.join(root, "candidate.zip");
  const zip = spawnSync(python, ["-I", "-c", zipWriter, archive], { encoding: "utf8", input: JSON.stringify(entries), maxBuffer: 8 * 1024 ** 2 });
  assert.equal(zip.status, 0, zip.stderr || zip.error?.message);
  const sourceFilesSha256 = sha(manifestFiles.sort((a, b) => a.path.localeCompare(b.path))
    .map(row => `${row.path}\t${row.bytes}\t${row.sha256}\n`).join(""));
  const binding = { archiveSha256: sha(fs.readFileSync(archive)), manifestSha256: sha(manifestBytes), sourceFilesSha256,
    sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };
  const qualification = { format: P.QUALIFICATION_FORMAT, schemaVersion: 1, status: "passed", platform: "linux", database: "postgresql",
    checks: ["linux-postgresql", "positive-negative", "ci", "sast", "package"], ...binding };
  const qualificationFile = path.join(root, "qualification.json");
  function writeQualification(value = qualification) {
    const bytes = Buffer.from(JSON.stringify(value) + "\n"); fs.writeFileSync(qualificationFile, bytes); return sha(bytes);
  }
  const request = { archive, store, binding, qualifications: [{ path: qualificationFile, sha256: writeQualification() }],
    requiredChecks: ["linux-postgresql", "positive-negative", "ci", "sast", "package"] };
  return { root, archive, store, binding, qualification, qualificationFile, writeQualification, request,
    prepare: () => P.prepareRelease(request) };
}

nodeTest("non-Linux mutations fail explicitly and CLI explains the boundary", context => {
  if (process.platform === "linux") { context.skip("non-Linux boundary checked on the Windows host"); return; }
  assert.throws(() => P.prepareRelease({}), /MUTATION_REQUIRES_LINUX/);
  assert.throws(() => P.promoteRelease({}), /MUTATION_REQUIRES_LINUX/);
  const help = spawnSync(process.execPath, [path.resolve(__dirname, "../server-tools/package/prepared-release-package.cjs"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /prepare\/promote require Linux/); assert.match(help.stdout, /verify is portable/);
});

test("prepares and promotes the exact tested bytes without building or executing candidate code", context => {
  const f = fixture(context), prepared = f.prepare();
  const verified = P.verifyPrepared(prepared);
  assert.equal(verified.sourceCommit, f.binding.sourceCommit);
  assert.equal(verified.sourceTree, f.binding.sourceTree);
  assert.equal(verified.scope, "offline-artifact-only");
  assert.equal(verified.deploymentAuthorized, false);
  assert.equal(verified.skipsProductionGates, false);
  const target = path.join(f.root, "promotion");
  const result = P.promoteRelease({ ...prepared, destination: target });
  assert.deepEqual(fs.readFileSync(result.archive), fs.readFileSync(f.archive));
  assert.equal(result.archiveSha256, f.binding.archiveSha256);
  assert.equal(result.receiptSha256, prepared.receiptSha256);
  assert.equal(P.verifyPrepared(result).qualifications[0].sha256, f.request.qualifications[0].sha256);
});

test("CLI verifies only an explicitly pinned receipt and emits updater-compatible package/hash paths", context => {
  const f = fixture(context), prepared = f.prepare(), request = path.join(f.root, "request.json");
  fs.writeFileSync(request, JSON.stringify(prepared));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../server-tools/package/prepared-release-package.cjs"), "verify", request], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).archiveSha256, f.binding.archiveSha256);
  fs.writeFileSync(request, JSON.stringify({ ...prepared, receiptSha256: undefined }));
  const rejected = spawnSync(process.execPath, [path.resolve(__dirname, "../server-tools/package/prepared-release-package.cjs"), "verify", request], { encoding: "utf8" });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /HASH_REQUIRED/);
});

for (const key of ["archiveSha256", "manifestSha256", "sourceFilesSha256", "sourceCommit"]) {
  test(`rejects package ${key} mismatch against independent expected binding`, context => {
    const f = fixture(context); f.request.binding[key] = "c".repeat(key === "sourceCommit" ? 40 : 64);
    assert.throws(f.prepare, /MISMATCH/); assert.deepEqual(fs.readdirSync(f.store), []);
  });
}
for (const key of ["archiveSha256", "manifestSha256", "sourceFilesSha256", "sourceCommit", "sourceTree"]) {
  test(`rejects a qualification for a different ${key}`, context => {
    const f = fixture(context); f.qualification[key] = "c".repeat(key.startsWith("source") && !key.endsWith("Sha256") ? 40 : 64);
    f.request.qualifications[0].sha256 = f.writeQualification();
    assert.throws(f.prepare, /QUALIFICATION_BINDING/); assert.deepEqual(fs.readdirSync(f.store), []);
  });
}
for (const [name, change] of [
  ["failed tests", value => { value.status = "failed"; }],
  ["non-Linux tests", value => { value.platform = "win32"; }],
  ["SQLite tests", value => { value.database = "sqlite"; }],
  ["missing requested SAST", value => { value.checks = ["linux-postgresql"]; }],
  ["duplicate checks", value => { value.checks.push("ci"); }],
]) test(`rejects ${name} rather than treating it as tested`, context => {
  const f = fixture(context); change(f.qualification); f.request.qualifications[0].sha256 = f.writeQualification();
  assert.throws(f.prepare, /QUALIFICATION_/);
});

test("rejects absent or changed evidence and never renews production Assurance", context => {
  const f = fixture(context); fs.appendFileSync(f.qualificationFile, " ");
  assert.throws(f.prepare, /QUALIFICATION_HASH_MISMATCH/);
  f.request.qualifications = []; assert.throws(f.prepare, /QUALIFICATIONS_REQUIRED/);
});
test("does not let a caller weaken the minimum qualification profile", context => {
  const f = fixture(context); f.request.requiredChecks = [];
  assert.throws(f.prepare, /REQUIRED_CHECKS/);
});
test("rejects duplicate JSON keys in independently pinned qualification input", context => {
  const f = fixture(context), original = fs.readFileSync(f.qualificationFile, "utf8");
  const input = original.replace('"status":"passed"', '"status":"failed","sta\\u0074us":"passed"');
  fs.writeFileSync(f.qualificationFile, input); f.request.qualifications[0].sha256 = sha(input);
  assert.throws(f.prepare, /DUPLICATE_JSON_KEY/);
});
for (const [name, changeEntries] of [
  ["traversal", rows => [...rows, { name: "../escape", data: "x" }]],
  ["absolute path", rows => [...rows, { name: "/escape", data: "x" }]],
  ["Windows drive path", rows => [...rows, { name: "C:/escape", data: "x" }]],
  ["backslash", rows => [...rows, { name: "dir\\escape", data: "x" }]],
  ["noncanonical segment", rows => [...rows, { name: "dir/./escape", data: "x" }]],
  ["duplicate member", rows => [...rows, rows[0]]],
  ["symbolic link", rows => [...rows, { name: "link", data: "server.js", link: true }]],
  ["file/directory collision", rows => [...rows, { name: "server.js/escape", data: "x" }]],
  ["unmanifested member", rows => [...rows, { name: "extra.js", data: "x" }]],
  ["member mutation", rows => rows.map(row => row.name === "server.js" ? { ...row, data: "changed" } : row)],
]) test(`ZIP validation rejects ${name} without extracting it`, context => {
  const f = fixture(context, { changeEntries }); assert.throws(f.prepare, /ZIP_INVALID/);
  assert.equal(fs.existsSync(path.join(f.root, "escape")), false);
  assert.deepEqual(fs.readdirSync(f.store), []);
});
test("rejects a truncated ZIP even when its changed outer hash is pinned", context => {
  const f = fixture(context), bytes = fs.readFileSync(f.archive); fs.writeFileSync(f.archive, bytes.subarray(0, bytes.length - 25));
  f.binding.archiveSha256 = sha(fs.readFileSync(f.archive)); assert.throws(f.prepare, /ZIP_INVALID/);
});
test("rejects an altered manifest member declaration", context => {
  const f = fixture(context, { changeManifest: value => { value.files[0].sha256 = "c".repeat(64); } });
  assert.throws(f.prepare, /ZIP_INVALID/);
});

for (const item of ["package.zip", "prepared-release.json", "qualification-1.json"]) {
  test(`re-verification and promotion reject a mutated prepared ${item}`, context => {
    const f = fixture(context), prepared = f.prepare(); fs.appendFileSync(path.join(prepared.directory, item), " ");
    assert.throws(() => P.verifyPrepared(prepared), /MISMATCH/);
    assert.throws(() => P.promoteRelease({ ...prepared, destination: path.join(f.root, "promotion") }), /MISMATCH/);
    assert.equal(fs.existsSync(path.join(f.root, "promotion")), false);
  });
}
test("does not overwrite an existing content-addressed set or promotion target", context => {
  const f = fixture(context), prepared = f.prepare(); assert.throws(f.prepare, /EEXIST/);
  const target = path.join(f.root, "existing"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "keep"), "keep");
  assert.throws(() => P.promoteRelease({ ...prepared, destination: target }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "keep");
});
test("rejects hardlinked input archives, receipts and evidence", context => {
  const f = fixture(context); fs.linkSync(f.archive, path.join(f.root, "alias.zip")); assert.throws(f.prepare, /UNSAFE_FILE/);
  fs.unlinkSync(path.join(f.root, "alias.zip")); fs.linkSync(f.qualificationFile, path.join(f.root, "alias.json"));
  assert.throws(f.prepare, /UNSAFE_FILE/); fs.unlinkSync(path.join(f.root, "alias.json"));
  const prepared = f.prepare(); fs.linkSync(path.join(prepared.directory, "prepared-release.json"), path.join(f.root, "receipt-alias"));
  assert.throws(() => P.verifyPrepared(prepared), /UNSAFE_FILE/);
});
test("rejects a linked parent directory without writing through it", context => {
  const f = fixture(context), link = path.join(f.root, "linked-store");
  fs.symlinkSync(f.store, link, "junction"); f.request.store = link;
  assert.throws(f.prepare, /UNSAFE_DIRECTORY/); assert.deepEqual(fs.readdirSync(f.store), []);
});
test("rejects unexpected files and receipt path substitutions", context => {
  const f = fixture(context), prepared = f.prepare(), extra = path.join(prepared.directory, "extra");
  fs.writeFileSync(extra, "x"); assert.throws(() => P.verifyPrepared(prepared), /UNEXPECTED_FILE/); fs.unlinkSync(extra);
  const file = path.join(prepared.directory, "prepared-release.json"), value = JSON.parse(fs.readFileSync(file));
  value.qualifications[0].file = "../qualification.json"; fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => P.verifyPrepared({ ...prepared, receiptSha256: sha(fs.readFileSync(file)) }), /RECEIPT_PATH/);
});

test("detects an archive mutation during streamed copy, including after its bytes were read", context => {
  const f = fixture(context, { large: true }), original = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    const count = original.apply(this, args);
    if (!changed && count > 0) { changed = true; fs.appendFileSync(f.archive, "changed-during-copy"); }
    return count;
  };
  try { assert.throws(f.prepare, /MISMATCH|FILE_CHANGED/); } finally { fs.readSync = original; }
  assert.equal(changed, true); assert.deepEqual(fs.readdirSync(f.store), []);
});
test("detects archive path replacement during copy rather than trusting an already-open inode", context => {
  const f = fixture(context, { large: true }), original = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    const count = original.apply(this, args);
    if (!changed && count > 0) {
      changed = true; fs.renameSync(f.archive, path.join(f.root, "old.zip")); fs.copyFileSync(path.join(f.root, "old.zip"), f.archive);
    }
    return count;
  };
  try { assert.throws(f.prepare, /FILE_CHANGED/); } finally { fs.readSync = original; }
  assert.equal(changed, true); assert.deepEqual(fs.readdirSync(f.store), []);
});
test("an immediate rename hook cannot redirect publication through a target link", context => {
  const f = fixture(context), prepared = f.prepare(), target = path.join(f.root, "promotion"), outside = path.join(f.root, "outside");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "package.zip"), "must remain unchanged");
  const original = childProcess.spawnSync; let changed = false;
  childProcess.spawnSync = function (command, args, options) {
    if (args[2]?.includes("renameat2")) { changed = true; fs.symlinkSync(outside, target, "junction"); }
    return original.call(this, command, args, options);
  };
  try { assert.throws(() => P.promoteRelease({ ...prepared, destination: target }), /PUBLISH_EEXIST/); }
  finally { childProcess.spawnSync = original; }
  assert.equal(changed, true); assert.deepEqual(fs.readdirSync(outside), ["package.zip"]);
  assert.equal(fs.readFileSync(path.join(outside, "package.zip"), "utf8"), "must remain unchanged");
});
test("promotion rechecks the package after its initial verification", context => {
  const f = fixture(context), prepared = f.prepare(), target = path.join(f.root, "promotion"), original = fs.mkdtempSync;
  fs.mkdtempSync = function (...args) {
    const result = original.apply(this, args); fs.appendFileSync(prepared.archive, "changed-after-first-verification"); return result;
  };
  try { assert.throws(() => P.promoteRelease({ ...prepared, destination: target }), /MISMATCH/); }
  finally { fs.mkdtempSync = original; }
  assert.equal(fs.existsSync(target), false);
});
for (const name of ["package.zip", "qualification-1.json", "prepared-release.json"]) {
  test(`a directory swap at the final open cannot redirect the ${name} write`, context => {
    const f = fixture(context), outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "keep");
    const original = fs.openSync; let changed = false;
    fs.openSync = function (target, flags, ...rest) {
      if (!changed && typeof target === "string" && target.startsWith("/proc/self/fd/") && target.endsWith("/" + name)
        && typeof flags === "number" && (flags & fs.constants.O_CREAT)) {
        const handlePath = path.dirname(target), originalPath = fs.readlinkSync(handlePath);
        changed = true; fs.renameSync(originalPath, originalPath + ".moved"); fs.symlinkSync(outside, originalPath, "junction");
      }
      return original.call(this, target, flags, ...rest);
    };
    try { assert.throws(f.prepare, /DIRECTORY_CHANGED|UNSAFE_DIRECTORY/); } finally { fs.openSync = original; }
    assert.equal(changed, true); assert.deepEqual(fs.readdirSync(outside), ["keep"]);
    assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
  });
}
