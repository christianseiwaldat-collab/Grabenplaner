"use strict";
// Explicit, source-bound single-artifact refreshes for the published Offsite 13 contracts.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const OLD_FINGERPRINT = "7e7b9c89ec334c00b247db7325e5c32df487ee6af9ede21b1f8587e0416660bf";
const OLD_SCHEMA = "a4c7c29593ec2751139761bce2cb644377c07714c968e460d98f2b41a99274f9";
const OLD_UPLOAD = "82a631ad95b83b339bb4139b3730258ed1227fd977a51bb56966a5785089a8e8";
const ARTIFACT = "grabenplaner-offsite-upload.sh", INSTALLER = "install-grabenplaner-offsite.sh", HASH = /^[a-f0-9]{64}$/;
const UPLOAD = Object.freeze({ artifact: ARTIFACT, before: OLD_FINGERPRINT, oldSha: OLD_UPLOAD });
const REBIND = Object.freeze({
  artifact: "grabenplaner-offsite-rebind-rclone.sh",
  before: "5e3b928c04730081de555553286530b4380a4119a2b54eaf809676745e3a235b",
  after: "8933ef3ca3a9b660a7f07f44eda9cabd59e4c45d01900f2df180f81f5819f6ae",
  oldSha: "cdbd8bd3d283a295edf136de24d196d3c9f314f5629451398578f87eaaa6be1f",
  newSha: "0ac8fadf4ecd2bc65753e07a1761b8a342ecc3f6a93eac0f8876854a0c56c987",
  installer: "cd7bc215f517d5781287796b9ea8cf66906569d0a498c831439f5ced25a5ae0e",
  release105Installer: "d7ae7b54fa9bbb5c25a2f52f2ee3dab60a13550092c160ec39c52ed049b2a46c",
});
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function refresh(kind) {
  if (kind === "upload") return UPLOAD;
  if (kind === "rebind") return REBIND;
  fail("UPLOAD_REFRESH_ARGUMENTS");
}
function format(kind) { return `grabenplaner-offsite-${kind}-refresh`; }
function protectedPath(file, directory = false, privateMode = false, readGroup = false) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) fail("UPLOAD_REFRESH_PATH");
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || stat.uid !== 0 || (!readGroup && stat.gid !== 0) || (stat.mode & 0o022) || stat.size > 8 * 1024 * 1024
    || privateMode && (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail("UPLOAD_REFRESH_PERMISSIONS");
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    const current = fs.lstatSync(parent);
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== 0 || (current.mode & 0o022)) fail("UPLOAD_REFRESH_PARENT");
    if (parent === path.dirname(parent)) break;
  }
  return stat;
}
function bytes(file, privateMode = false) { protectedPath(file, false, privateMode); return fs.readFileSync(file); }
const digestBytes = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = file => digestBytes(bytes(file));
function installedAppManifestDigest(file) {
  // Installed app files belong to root:<service group>; only their read group
  // differs from the root:root module and private transaction artifacts.
  const stat = protectedPath(file, false, false, true);
  if (stat.gid !== fs.lstatSync(path.dirname(file)).gid
    || ![0o600, 0o640, 0o644].includes(stat.mode & 0o7777)) fail("UPLOAD_REFRESH_APP_MANIFEST_PERMISSIONS");
  return digestBytes(fs.readFileSync(file));
}
const json = (file, privateMode = false) => JSON.parse(bytes(file, privateMode).toString("utf8"));
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeExclusive(file, data, mode = 0o600) {
  protectedPath(path.dirname(file), true);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function atomic(file, data, mode = 0o600) {
  protectedPath(file);
  const pending = path.join(path.dirname(file), `.upload-refresh-${crypto.randomUUID()}`);
  writeExclusive(pending, data, mode);
  try { fs.renameSync(pending, file); syncDirectory(path.dirname(file)); }
  finally {
    try { fs.unlinkSync(pending); syncDirectory(path.dirname(file)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function command(program, ...args) {
  protectedPath(program);
  const result = spawnSync(process.execPath, [program, ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  if (result.error || result.status !== 0) fail("UPLOAD_REFRESH_CONTRACT");
  return result.stdout;
}
function fileFingerprint(files) {
  return digestBytes([...files].sort((a, b) => a.path.localeCompare(b.path))
    .map(item => `server-tools/linux/offsite/${item.path}\0${item.sha256}\n`).join(""));
}
function reviewedInventory(receipt, transition, expected) {
  if (transition === UPLOAD) return receipt.fingerprint === expected;
  const installer = receipt.files.find(item => item.path === INSTALLER);
  if (![REBIND.installer, REBIND.release105Installer].includes(installer?.sha256)) return false;
  return fileFingerprint(receipt.files.map(item => item.path === INSTALLER ? { ...item, sha256: REBIND.installer } : item)) === expected;
}
function validateReceipt(receipt, expectedFingerprint) {
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 13
    || receipt.fingerprint !== expectedFingerprint || receipt.schemaSha256 !== OLD_SCHEMA || !Array.isArray(receipt.files) || receipt.files.length !== 43) fail("UPLOAD_REFRESH_RECEIPT");
  const seen = new Set();
  for (const item of receipt.files) {
    if (typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.includes("\\")
      || item.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(item.path) || !HASH.test(item.sha256 || "")) fail("UPLOAD_REFRESH_RECEIPT");
    seen.add(item.path);
  }
  if (fileFingerprint(receipt.files) !== expectedFingerprint) fail("UPLOAD_REFRESH_RECEIPT");
}
function verify(oldModule, candidateModule, receiptFile, expectedFingerprint, kind = "upload") {
  const transition = refresh(kind), { artifact } = transition;
  protectedPath(oldModule, true); protectedPath(candidateModule, true);
  if (!HASH.test(expectedFingerprint || "") || expectedFingerprint === transition.before) fail("UPLOAD_REFRESH_EXPECTED");
  const receipt = json(receiptFile, true), program = path.join(oldModule, "lib/offsite-contract.js");
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 13
    || receipt.schemaSha256 !== OLD_SCHEMA) fail("UPLOAD_REFRESH_PREDECESSOR");
  validateReceipt(receipt, receipt.fingerprint);
  if (!reviewedInventory(receipt, transition, transition.before)) fail("UPLOAD_REFRESH_PREDECESSOR");
  for (const item of receipt.files) if (digest(path.join(oldModule, item.path)) !== item.sha256) fail("UPLOAD_REFRESH_PREDECESSOR");
  if (![0o755, 0o750, 0o700].includes(protectedPath(path.join(oldModule, artifact)).mode & 0o777)) fail("UPLOAD_REFRESH_PERMISSIONS");
  // The pinned old contract verifies both modules. Never execute an unverified candidate helper.
  const before = JSON.parse(command(program, "contract", oldModule));
  if (before.fingerprint !== receipt.fingerprint || before.schemaSha256 !== OLD_SCHEMA
    || digest(path.join(oldModule, artifact)) !== transition.oldSha) fail("UPLOAD_REFRESH_PREDECESSOR");
  for (const item of before.files) protectedPath(path.join(oldModule, item.path));
  command(program, "verify-installed-bound", oldModule, receiptFile);
  const next = JSON.parse(command(program, "contract", candidateModule));
  if (next.moduleVersion !== 13 || next.schemaSha256 !== OLD_SCHEMA || next.fingerprint !== expectedFingerprint
    || canonical(json(path.join(oldModule, "module-schema.json"))) !== canonical(json(path.join(candidateModule, "module-schema.json")))) fail("UPLOAD_REFRESH_CANDIDATE");
  validateReceipt(next, expectedFingerprint);
  if (transition === REBIND && (!reviewedInventory(next, transition, transition.after)
    || digest(path.join(candidateModule, artifact)) !== transition.newSha)) fail("UPLOAD_REFRESH_CANDIDATE");
  const previous = new Map(before.files.map(item => [item.path, item.sha256]));
  if (next.files.length !== previous.size || next.files.filter(item => item.path === artifact).length !== 1) fail("UPLOAD_REFRESH_ARTIFACT_SET");
  const changed = [];
  const installedFiles = next.files.map(item => {
    protectedPath(path.join(candidateModule, item.path));
    if (!previous.has(item.path) || !HASH.test(item.sha256)) fail("UPLOAD_REFRESH_ARTIFACT_SET");
    // The normal updater already accepts an installer-only package delta. Keep
    // those published installer bytes out of this rebind transaction.
    if (transition === REBIND && item.path === INSTALLER) return { ...item, sha256: previous.get(INSTALLER) };
    if (previous.get(item.path) !== item.sha256) changed.push(item.path);
    return item;
  });
  if (canonical(changed) !== canonical([artifact])) fail("UPLOAD_REFRESH_DELTA");
  const installed = { ...next, files: installedFiles, fingerprint: fileFingerprint(installedFiles) };
  return { receipt, next: installed, proof: { format: format(kind), schemaVersion: 1, from: 13, to: 13,
    previousFingerprint: before.fingerprint, candidateFingerprint: installed.fingerprint, changed, providerBindingPreserved: true } };
}
function prepare(oldModule, candidateModule, receiptFile, expectedFingerprint, appManifest, candidateManifest, packageSha, kind = "upload") {
  if (!HASH.test(packageSha || "")) fail("UPLOAD_REFRESH_PACKAGE");
  const { artifact } = refresh(kind);
  const { receipt, next, proof } = verify(oldModule, candidateModule, receiptFile, expectedFingerprint, kind);
  const appBefore = installedAppManifestDigest(appManifest), appAfter = digest(candidateManifest);
  if (appBefore === appAfter) fail("UPLOAD_REFRESH_APP_DELTA");
  const root = path.join(path.dirname(oldModule), `.offsite-${kind}-refresh-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(path.dirname(root)); protectedPath(root, true, true);
  const previousArtifact = bytes(path.join(oldModule, artifact)), nextArtifact = bytes(path.join(candidateModule, artifact));
  const previousReceipt = bytes(receiptFile, true), nextReceipt = Buffer.from(JSON.stringify({ ...next, providerBinding: receipt.providerBinding }, null, 2) + "\n");
  const backups = { [`old-${kind}`]: previousArtifact, [`new-${kind}`]: nextArtifact, "old-receipt": previousReceipt, "new-receipt": nextReceipt };
  const hashes = {};
  for (const [name, data] of Object.entries(backups)) {
    writeExclusive(path.join(root, name), data);
    hashes[name] = digestBytes(data);
  }
  const journal = { ...proof, state: "prepared", module: oldModule, receipt: receiptFile, appManifest,
    appBefore, appAfter, packageSha, [`${kind}Mode`]: protectedPath(path.join(oldModule, artifact)).mode & 0o777, hashes };
  writeExclusive(path.join(root, "journal.json"), JSON.stringify(journal, null, 2) + "\n");
  return { ...proof, transaction: root };
}
function transaction(root) {
  protectedPath(root, true, true);
  const kind = /^\.offsite-(upload|rebind)-refresh-[a-f0-9-]{36}$/.exec(path.basename(root))?.[1];
  if (!kind) fail("UPLOAD_REFRESH_JOURNAL");
  const transition = refresh(kind), { artifact } = transition, oldName = `old-${kind}`, newName = `new-${kind}`;
  const journal = json(path.join(root, "journal.json"), true);
  if (journal.format !== format(kind) || journal.schemaVersion !== 1 || journal.from !== 13 || journal.to !== 13
    || !HASH.test(journal.previousFingerprint || "") || canonical(journal.changed) !== canonical([artifact])
    || !HASH.test(journal.candidateFingerprint || "") || !HASH.test(journal.packageSha || "") || !HASH.test(journal.appBefore || "") || !HASH.test(journal.appAfter || "")
    || path.dirname(journal.module) !== path.dirname(root) || ![0o755, 0o750, 0o700].includes(journal[`${kind}Mode`])
    || !["prepared", "applying", "applied", "rolling-back", "rolled-back", "committed"].includes(journal.state)) fail("UPLOAD_REFRESH_JOURNAL");
  for (const name of [oldName, newName, "old-receipt", "new-receipt"]) {
    if (!HASH.test(journal.hashes?.[name] || "") || digestBytes(bytes(path.join(root, name), true)) !== journal.hashes[name]) fail("UPLOAD_REFRESH_BACKUP");
  }
  if (journal.hashes[oldName] !== transition.oldSha || journal.hashes[newName] === transition.oldSha
    || (transition === REBIND && journal.hashes[newName] !== transition.newSha)) fail("UPLOAD_REFRESH_BACKUP");
  const oldReceipt = json(path.join(root, "old-receipt"), true), newReceipt = json(path.join(root, "new-receipt"), true);
  validateReceipt(oldReceipt, journal.previousFingerprint); validateReceipt(newReceipt, journal.candidateFingerprint);
  if (!reviewedInventory(oldReceipt, transition, transition.before)
    || (transition === REBIND && !reviewedInventory(newReceipt, transition, transition.after))
    || canonical(oldReceipt.providerBinding) !== canonical(newReceipt.providerBinding)) fail("UPLOAD_REFRESH_BINDING");
  const nextFiles = new Map(newReceipt.files.map(item => [item.path, item.sha256]));
  if (oldReceipt.files.find(item => item.path === artifact)?.sha256 !== journal.hashes[oldName]
    || nextFiles.get(artifact) !== journal.hashes[newName]) fail("UPLOAD_REFRESH_BINDING");
  protectedPath(journal.module, true); protectedPath(journal.receipt, false, true); installedAppManifestDigest(journal.appManifest);
  for (const item of oldReceipt.files) {
    if (item.path !== artifact && (nextFiles.get(item.path) !== item.sha256
      || digest(path.join(journal.module, item.path)) !== item.sha256)) fail("UPLOAD_REFRESH_UNKNOWN_STATE");
  }
  const currentArtifact = digest(path.join(journal.module, artifact)), currentReceipt = digest(journal.receipt);
  if (![journal.hashes[oldName], journal.hashes[newName]].includes(currentArtifact)
    || ![journal.hashes["old-receipt"], journal.hashes["new-receipt"]].includes(currentReceipt)) fail("UPLOAD_REFRESH_UNKNOWN_STATE");
  const actual = JSON.parse(command(path.join(journal.module, "lib/offsite-contract.js"), "contract", journal.module));
  const expected = currentArtifact === transition.oldSha ? oldReceipt : newReceipt;
  if (actual.fingerprint !== expected.fingerprint || actual.schemaSha256 !== OLD_SCHEMA) fail("UPLOAD_REFRESH_UNKNOWN_STATE");
  return journal;
}
function state(root, journal, value) {
  journal.state = value; atomic(path.join(root, "journal.json"), JSON.stringify(journal, null, 2) + "\n");
}
function coherent(journal, expected) {
  command(path.join(journal.module, "lib/offsite-contract.js"), "verify-installed-bound", journal.module, journal.receipt);
  if (json(journal.receipt, true).fingerprint !== expected) fail("UPLOAD_REFRESH_FINAL");
}
function apply(root) {
  const journal = transaction(root);
  if (journal.state !== "prepared" || installedAppManifestDigest(journal.appManifest) !== journal.appBefore) fail("UPLOAD_REFRESH_STATE");
  state(root, journal, "applying");
  const kind = journal.format === format("rebind") ? "rebind" : "upload";
  atomic(path.join(journal.module, refresh(kind).artifact), bytes(path.join(root, `new-${kind}`), true), journal[`${kind}Mode`]);
  atomic(journal.receipt, bytes(path.join(root, "new-receipt"), true));
  coherent(journal, journal.candidateFingerprint); state(root, journal, "applied");
  return { ok: true, state: journal.state, fingerprint: journal.candidateFingerprint };
}
function rollback(root) {
  const journal = transaction(root);
  // Never put the old module over a committed or uncertain candidate app.
  if (journal.state === "committed" || installedAppManifestDigest(journal.appManifest) !== journal.appBefore) fail("UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN");
  state(root, journal, "rolling-back");
  const kind = journal.format === format("rebind") ? "rebind" : "upload";
  atomic(path.join(journal.module, refresh(kind).artifact), bytes(path.join(root, `old-${kind}`), true), journal[`${kind}Mode`]);
  atomic(journal.receipt, bytes(path.join(root, "old-receipt"), true));
  coherent(journal, journal.previousFingerprint); state(root, journal, "rolled-back");
  return { ok: true, state: journal.state, fingerprint: journal.previousFingerprint };
}
function finish(root) {
  const journal = transaction(root);
  if (!["applied", "committed"].includes(journal.state) || installedAppManifestDigest(journal.appManifest) !== journal.appAfter) fail("UPLOAD_REFRESH_APP_NOT_COMMITTED");
  coherent(journal, journal.candidateFingerprint); if (journal.state !== "committed") state(root, journal, "committed");
  return { ok: true, state: journal.state, fingerprint: journal.candidateFingerprint };
}
if (require.main === module) {
  try {
    if (process.platform !== "linux" || process.getuid() !== 0) fail("UPLOAD_REFRESH_ROOT_REQUIRED");
    const [action, ...args] = process.argv.slice(2);
    const counts = { verify: 4, prepare: 7, "verify-rebind": 4, "prepare-rebind": 7, apply: 1, rollback: 1, finish: 1, inspect: 1 };
    if (counts[action] !== args.length) fail("UPLOAD_REFRESH_ARGUMENTS");
    let result;
    switch (action) {
      case "verify": result = verify(...args).proof; break;
      case "prepare": result = prepare(...args); break;
      case "verify-rebind": result = verify(...args, "rebind").proof; break;
      case "prepare-rebind": result = prepare(...args, "rebind"); break;
      case "apply": result = apply(...args); break;
      case "rollback": result = rollback(...args); break;
      case "finish": result = finish(...args); break;
      case "inspect": result = transaction(...args); break;
      default: fail("UPLOAD_REFRESH_ARGUMENTS");
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { process.stderr.write((/^UPLOAD_REFRESH_[A-Z_]+$/.test(error.code || "") ? error.code : "UPLOAD_REFRESH_FAILED") + "\n"); process.exitCode = 1; }
}
module.exports = { OLD_FINGERPRINT, OLD_SCHEMA, OLD_UPLOAD, ARTIFACT, REBIND, verify, prepare, apply, rollback, finish, transaction };
