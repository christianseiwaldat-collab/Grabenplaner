"use strict";
// Exact module-only bridge. The coordinator owns FD9, the candidate package
// SHA, timer fencing, atomic swaps and rollback. No credentials are changed here.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const OLD_FINGERPRINT = "3b4f00d0ac775549f460aaeb089346f61cedf112c0fc68a4d09059b0dc6d933c";
const OLD_SCHEMA = "ad3f1fc27ae2618f4f751a5646888f4644de6cfdf57cb3a9501ef3313eedb876";
const DELTAS = Object.freeze(["install-grabenplaner-offsite.sh", "lib/application-smoke.js", "lib/offsite-common.sh", "lib/offsite-contract.js"]);
const FORMAT = "grabenplaner-linux-offsite-installed-contract", HASH = /^[a-f0-9]{64}$/;
const currentModule = path.resolve(__dirname, "../offsite");
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function protectedFile(file, privateMode = false) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) fail("PG_OFFSITE13_PATH");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022)
    || privateMode && (stat.gid !== 0 || (stat.mode & 0o777) !== 0o600) || stat.size > 8 * 1024 * 1024) fail("PG_OFFSITE13_FILE");
}
function json(file, privateMode = false) { protectedFile(file, privateMode); return JSON.parse(fs.readFileSync(file, "utf8")); }
function moduleCommand(moduleRoot, command, ...args) {
  const program = path.join(moduleRoot, "lib/offsite-contract.js"); protectedFile(program);
  const result = spawnSync(process.execPath, [program, command, ...args], {
    encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  if (result.error || result.status !== 0) fail("PG_OFFSITE13_CONTRACT");
  return result.stdout;
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function oldReceipt(file) {
  const receipt = json(file, true);
  if (receipt.format !== FORMAT || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 12
    || receipt.fingerprint !== OLD_FINGERPRINT || receipt.schemaSha256 !== OLD_SCHEMA || !Array.isArray(receipt.files)) fail("PG_OFFSITE13_PREDECESSOR");
  const seen = new Set();
  for (const file of receipt.files) {
    if (typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.includes("\\")
      || file.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(file.path)
      || !HASH.test(file.sha256 || "")) fail("PG_OFFSITE13_PREDECESSOR");
    seen.add(file.path);
  }
  const fingerprint = crypto.createHash("sha256").update([...receipt.files].sort((a, b) => a.path.localeCompare(b.path))
    .map(file => `server-tools/linux/offsite/${file.path}\0${file.sha256}\n`).join("")).digest("hex");
  if (fingerprint !== OLD_FINGERPRINT) fail("PG_OFFSITE13_PREDECESSOR");
  moduleCommand(currentModule, "provider-id", file);
  return receipt;
}
function verify(oldModule, candidateModule, receiptFile) {
  if (path.resolve(candidateModule) !== currentModule) fail("PG_OFFSITE13_CANDIDATE_ROOT");
  const receipt = oldReceipt(receiptFile);
  moduleCommand(candidateModule, "verify-installed-bound", oldModule, receiptFile);
  const next = JSON.parse(moduleCommand(candidateModule, "contract", candidateModule));
  if (next.format !== FORMAT || next.schemaVersion !== 1 || next.moduleVersion !== 13) fail("PG_OFFSITE13_CANDIDATE");
  const oldSchema = json(path.join(oldModule, "module-schema.json"));
  const newSchema = json(path.join(candidateModule, "module-schema.json"));
  if (canonical({ ...oldSchema, moduleVersion: 13 }) !== canonical(newSchema)) fail("PG_OFFSITE13_SCHEMA_DELTA");
  const before = new Map(receipt.files.map(item => [item.path, item.sha256]));
  if (before.size !== receipt.files.length || next.files.length !== before.size) fail("PG_OFFSITE13_ARTIFACT_SET");
  const changed = [];
  for (const file of next.files) {
    protectedFile(path.join(candidateModule, file.path));
    if (!before.has(file.path) || !HASH.test(file.sha256)) fail("PG_OFFSITE13_ARTIFACT_SET");
    if (before.get(file.path) !== file.sha256) {
      if (!DELTAS.includes(file.path)) fail("PG_OFFSITE13_UNREVIEWED_DELTA");
      changed.push(file.path);
    }
  }
  if (canonical(changed.sort()) !== canonical([...DELTAS].sort())) fail("PG_OFFSITE13_REQUIRED_DELTA");
  return { ok: true, format: "grabenplaner-postgresql-only-offsite-transition-v1", from: 12, to: 13,
    previousFingerprint: receipt.fingerprint, candidateFingerprint: next.fingerprint,
    candidateSchemaSha256: next.schemaSha256, changed: changed.sort(), providerBindingPreserved: true };
}
function bind(receiptFile, candidateContractFile, output) {
  const receipt = oldReceipt(receiptFile), candidate = json(candidateContractFile, true);
  const actual = JSON.parse(moduleCommand(currentModule, "contract", currentModule));
  protectedFile(path.join(currentModule, "module-schema.json"));
  for (const file of actual.files) protectedFile(path.join(currentModule, file.path));
  if (canonical(candidate) !== canonical(actual)) fail("PG_OFFSITE13_CANDIDATE");
  const parent = path.dirname(output), stat = fs.lstatSync(parent);
  if (!path.isAbsolute(output) || fs.realpathSync(parent) !== parent || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o700) fail("PG_OFFSITE13_OUTPUT");
  const result = { format: FORMAT, schemaVersion: 1, moduleVersion: 13, schemaSha256: candidate.schemaSha256,
    fingerprint: candidate.fingerprint, files: candidate.files, providerBinding: receipt.providerBinding };
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(result, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { ok: true, moduleVersion: 13, fingerprint: result.fingerprint, providerBindingPreserved: true };
}
if (require.main === module) {
  try {
    if (process.platform !== "linux" || process.getuid() !== 0) fail("PG_OFFSITE13_ROOT_REQUIRED");
    const [command, first, second, third, extra] = process.argv.slice(2);
    if (extra || !first || !second || !third || !["verify", "bind"].includes(command)) fail("PG_OFFSITE13_ARGUMENTS");
    process.stdout.write(JSON.stringify(command === "verify" ? verify(first, second, third) : bind(first, second, third)) + "\n");
  } catch (error) { process.stderr.write((error.code || "PG_OFFSITE13_FAILED") + "\n"); process.exitCode = 1; }
}
module.exports = { verify, bind, OLD_FINGERPRINT, OLD_SCHEMA, DELTAS };
