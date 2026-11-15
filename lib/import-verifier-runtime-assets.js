'use strict';

// External proposal: offline byte/mode inventory only. No Java execution,
// independent source-count proof, approval capability, download or cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const INDEX = 'lib/import-verifier-runtime-assets.json';
const BASE = 'lib/import-verifier-assets';
const EXECUTABLES = ['jre/bin/java', 'jre/bin/jfr', 'jre/bin/jrunscript', 'jre/bin/keytool', 'jre/bin/rmiregistry', 'jre/lib/jexec', 'jre/lib/jspawnhelper'].sort();
const COORDINATES = ['com.healthmarketscience.jackcess:jackcess:4.0.12', 'org.apache.commons:commons-lang3:3.18.0', 'commons-logging:commons-logging:1.2', 'com.google.code.gson:gson:2.13.2'];
const DESCRIPTOR_KEYS = ['format', 'schemaVersion', 'assetId', 'platform', 'installPrefix', 'javaPath', 'jars', 'helperClassesRoot', 'helperMainClass', 'classFiles', 'files', 'completeTreeSha256', 'executableAllowlist', 'licenseManifest', 'provenanceManifest'];
const MAX_FILE = 128 * 1024 * 1024;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function need(value, code) { if (!value) fail(code); }
function exact(value, keys) {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'ASSET_SHAPE');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const fingerprint = value => sha(JSON.stringify(stable(value)));
function exists(filename) { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\x21-\x7e]+$/u.test(value) && !/[\\:]/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part)), 'ASSET_PATH');
  return value;
}
function hash(value) { need(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'ASSET_SHA'); return value; }
function reference(value, withMode = false) {
  exact(value, withMode ? ['path', 'bytes', 'sha256', 'mode'] : ['path', 'bytes', 'sha256']);
  relative(value.path); hash(value.sha256);
  need(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes < MAX_FILE, 'ASSET_SIZE');
  if (withMode) need(value.mode === 420 || value.mode === 493, 'ASSET_MODE');
}
function ordered(values, key) {
  need(Array.isArray(values) && values.length > 0 && values.length <= 2000, 'ASSET_LIST');
  const names = values.map(value => key(value));
  need(names.every((name, i) => !i || ordinal(names[i - 1], name) < 0) && new Set(names.map(name => name.toLowerCase())).size === names.length, 'ASSET_ORDER_OR_COLLISION');
}
function statStable(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function readFile(root, name, max = MAX_FILE, keepBytes = false) {
  relative(name);
  const pieces = name.split('/');
  for (let i = 1; i < pieces.length; i++) {
    const parent = fs.lstatSync(path.join(root, ...pieces.slice(0, i)));
    need(parent.isDirectory() && !parent.isSymbolicLink(), 'ASSET_PARENT_LINK');
  }
  const filename = path.join(root, ...pieces), before = fs.lstatSync(filename);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size < max, 'ASSET_REGULAR_FILE');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const digest = crypto.createHash('sha256'), prefix = Buffer.alloc(64), chunks = [];
  let bytes = 0, first = true;
  try {
    need(statStable(before, fs.fstatSync(fd)), 'ASSET_CHANGED');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null));) {
      bytes += n; need(bytes < max, 'ASSET_SIZE'); digest.update(chunk.subarray(0, n));
      if (first) { chunk.copy(prefix, 0, 0, Math.min(n, prefix.length)); first = false; }
      if (keepBytes) chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    need(statStable(before, fs.fstatSync(fd)) && statStable(before, fs.lstatSync(filename)) && bytes === before.size, 'ASSET_CHANGED');
  } finally { fs.closeSync(fd); }
  return { path: name, bytes, sha256: digest.digest('hex'), prefix, stat: before, ...(keepBytes ? { content: Buffer.concat(chunks) } : {}) };
}
function readJson(root, name) {
  const read = readFile(root, name, 2 * 1024 * 1024, true);
  return { value: JSON.parse(read.content.toString('utf8')), read };
}
function walk(root, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, prefix)).sort(ordinal)) {
    const rel = prefix ? prefix + '/' + name : name; relative(rel);
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) fail('ASSET_CONTENT_LINK');
    if (stat.isDirectory()) result.push(...walk(root, rel));
    else { need(stat.isFile(), 'ASSET_SPECIAL_FILE'); result.push(rel); }
  }
  return result;
}
function matches(a, b) { return a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256; }
function validateDescriptor(value, assetId) {
  exact(value, DESCRIPTOR_KEYS);
  need(value.format === 'gp-af-verifier-runtime-assets-v1' && value.schemaVersion === 1 && value.assetId === assetId, 'ASSET_IDENTITY');
  exact(value.platform, ['os', 'arch', 'libc']);
  need(value.platform.os === 'linux' && value.platform.arch === 'x64' && value.platform.libc === 'glibc', 'ASSET_PLATFORM');
  need(value.installPrefix === BASE + '/' + assetId && value.javaPath === 'jre/bin/java' && value.helperClassesRoot === 'helper/classes' && value.helperMainClass === 'KnownAfCountVerifier', 'ASSET_ENTRYPOINT');
  ordered(value.files, entry => entry.path); value.files.forEach(entry => reference(entry, true));
  need(value.files.reduce((total, entry) => total + entry.bytes, 0) < 256 * 1024 * 1024 && fingerprint(value.files) === hash(value.completeTreeSha256), 'ASSET_TREE_SHA');
  const byPath = new Map(value.files.map(entry => [entry.path, entry]));
  function listed(ref) { need(matches(ref, byPath.get(ref.path) || {}), 'ASSET_REFERENCE_MISMATCH'); }
  need(Array.isArray(value.jars) && value.jars.length === 4, 'ASSET_JARS');
  value.jars.forEach((entry, i) => {
    exact(entry, ['path', 'bytes', 'sha256', 'coordinate']);
    reference({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    need(entry.coordinate === COORDINATES[i] && /^jars\/[a-z0-9.-]+\.jar$/u.test(entry.path), 'ASSET_MAVEN'); listed(entry);
  });
  need(new Set(value.jars.map(entry => entry.path)).size === 4, 'ASSET_JARS');
  ordered(value.classFiles, entry => entry.path);
  value.classFiles.forEach(entry => { reference(entry); need(entry.path.startsWith('helper/classes/') && /^[A-Za-z0-9_$/]+\.class$/u.test(entry.path.slice('helper/classes/'.length)), 'ASSET_CLASS_PATH'); listed(entry); });
  need(value.classFiles.some(entry => entry.path === 'helper/classes/KnownAfCountVerifier.class'), 'ASSET_MAIN_CLASS');
  need(JSON.stringify(value.files.filter(entry => entry.path.startsWith('helper/classes/')).map(entry => entry.path)) === JSON.stringify(value.classFiles.map(entry => entry.path)), 'ASSET_CLASS_SET');
  ordered(value.executableAllowlist, entry => entry.path);
  value.executableAllowlist.forEach(entry => { exact(entry, ['path', 'sha256']); relative(entry.path); hash(entry.sha256); need(byPath.get(entry.path)?.mode === 493 && byPath.get(entry.path).sha256 === entry.sha256, 'ASSET_EXECUTABLE_REFERENCE'); });
  need(JSON.stringify(value.executableAllowlist.map(entry => entry.path)) === JSON.stringify(EXECUTABLES) && JSON.stringify(value.files.filter(entry => entry.mode === 493).map(entry => entry.path)) === JSON.stringify(EXECUTABLES), 'ASSET_EXECUTABLE_SET');
  for (const name of ['licenseManifest', 'provenanceManifest']) { reference(value[name]); listed(value[name]); }
  need(byPath.has('runtime-components.cdx.json') && byPath.get('runtime-components.cdx.json').mode === 420, 'ASSET_SBOM_MISSING');
  return value;
}
function inspectRuntimeAssets(applicationRoot, { installed = false } = {}) {
  const root = path.resolve(applicationRoot), stat = fs.lstatSync(root);
  need(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(fs.realpathSync.native(root)) === root, 'ASSET_ROOT');
  const hasIndex = exists(path.join(root, INDEX)), hasAssets = exists(path.join(root, BASE));
  if (!hasIndex && !hasAssets) return null;
  need(hasIndex && hasAssets, 'ASSET_PARTIAL_INSTALLATION');
  const { value: index } = readJson(root, INDEX);
  exact(index, ['format', 'schemaVersion', 'currentAsset', 'assets']);
  need(index.format === 'gp-af-verifier-runtime-assets-index-v1' && index.schemaVersion === 1 && /^[a-z0-9][a-z0-9._-]{0,99}$/u.test(index.currentAsset) && Array.isArray(index.assets) && index.assets.length === 1, 'ASSET_INDEX');
  const entry = index.assets[0]; exact(entry, ['assetId', 'descriptorPath', 'sha256']);
  need(entry.assetId === index.currentAsset && entry.descriptorPath === BASE + '/' + entry.assetId + '/descriptor.json', 'ASSET_INDEX_ENTRY'); hash(entry.sha256);
  need(fs.readdirSync(path.join(root, BASE)).length === 1 && fs.readdirSync(path.join(root, BASE))[0] === entry.assetId, 'ASSET_EXTRA_VERSION');
  const descriptorRead = readJson(root, entry.descriptorPath); need(descriptorRead.read.sha256 === entry.sha256, 'ASSET_DESCRIPTOR_SHA');
  const descriptor = validateDescriptor(descriptorRead.value, entry.assetId), assetRoot = path.join(root, descriptor.installPrefix);
  if (installed && process.platform === 'linux') {
    for (let directory = assetRoot; ; directory = path.dirname(directory)) {
      const parent = fs.lstatSync(directory);
      need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && !(parent.mode & 0o7022), 'ASSET_INSTALLED_DIRECTORY');
      if (path.dirname(directory) === directory) break;
    }
  }
  need(JSON.stringify(walk(assetRoot).sort(ordinal)) === JSON.stringify([...descriptor.files.map(file => file.path), 'descriptor.json'].sort(ordinal)), 'ASSET_PHYSICAL_SET');
  for (const item of descriptor.files) {
    const read = readFile(assetRoot, item.path); need(matches(read, item), 'ASSET_FILE_SHA');
    if (item.mode === 493) need(read.prefix.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) && read.prefix.readUInt16LE(18) === 62, 'ASSET_NOT_X64_ELF');
    if (item.path.startsWith('helper/classes/')) need(read.prefix.readUInt32BE(0) === 0xcafebabe && read.prefix.readUInt16BE(6) <= 61, 'ASSET_NOT_JAVA17_CLASS');
    if (installed && process.platform === 'linux') need(read.stat.uid === 0 && !(read.stat.mode & 0o7022) && (read.stat.mode & 0o777) === (item.mode === 493 ? 0o750 : 0o640), 'ASSET_INSTALLED_PERMISSIONS');
  }
  return { assetId: descriptor.assetId, installPrefix: descriptor.installPrefix, descriptorPath: entry.descriptorPath, descriptorSha256: entry.sha256, completeTreeSha256: descriptor.completeTreeSha256,
    files: descriptor.files.length, bytes: descriptor.files.reduce((total, file) => total + file.bytes, 0), platform: descriptor.platform,
    components: [{ ecosystem: 'JVM', name: 'Eclipse Temurin JRE', version: '17.0.21+9' }, ...descriptor.jars.map(jar => ({ ecosystem: 'Maven', coordinate: jar.coordinate, sha256: jar.sha256 })), { ecosystem: 'application', name: descriptor.helperMainClass }],
    sbom: { ...descriptor.files.find(file => file.path === 'runtime-components.cdx.json'), path: descriptor.installPrefix + '/runtime-components.cdx.json' },
    executableModes: descriptor.executableAllowlist.map(file => ({ path: descriptor.installPrefix + '/' + file.path, sha256: file.sha256, mode: 493 })),
    observation: { payloadBytesVerified: true, javaExecuted: false, authenticityOrVulnerabilityClearance: false, installedPermissionsChecked: installed && process.platform === 'linux' } };
}

// Explicit CI declaration only. Never used by executable verifier composition.
function inspectDeclaredRuntimeAssets(applicationRoot) {
  const root = path.resolve(applicationRoot), stat = fs.lstatSync(root);
  need(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(fs.realpathSync.native(root)) === root, 'ASSET_ROOT');
  if (!exists(path.join(root, INDEX))) { need(!exists(path.join(root, BASE)), 'ASSET_PARTIAL_INSTALLATION'); return null; }
  need(!exists(path.join(root, BASE)), 'ASSET_SOURCE_DECLARATION_HAS_PAYLOAD');
  const { value: index } = readJson(root, INDEX);
  exact(index, ['format', 'schemaVersion', 'currentAsset', 'assets']);
  need(index.format === 'gp-af-verifier-runtime-assets-index-v1' && index.schemaVersion === 1 && /^[a-z0-9][a-z0-9._-]{0,99}$/u.test(index.currentAsset) && Array.isArray(index.assets) && index.assets.length === 1, 'ASSET_INDEX');
  const entry = index.assets[0]; exact(entry, ['assetId', 'descriptorPath', 'sha256']);
  need(entry.assetId === index.currentAsset && entry.descriptorPath === BASE + '/' + entry.assetId + '/descriptor.json', 'ASSET_INDEX_ENTRY'); hash(entry.sha256);
  const inputs = 'scripts/security/import-verifier-assets/' + entry.assetId;
  const { value: lock } = readJson(root, inputs + '/acquisition-lock.json');
  need(lock.format === 'gp-af-build-acquisition-lock-v2' && lock.schemaVersion === 2 && lock.assetId === entry.assetId && lock.descriptor.path === inputs + '/descriptor.json' && lock.descriptor.sha256 === entry.sha256 && Array.isArray(lock.trackedFiles) && lock.trackedFiles.length === 29, 'ASSET_SOURCE_LOCK');
  const read = readJson(root, lock.descriptor.path); need(read.read.sha256 === entry.sha256, 'ASSET_DESCRIPTOR_SHA');
  const descriptor = validateDescriptor(read.value, entry.assetId);
  need(lock.completeTreeSha256 === descriptor.completeTreeSha256 && lock.installPrefix === descriptor.installPrefix, 'ASSET_SOURCE_LOCK');
  const byPath = new Map(descriptor.files.map(file => [file.path, file]));
  for (const item of lock.trackedFiles) {
    exact(item, ['path', 'source', 'bytes', 'sha256', 'mode']); relative(item.source);
    const ref = byPath.get(item.path);
    need(ref && matches(item, ref) && item.mode === ref.mode && item.source === inputs + '/payload/' + item.path, 'ASSET_SOURCE_REFERENCE');
    const physical = readFile(root, item.source, 2 * 1024 * 1024);
    need(physical.bytes === item.bytes && physical.sha256 === item.sha256, 'ASSET_SOURCE_BYTES');
  }
  const expectedInputs = [...lock.trackedFiles.map(file => 'payload/' + file.path), 'descriptor.json', 'materialization-plan.json', 'acquisition-lock.json'].sort(ordinal);
  need(JSON.stringify(walk(path.join(root, inputs)).sort(ordinal)) === JSON.stringify(expectedInputs), 'ASSET_SOURCE_INPUT_SET');
  const plan = readJson(root, inputs + '/materialization-plan.json'); need(plan.read.sha256 === lock.materializationPlan.sha256 && plan.value.archiveSha256 === lock.archive.sha256, 'ASSET_SOURCE_PLAN');
  const sbom = lock.trackedFiles.find(file => file.path === 'runtime-components.cdx.json'); need(sbom, 'ASSET_SBOM_MISSING');
  return { status: 'declared_source_only', assetId: descriptor.assetId, descriptorSha256: entry.sha256, completeTreeSha256: descriptor.completeTreeSha256,
    platform: descriptor.platform, filesDeclared: descriptor.files.length, bytesDeclared: descriptor.files.reduce((n, file) => n + file.bytes, 0),
    sbom: { path: sbom.source, bytes: sbom.bytes, sha256: sbom.sha256, mode: sbom.mode }, executableModes: [],
    components: [{ ecosystem: 'JVM', name: 'Eclipse Temurin JRE', version: '17.0.21+9' }, ...descriptor.jars.map(jar => ({ ecosystem: 'Maven', coordinate: jar.coordinate, sha256: jar.sha256 })), { ecosystem: 'application', name: descriptor.helperMainClass }],
    observation: { payloadBytesVerified: false, declaredSmallInputsVerified: true, javaExecuted: false, installedPayloadObserved: false, authenticityOrVulnerabilityClearance: false } };
}

module.exports = { inspectRuntimeAssets, inspectDeclaredRuntimeAssets, validateDescriptor, fingerprint, EXECUTABLES, COORDINATES };
if (require.main === module) {
  try {
    const [operation, root] = process.argv.slice(2);
    need(['--mode-map', '--inventory', '--source-declaration'].includes(operation) && root && process.argv.length === 4, 'ASSET_COMMAND');
    const result = operation === '--source-declaration' ? inspectDeclaredRuntimeAssets(root) : inspectRuntimeAssets(root);
    process.stdout.write(JSON.stringify(operation === '--mode-map' ? result?.executableModes || [] : result) + '\n');
  } catch (error) { process.stderr.write((typeof error.code === 'string' ? error.code : 'ASSET_INVALID') + '\n'); process.exitCode = 1; }
}
