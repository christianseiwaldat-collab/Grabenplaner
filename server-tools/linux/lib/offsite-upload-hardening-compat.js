"use strict";
// One reviewed upload-only refresh. The normal updater's fingerprint gate stays unchanged.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const OLD_FINGERPRINT = "7e7b9c89ec334c00b247db7325e5c32df487ee6af9ede21b1f8587e0416660bf";
const OLD_SCHEMA = "a4c7c29593ec2751139761bce2cb644377c07714c968e460d98f2b41a99274f9";
const OLD_UPLOAD = "82a631ad95b83b339bb4139b3730258ed1227fd977a51bb56966a5785089a8e8";
const ARTIFACT = "grabenplaner-offsite-upload.sh", FORMAT = "grabenplaner-offsite-upload-refresh", HASH = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
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
function validateReceipt(receipt, expectedFingerprint) {
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 13
    || receipt.fingerprint !== expectedFingerprint || receipt.schemaSha256 !== OLD_SCHEMA || !Array.isArray(receipt.files) || receipt.files.length !== 43) fail("UPLOAD_REFRESH_RECEIPT");
  const seen = new Set();
  for (const item of receipt.files) {
    if (typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.includes("\\")
      || item.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(item.path) || !HASH.test(item.sha256 || "")) fail("UPLOAD_REFRESH_RECEIPT");
    seen.add(item.path);
  }
  const fingerprint = digestBytes([...receipt.files].sort((a, b) => a.path.localeCompare(b.path))
    .map(item => `server-tools/linux/offsite/${item.path}\0${item.sha256}\n`).join(""));
  if (fingerprint !== expectedFingerprint) fail("UPLOAD_REFRESH_RECEIPT");
}
function verify(oldModule, candidateModule, receiptFile, expectedFingerprint) {
  protectedPath(oldModule, true); protectedPath(candidateModule, true);
  if (!HASH.test(expectedFingerprint || "") || expectedFingerprint === OLD_FINGERPRINT) fail("UPLOAD_REFRESH_EXPECTED");
  const receipt = json(receiptFile, true), program = path.join(oldModule, "lib/offsite-contract.js");
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 13
    || receipt.fingerprint !== OLD_FINGERPRINT || receipt.schemaSha256 !== OLD_SCHEMA) fail("UPLOAD_REFRESH_PREDECESSOR");
  validateReceipt(receipt, OLD_FINGERPRINT);
  for (const item of receipt.files) if (digest(path.join(oldModule, item.path)) !== item.sha256) fail("UPLOAD_REFRESH_PREDECESSOR");
  if (![0o755, 0o750, 0o700].includes(protectedPath(path.join(oldModule, ARTIFACT)).mode & 0o777)) fail("UPLOAD_REFRESH_PERMISSIONS");
  // The pinned old contract verifies both modules. Never execute an unverified candidate helper.
  const before = JSON.parse(command(program, "contract", oldModule));
  if (before.fingerprint !== OLD_FINGERPRINT || before.schemaSha256 !== OLD_SCHEMA || digest(path.join(oldModule, ARTIFACT)) !== OLD_UPLOAD) fail("UPLOAD_REFRESH_PREDECESSOR");
  for (const item of before.files) protectedPath(path.join(oldModule, item.path));
  command(program, "verify-installed-bound", oldModule, receiptFile);
  const next = JSON.parse(command(program, "contract", candidateModule));
  if (next.moduleVersion !== 13 || next.schemaSha256 !== OLD_SCHEMA || next.fingerprint !== expectedFingerprint
    || canonical(json(path.join(oldModule, "module-schema.json"))) !== canonical(json(path.join(candidateModule, "module-schema.json")))) fail("UPLOAD_REFRESH_CANDIDATE");
  const previous = new Map(before.files.map(item => [item.path, item.sha256]));
  if (next.files.length !== previous.size || next.files.filter(item => item.path === ARTIFACT).length !== 1) fail("UPLOAD_REFRESH_ARTIFACT_SET");
  const changed = [];
  for (const item of next.files) {
    protectedPath(path.join(candidateModule, item.path));
    if (!previous.has(item.path) || !HASH.test(item.sha256)) fail("UPLOAD_REFRESH_ARTIFACT_SET");
    if (previous.get(item.path) !== item.sha256) changed.push(item.path);
  }
  if (canonical(changed) !== canonical([ARTIFACT])) fail("UPLOAD_REFRESH_DELTA");
  return { receipt, next, proof: { format: FORMAT, schemaVersion: 1, from: 13, to: 13,
    previousFingerprint: OLD_FINGERPRINT, candidateFingerprint: next.fingerprint, changed, providerBindingPreserved: true } };
}
function prepare(oldModule, candidateModule, receiptFile, expectedFingerprint, appManifest, candidateManifest, packageSha) {
  if (!HASH.test(packageSha || "")) fail("UPLOAD_REFRESH_PACKAGE");
  const { receipt, next, proof } = verify(oldModule, candidateModule, receiptFile, expectedFingerprint);
  const appBefore = installedAppManifestDigest(appManifest), appAfter = digest(candidateManifest);
  if (appBefore === appAfter) fail("UPLOAD_REFRESH_APP_DELTA");
  const root = path.join(path.dirname(oldModule), `.offsite-upload-refresh-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(path.dirname(root)); protectedPath(root, true, true);
  const previousUpload = bytes(path.join(oldModule, ARTIFACT)), nextUpload = bytes(path.join(candidateModule, ARTIFACT));
  const previousReceipt = bytes(receiptFile, true), nextReceipt = Buffer.from(JSON.stringify({ ...next, providerBinding: receipt.providerBinding }, null, 2) + "\n");
  for (const [name, data] of Object.entries({ "old-upload": previousUpload, "new-upload": nextUpload, "old-receipt": previousReceipt, "new-receipt": nextReceipt })) writeExclusive(path.join(root, name), data);
  const journal = { ...proof, state: "prepared", module: oldModule, receipt: receiptFile, appManifest,
    appBefore, appAfter, packageSha, uploadMode: protectedPath(path.join(oldModule, ARTIFACT)).mode & 0o777,
    hashes: { "old-upload": digestBytes(previousUpload), "new-upload": digestBytes(nextUpload), "old-receipt": digestBytes(previousReceipt), "new-receipt": digestBytes(nextReceipt) } };
  writeExclusive(path.join(root, "journal.json"), JSON.stringify(journal, null, 2) + "\n");
  return { ...proof, transaction: root };
}
function transaction(root) {
  protectedPath(root, true, true);
  if (!/^\.offsite-upload-refresh-[a-f0-9-]{36}$/.test(path.basename(root))) fail("UPLOAD_REFRESH_JOURNAL");
  const journal = json(path.join(root, "journal.json"), true);
  if (journal.format !== FORMAT || journal.schemaVersion !== 1 || journal.previousFingerprint !== OLD_FINGERPRINT || journal.from !== 13 || journal.to !== 13
    || !HASH.test(journal.candidateFingerprint || "") || !HASH.test(journal.packageSha || "") || !HASH.test(journal.appBefore || "") || !HASH.test(journal.appAfter || "")
    || path.dirname(journal.module) !== path.dirname(root) || ![0o755, 0o750, 0o700].includes(journal.uploadMode)
    || !["prepared", "applying", "applied", "rolling-back", "rolled-back", "committed"].includes(journal.state)) fail("UPLOAD_REFRESH_JOURNAL");
  for (const name of ["old-upload", "new-upload", "old-receipt", "new-receipt"]) {
    if (!HASH.test(journal.hashes?.[name] || "") || digestBytes(bytes(path.join(root, name), true)) !== journal.hashes[name]) fail("UPLOAD_REFRESH_BACKUP");
  }
  if (journal.hashes["old-upload"] !== OLD_UPLOAD) fail("UPLOAD_REFRESH_BACKUP");
  const oldReceipt = json(path.join(root, "old-receipt"), true), newReceipt = json(path.join(root, "new-receipt"), true);
  validateReceipt(oldReceipt, OLD_FINGERPRINT); validateReceipt(newReceipt, journal.candidateFingerprint);
  for (const item of oldReceipt.files) if (item.path !== ARTIFACT && digest(path.join(journal.module, item.path)) !== item.sha256) fail("UPLOAD_REFRESH_UNKNOWN_STATE");
  if (oldReceipt.fingerprint !== OLD_FINGERPRINT || newReceipt.fingerprint !== journal.candidateFingerprint
    || oldReceipt.schemaSha256 !== OLD_SCHEMA || newReceipt.schemaSha256 !== OLD_SCHEMA
    || canonical(oldReceipt.providerBinding) !== canonical(newReceipt.providerBinding)) fail("UPLOAD_REFRESH_BINDING");
  protectedPath(journal.module, true); protectedPath(journal.receipt, false, true); installedAppManifestDigest(journal.appManifest);
  const currentUpload = digest(path.join(journal.module, ARTIFACT)), currentReceipt = digest(journal.receipt);
  if (![journal.hashes["old-upload"], journal.hashes["new-upload"]].includes(currentUpload)
    || ![journal.hashes["old-receipt"], journal.hashes["new-receipt"]].includes(currentReceipt)) fail("UPLOAD_REFRESH_UNKNOWN_STATE");
  const actual = JSON.parse(command(path.join(journal.module, "lib/offsite-contract.js"), "contract", journal.module));
  const expected = currentUpload === OLD_UPLOAD ? oldReceipt : newReceipt;
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
  atomic(path.join(journal.module, ARTIFACT), bytes(path.join(root, "new-upload"), true), journal.uploadMode);
  atomic(journal.receipt, bytes(path.join(root, "new-receipt"), true));
  coherent(journal, journal.candidateFingerprint); state(root, journal, "applied");
  return { ok: true, state: journal.state, fingerprint: journal.candidateFingerprint };
}
function rollback(root) {
  const journal = transaction(root);
  // Never put the old module over a committed or uncertain candidate app.
  if (journal.state === "committed" || installedAppManifestDigest(journal.appManifest) !== journal.appBefore) fail("UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN");
  state(root, journal, "rolling-back");
  atomic(path.join(journal.module, ARTIFACT), bytes(path.join(root, "old-upload"), true), journal.uploadMode);
  atomic(journal.receipt, bytes(path.join(root, "old-receipt"), true));
  coherent(journal, OLD_FINGERPRINT); state(root, journal, "rolled-back");
  return { ok: true, state: journal.state, fingerprint: OLD_FINGERPRINT };
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
    const counts = { verify: 4, prepare: 7, apply: 1, rollback: 1, finish: 1, inspect: 1 };
    if (counts[action] !== args.length) fail("UPLOAD_REFRESH_ARGUMENTS");
    let result;
    switch (action) {
      case "verify": result = verify(...args).proof; break;
      case "prepare": result = prepare(...args); break;
      case "apply": result = apply(...args); break;
      case "rollback": result = rollback(...args); break;
      case "finish": result = finish(...args); break;
      case "inspect": result = transaction(...args); break;
      default: fail("UPLOAD_REFRESH_ARGUMENTS");
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { process.stderr.write((/^UPLOAD_REFRESH_[A-Z_]+$/.test(error.code || "") ? error.code : "UPLOAD_REFRESH_FAILED") + "\n"); process.exitCode = 1; }
}
module.exports = { OLD_FINGERPRINT, OLD_SCHEMA, OLD_UPLOAD, ARTIFACT, verify, prepare, apply, rollback, finish, transaction };
