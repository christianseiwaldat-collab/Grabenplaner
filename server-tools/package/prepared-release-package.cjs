"use strict";

// Offline artifact transport only. The receipt is hash-pinned evidence, never
// permission to omit the updater's fresh package/ClamAV/backup/recovery gates.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const FORMAT = "grabenplaner-prepared-release";
const QUALIFICATION_FORMAT = "grabenplaner-release-qualification";
const REQUIRED_CHECKS = Object.freeze(["package", "linux-postgresql", "positive-negative", "ci", "sast"]);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_ARCHIVE = 4 * 1024 ** 3;
const MAX_DOCUMENT = 8 * 1024 ** 2;
const fail = code => { throw new Error(`PREPARED_RELEASE_${code}`); };
const digest = data => crypto.createHash("sha256").update(data).digest("hex");

// Mutation needs openat-style directory anchoring and Linux RENAME_NOREPLACE.
// Verification stays portable. Never approximate this with check-then-rename:
// a replaced destination directory could redirect the write outside the set.
function requireMutationPlatform() {
  if (process.platform !== "linux") fail("MUTATION_REQUIRES_LINUX");
}
const PUBLISH_DIRECTORY = String.raw`
import ctypes, errno, os, stat, sys
parent, source = 3, 4
name, target = os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2])
assert os.path.basename(name) == name and os.path.basename(target) == target
before, opened = os.stat(name, dir_fd=parent, follow_symlinks=False), os.fstat(source)
assert stat.S_ISDIR(before.st_mode) and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
libc = ctypes.CDLL(None, use_errno=True)
rename = libc.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
if rename(parent, name, parent, target, 1) != 0:
    number = ctypes.get_errno()
    raise OSError(number, os.strerror(number))
os.fsync(parent)
`;

// Python's standard ZIP reader and the canonical-path/type/byte checks are the
// same trust boundary as common.sh:gp_verify_sealed_zip. No archive member is
// extracted or executed. Root ownership belongs to the productive updater, not
// to this portable offline preparation tool. CRC and manifest hashes cover every
// member, with bounded expansion, including members the package might not use.
const ZIP_INSPECTOR = String.raw`
import hashlib, json, os, re, stat, sys, zipfile
def checked(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate JSON key')
        result[key] = value
    return result
def sha(value): return hashlib.sha256(value).hexdigest()
file = sys.argv[1]
before = os.lstat(file)
assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1
assert os.path.realpath(file) == file
flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
with os.fdopen(os.open(file, flags), 'rb') as stream:
    opened = os.fstat(stream.fileno())
    assert (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
    with zipfile.ZipFile(stream) as archive:
        entries = archive.infolist()
        assert 0 < len(entries) <= 100000
        assert sum(entry.file_size for entry in entries) <= 2147483648
        files, names, manifest_bytes = {}, set(), None
        for entry in entries:
            name = entry.filename
            assert name and '\\' not in name and not name.startswith('/')
            assert all(ord(c) >= 32 and ord(c) != 127 for c in name)
            assert ':' not in name and name == entry.orig_filename
            canonical = name[:-1] if entry.is_dir() else name
            assert all(part and part not in ('.', '..') and not part.endswith((' ', '.')) for part in canonical.split('/'))
            assert canonical not in names
            names.add(canonical)
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            assert kind in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)
            assert not entry.flag_bits & 1
            if entry.is_dir():
                assert entry.file_size == 0
                continue
            hasher, length, chunks = hashlib.sha256(), 0, []
            with archive.open(entry) as member:
                while True:
                    block = member.read(1024 * 1024)
                    if not block: break
                    length += len(block)
                    assert length <= entry.file_size
                    hasher.update(block)
                    if name == 'grabenplaner-server-manifest.json':
                        assert length <= 8388608
                        chunks.append(block)
            assert length == entry.file_size
            files[name] = {'bytes': length, 'sha256': hasher.hexdigest()}
            if name == 'grabenplaner-server-manifest.json': manifest_bytes = b''.join(chunks)
        assert manifest_bytes is not None
        for name in names:
            parts = name.split('/')
            assert all('/'.join(parts[:index]) not in files for index in range(1, len(parts)))
        manifest = json.loads(manifest_bytes.decode('utf-8-sig'), object_pairs_hook=checked)
        assert manifest['format'] == 'grabenplaner-server-package' and manifest['schemaVersion'] == 1
        assert manifest['platform'] == 'linux' and manifest['architecture'] == 'x64'
        assert manifest['dependenciesMode'] == 'source-install'
        assert manifest['nodeRuntimeIncluded'] is False and manifest['nodeRuntimeSha256'] is None
        assert re.fullmatch('[a-f0-9]{40}', manifest['sourceCommit'])
        expected = {}
        for row in manifest['files']:
            name = row['path']
            assert name in files and name != 'grabenplaner-server-manifest.json' and name not in expected
            assert isinstance(row['bytes'], int) and not isinstance(row['bytes'], bool) and row['bytes'] >= 0
            assert re.fullmatch('[a-f0-9]{64}', row['sha256'])
            expected[name] = {'bytes': row['bytes'], 'sha256': row['sha256']}
        assert expected == {name: row for name, row in files.items() if name != 'grabenplaner-server-manifest.json'}
        source_files = ''.join(name + '\t' + str(files[name]['bytes']) + '\t' + files[name]['sha256'] + '\n' for name in sorted(expected))
        result = {'manifestSha256': sha(manifest_bytes), 'sourceFilesSha256': sha(source_files.encode()),
                  'sourceCommit': manifest['sourceCommit'], 'appVersion': manifest['appVersion'], 'fileCount': len(files)}
    after = os.fstat(stream.fileno())
    current = os.lstat(file)
    def identity(s): return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
    assert identity(before) == identity(after) == identity(current)
print(json.dumps(result))
`;

function assertHash(value) { if (!HASH.test(value || "")) fail("HASH_REQUIRED"); return value; }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function sameFile(a, b) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every(key => a[key] === b[key]);
}
function directory(location) {
  const resolved = path.resolve(location);
  let current = resolved;
  while (true) {
    const info = fs.lstatSync(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_DIRECTORY");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.realpathSync.native(resolved) !== resolved) fail("NONCANONICAL_DIRECTORY");
  return { path: resolved, stat: fs.lstatSync(resolved, { bigint: true }) };
}
function unchangedDirectory(record) {
  const current = directory(record.path).stat;
  if (current.dev !== record.stat.dev || current.ino !== record.stat.ino) fail("DIRECTORY_CHANGED");
}
function withPinnedDirectory(record, operation) {
  requireMutationPlatform();
  unchangedDirectory(record);
  const descriptor = fs.openSync(record.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== record.stat.dev || opened.ino !== record.stat.ino) fail("DIRECTORY_CHANGED");
    // /proc resolves the already-open descriptor, never the mutable named path.
    return operation(`/proc/self/fd/${descriptor}`, descriptor);
  } finally { fs.closeSync(descriptor); }
}
function stableFile(location, maximum, operation) {
  const resolved = path.resolve(location);
  const parent = directory(path.dirname(resolved));
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) fail("UNSAFE_FILE");
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true }))) fail("FILE_CHANGED");
    const result = operation(descriptor, before);
    unchangedDirectory(parent);
    if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true }))
      || !sameFile(before, fs.lstatSync(resolved, { bigint: true }))) fail("FILE_CHANGED");
    return result;
  } finally { fs.closeSync(descriptor); }
}
function readStable(location, maximum = MAX_DOCUMENT) {
  return stableFile(location, maximum, descriptor => {
    const blocks = [], buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count; if (bytes > maximum) fail("FILE_TOO_LARGE");
      blocks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(blocks, bytes);
  });
}
function parseDocument(bytes) {
  // Qualification inputs are bound to independently supplied hashes before
  // their claims are read; the tool does not itself confer trust on those pins.
  let value, source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = JSON.parse(source); } catch { fail("INVALID_JSON"); }
  if (!plain(value)) fail("INVALID_JSON");
  // JSON.parse discards duplicate keys. Detect decoded key aliases too, so
  // other receipt readers cannot interpret a different binding or result.
  const stack = [];
  const tokens = /"(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|[{}\[\]]/g;
  for (const token of source.matchAll(tokens)) {
    const text = token[0];
    if (text === "{") stack.push(new Set());
    else if (text === "[") stack.push(null);
    else if (text === "}" || text === "]") stack.pop();
    else if (/^\s*:/.test(source.slice(token.index + text.length))) {
      const keys = stack[stack.length - 1], key = JSON.parse(text);
      if (!keys || keys.has(key)) fail("DUPLICATE_JSON_KEY");
      keys.add(key);
    }
  }
  return value;
}
function copyStable(source, destination, expectedHash, maximum = MAX_ARCHIVE) {
  assertHash(expectedHash);
  const targetParent = directory(path.dirname(destination));
  return withPinnedDirectory(targetParent, pinned => stableFile(source, maximum, sourceFd => {
    unchangedDirectory(targetParent);
    const anchored = path.join(pinned, path.basename(destination));
    const out = fs.openSync(anchored, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    try {
      while (true) {
        const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (!count) break;
        bytes += count;
        if (bytes > maximum) fail("FILE_TOO_LARGE");
        hash.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) {
          const current = fs.writeSync(out, buffer, written, count - written);
          if (current <= 0) fail("COPY_FAILED"); written += current;
        }
      }
      fs.fsyncSync(out);
      if (hash.digest("hex") !== expectedHash) fail("ARCHIVE_HASH_MISMATCH");
      unchangedDirectory(targetParent);
      const opened = fs.fstatSync(out, { bigint: true }), current = fs.lstatSync(anchored, { bigint: true });
      if (!sameFile(opened, current) || opened.nlink !== 1n) fail("FILE_CHANGED");
      return bytes;
    } finally { fs.closeSync(out); }
  }));
}
function inspectArchive(archive, expected = {}) {
  const interpreter = process.platform === "win32" ? "python" : "python3";
  const result = stableFile(archive, MAX_ARCHIVE, () => childProcess.spawnSync(interpreter, ["-I", "-c", ZIP_INSPECTOR, path.resolve(archive)],
    { encoding: "utf8", maxBuffer: MAX_DOCUMENT, timeout: 120000, windowsHide: true }));
  if (result.error || result.status !== 0) fail("ZIP_INVALID");
  const inspected = parseDocument(Buffer.from(result.stdout));
  for (const key of ["manifestSha256", "sourceCommit", "sourceFilesSha256"]) {
    if (expected[key] && inspected[key] !== expected[key]) fail(`${key.toUpperCase()}_MISMATCH`);
  }
  return inspected;
}
function validateBinding(binding) {
  if (!plain(binding) || !COMMIT.test(binding.sourceCommit || "") || !COMMIT.test(binding.sourceTree || "")) fail("SOURCE_BINDING");
  for (const key of ["archiveSha256", "manifestSha256", "sourceFilesSha256"]) assertHash(binding[key]);
}
function qualification(bytes, binding) {
  const value = parseDocument(bytes);
  if (value.format !== QUALIFICATION_FORMAT || value.schemaVersion !== 1 || value.status !== "passed"
    || value.platform !== "linux" || value.database !== "postgresql" || !Array.isArray(value.checks)
    || !value.checks.length || value.checks.length > 32 || new Set(value.checks).size !== value.checks.length
    || value.checks.some(check => !/^[a-z][a-z0-9-]{0,63}$/.test(check))) fail("QUALIFICATION_INVALID");
  for (const key of ["sourceCommit", "sourceTree", "archiveSha256", "manifestSha256", "sourceFilesSha256"]) {
    if (value[key] !== binding[key]) fail("QUALIFICATION_BINDING");
  }
  return value.checks;
}
function writeExclusive(location, bytes) {
  const parent = directory(path.dirname(location));
  withPinnedDirectory(parent, pinned => {
    const descriptor = fs.openSync(path.join(pinned, path.basename(location)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    unchangedDirectory(parent);
  });
}
function stagedDirectory(parentPath, action) {
  const parent = directory(parentPath);
  const temporary = withPinnedDirectory(parent, pinned => {
    const created = fs.mkdtempSync(path.join(pinned, ".prepared-release-"));
    unchangedDirectory(parent);
    return path.join(parent.path, path.basename(created));
  });
  const owned = directory(temporary);
  try { return action(owned, parent); } finally {
    // This tool creates only flat bundles. Cleanup is descriptor-relative and
    // never recursive: an exchanged path cannot delete an unrelated tree.
    if (fs.existsSync(temporary)) {
      withPinnedDirectory(parent, pinnedParent => withPinnedDirectory(owned, pinned => {
        for (const name of fs.readdirSync(pinned)) fs.unlinkSync(path.join(pinned, name));
        const current = fs.lstatSync(path.join(pinnedParent, path.basename(temporary)), { bigint: true });
        if (!current.isDirectory() || current.dev !== owned.stat.dev || current.ino !== owned.stat.ino) fail("DIRECTORY_CHANGED");
        fs.rmdirSync(path.join(pinnedParent, path.basename(temporary)));
      }));
    }
  }
}
function publish(temporary, destination, parent) {
  unchangedDirectory(parent); unchangedDirectory(temporary);
  if (path.dirname(path.resolve(destination)) !== parent.path || path.dirname(temporary.path) !== parent.path) fail("PUBLISH_PATH");
  // One kernel no-replace rename publishes the whole verified directory. An
  // existing target, including an attacker-created link, is never followed or
  // replaced. Both directory handles are inherited explicitly by trusted Python.
  withPinnedDirectory(parent, (_parentPath, parentFd) => withPinnedDirectory(temporary, (_sourcePath, sourceFd) => {
    const result = childProcess.spawnSync("python3", ["-I", "-c", PUBLISH_DIRECTORY,
      path.basename(temporary.path), path.basename(destination)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd, sourceFd], timeout: 30000, maxBuffer: 65536 });
    if (result.error || result.status !== 0) {
      if (/File exists/.test(result.stderr || "")) fail("PUBLISH_EEXIST");
      fail("PUBLISH_FAILED");
    }
    unchangedDirectory(parent);
  }));
}
function prepareRelease({ archive, store, binding, qualifications, requiredChecks = REQUIRED_CHECKS }) {
  requireMutationPlatform();
  validateBinding(binding);
  if (!Array.isArray(qualifications) || !qualifications.length || qualifications.length > 32) fail("QUALIFICATIONS_REQUIRED");
  if (!Array.isArray(requiredChecks) || requiredChecks.length > 32
    || requiredChecks.some(value => !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    || REQUIRED_CHECKS.some(value => !requiredChecks.includes(value))) fail("REQUIRED_CHECKS");
  return stagedDirectory(store, (temporary, parent) => {
    const bytes = copyStable(archive, path.join(temporary.path, "package.zip"), binding.archiveSha256);
    const inspected = inspectArchive(path.join(temporary.path, "package.zip"), binding);
    const records = qualifications.map((item, index) => {
      const input = readStable(item.path); if (digest(input) !== assertHash(item.sha256)) fail("QUALIFICATION_HASH_MISMATCH");
      const checks = qualification(input, binding), file = `qualification-${index + 1}.json`;
      writeExclusive(path.join(temporary.path, file), input);
      return { file, sha256: item.sha256, checks };
    });
    if (requiredChecks.some(check => !records.some(record => record.checks.includes(check)))) fail("QUALIFICATION_MISSING_CHECK");
    const receipt = { format: FORMAT, schemaVersion: 1, scope: "offline-artifact-only", deploymentAuthorized: false,
      skipsProductionGates: false, ...binding, archiveBytes: bytes, appVersion: inspected.appVersion,
      fileCount: inspected.fileCount, qualifications: records, requiredChecks: [...new Set(requiredChecks)].sort() };
    const receiptBytes = Buffer.from(JSON.stringify(receipt) + "\n");
    writeExclusive(path.join(temporary.path, "prepared-release.json"), receiptBytes);
    const receiptSha256 = digest(receiptBytes), destination = path.join(parent.path, `${binding.archiveSha256}-${receiptSha256}`);
    verifyPrepared({ directory: temporary.path, receiptSha256 });
    publish(temporary, destination, parent);
    verifyPrepared({ directory: destination, receiptSha256 });
    return { directory: destination, archive: path.join(destination, "package.zip"), archiveSha256: binding.archiveSha256, receiptSha256 };
  });
}
function verifyPrepared({ directory: location, receiptSha256 }) {
  assertHash(receiptSha256);
  const root = directory(location), bytes = readStable(path.join(root.path, "prepared-release.json"));
  if (digest(bytes) !== receiptSha256) fail("RECEIPT_HASH_MISMATCH");
  const receipt = parseDocument(bytes);
  if (receipt.format !== FORMAT || receipt.schemaVersion !== 1 || receipt.scope !== "offline-artifact-only"
    || receipt.deploymentAuthorized !== false || receipt.skipsProductionGates !== false) fail("RECEIPT_INVALID");
  validateBinding(receipt);
  if (!Array.isArray(receipt.qualifications) || !receipt.qualifications.length || receipt.qualifications.length > 32
    || !Array.isArray(receipt.requiredChecks) || receipt.requiredChecks.length > 32
    || REQUIRED_CHECKS.some(value => !receipt.requiredChecks.includes(value))) fail("RECEIPT_INVALID");
  const expected = ["package.zip", "prepared-release.json"];
  receipt.qualifications.forEach((item, index) => {
    if (item.file !== `qualification-${index + 1}.json`) fail("RECEIPT_PATH");
    expected.push(item.file);
    const input = readStable(path.join(root.path, item.file));
    if (digest(input) !== assertHash(item.sha256)) fail("QUALIFICATION_HASH_MISMATCH");
    if (JSON.stringify(qualification(input, receipt)) !== JSON.stringify(item.checks)) fail("QUALIFICATION_INVALID");
  });
  if (receipt.requiredChecks.some(check => !receipt.qualifications.some(item => item.checks.includes(check)))) fail("QUALIFICATION_MISSING_CHECK");
  if (JSON.stringify(fs.readdirSync(root.path).sort()) !== JSON.stringify(expected.sort())) fail("UNEXPECTED_FILE");
  const archive = path.join(root.path, "package.zip");
  const actual = stableFile(archive, MAX_ARCHIVE, (descriptor, stat) => {
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    while (true) { const count = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); }
    return { sha256: hash.digest("hex"), bytes: Number(stat.size) };
  });
  if (actual.sha256 !== receipt.archiveSha256 || actual.bytes !== receipt.archiveBytes) fail("ARCHIVE_HASH_MISMATCH");
  const inspected = inspectArchive(archive, receipt);
  if (inspected.appVersion !== receipt.appVersion || inspected.fileCount !== receipt.fileCount) fail("RECEIPT_INVALID");
  unchangedDirectory(root);
  return { ...receipt, receiptSha256, archive };
}
function promoteRelease({ directory: source, receiptSha256, destination }) {
  requireMutationPlatform();
  const receipt = verifyPrepared({ directory: source, receiptSha256 });
  const parentPath = path.dirname(path.resolve(destination));
  return stagedDirectory(parentPath, (temporary, parent) => {
    for (const item of [{ file: "package.zip", sha256: receipt.archiveSha256 },
      ...receipt.qualifications, { file: "prepared-release.json", sha256: receiptSha256 }]) {
      copyStable(path.join(source, item.file), path.join(temporary.path, item.file), item.sha256);
    }
    verifyPrepared({ directory: temporary.path, receiptSha256 });
    // Recheck the original set too: a changed evidence set cannot be promoted.
    verifyPrepared({ directory: source, receiptSha256 });
    publish(temporary, path.resolve(destination), parent);
    verifyPrepared({ directory: path.resolve(destination), receiptSha256 });
    return { directory: path.resolve(destination), archive: path.join(path.resolve(destination), "package.zip"),
      archiveSha256: receipt.archiveSha256, receiptSha256, deploymentAuthorized: false };
  });
}

module.exports = { FORMAT, QUALIFICATION_FORMAT, REQUIRED_CHECKS, prepareRelease, verifyPrepared, promoteRelease, inspectArchive };
if (require.main === module) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write("Usage: prepared-release-package.cjs prepare|verify|promote REQUEST.json\nprepare/promote require Linux (directory-FD writes and atomic no-replace publication); verify is portable.\nAll fresh updater security gates remain required.\n");
      process.exit(0);
    }
    // JSON request paths avoid shell interpretation and keep expected pins
    // explicit. No request can run commands, make a ZIP, or invoke a deployment.
    const [command, requestFile] = process.argv.slice(2);
    if (process.argv.length !== 4 || !["prepare", "verify", "promote"].includes(command)) fail("USAGE");
    const request = parseDocument(readStable(requestFile));
    let result;
    switch (command) {
      case "prepare": result = prepareRelease(request); break;
      case "verify": result = verifyPrepared(request); break;
      case "promote": result = promoteRelease(request); break;
      default: fail("USAGE");
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
