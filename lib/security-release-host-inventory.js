'use strict';

// Explicit Debian host-policy observation. Package entrypoints are never loaded.
// App package bytes remain subject to the inventory's strict physical contract;
// host-owned packages are a separate, fixed-root and dpkg-verified boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire, globalPaths, isBuiltin } = require('node:module');
const { spawnSync } = require('node:child_process');
const TRUSTED_OS_ROOTS = Object.freeze(['/usr/share/nodejs', '/usr/lib/nodejs', '/usr/lib/x86_64-linux-gnu/nodejs']);
// A single Debian/Node lookup alias, not an additional trusted tree. The exact
// symlink and its owning nodejs package must be proved whenever it is observed.
const OS_LOOKUP_ALIAS = Object.freeze({ path: '/usr/share/node_modules', linkText: 'nodejs', target: '/usr/share/nodejs', package: 'nodejs' });
const POLICY_ID = 'debian-nodejs-v1';
const FORMAT = 'grabenplaner-security-release-host-inventory';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => sha(JSON.stringify(stable(value)));
function fail(code, detail = '') { throw Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code }); }
function within(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const packageName = name => typeof name === 'string' && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) &&
  name.split('/').every(part => part !== '.' && part !== '..');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function state(s) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.uid, s.gid, s.mode].join(':'); }
function statValue(s) {
  return { type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
    uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, dev: s.dev, ino: s.ino,
    size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}
function systemAdapter() {
  function command(executable, args) {
    const r = spawnSync(executable, args, { encoding: 'utf8', shell: false, timeout: 30000,
      maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    if (r.error || r.status !== 0) fail('HOST_DPKG_COMMAND_FAILED', executable + ':' + String(r.error?.code || r.status));
    if (String(r.stderr || '').trim()) fail('HOST_DPKG_COMMAND_FAILED', executable + ':STDERR_NOT_EMPTY');
    return r.stdout;
  }
  return {
    kind: 'linux-system',
    info: file => statValue(fs.lstatSync(file)),
    exists: file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; } },
    real: file => fs.realpathSync.native(file),
    readlink: file => fs.readlinkSync(file),
    list: directory => fs.readdirSync(directory).sort(),
    read(file) {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) fail('HOST_REGULAR_FILE_REQUIRED', file);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (state(before) !== state(opened)) fail('HOST_FILE_CHANGED', file);
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
        if (state(before) !== state(after) || state(before) !== state(named) || bytes.length !== before.size) fail('HOST_FILE_CHANGED', file);
        return bytes;
      } finally { fs.closeSync(fd); }
    },
    lookup(from, name) {
      const loader = createRequire(path.join(from, 'package.json'));
      return { metadataRoots: loader.resolve.paths('gp-host-resolution-metadata-lookup') || [],
        actualNameRoots: loader.resolve.paths(name),
        resolve(specifier) {
          try { return { status: 'resolved', path: loader.resolve(specifier) }; }
          catch (e) {
            if (['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_INVALID_PACKAGE_TARGET',
              'ERR_INVALID_PACKAGE_CONFIG', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(e.code)) return { status: 'unresolved', code: e.code };
            throw e;
          }
        } };
    },
    owners(file) {
      const output = command('/usr/bin/dpkg-query', ['--search', '--', file]);
      const owners = new Set();
      for (const line of output.trimEnd().split('\n')) {
        const split = line.lastIndexOf(': ');
        if (split < 1 || line.slice(split + 2) !== file) continue;
        for (const owner of line.slice(0, split).split(', ')) {
          if (!/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/.test(owner)) fail('HOST_DPKG_OWNER_INVALID', file);
          owners.add(owner);
        }
      }
      if (!owners.size) fail('HOST_DPKG_OWNER_MISSING', file);
      return [...owners].sort();
    },
    verifyOwner(owner) {
      const output = command('/usr/bin/dpkg-query', ['--show', '--showformat=${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n', '--', owner]);
      const rows = output.trimEnd().split('\n');
      if (rows.length !== 1) fail('HOST_DPKG_STATUS_INVALID', owner);
      const [status, name, version, architecture, sourcePackage, sourceVersion] = rows[0].split('\t');
      if (status !== 'ii ' || !packageName(name) || !version || !architecture || !packageName(sourcePackage) || !sourceVersion) fail('HOST_DPKG_STATUS_INVALID', owner);
      const verification = command('/usr/bin/dpkg', ['--verify', '--', owner]);
      if (verification.trim()) fail('HOST_DPKG_VERIFY_MISMATCH', owner);
      const infoRoot = '/var/lib/dpkg/info';
      const candidates = [...new Set([owner, name + ':' + architecture, name])].map(value => path.join(infoRoot, value + '.md5sums'));
      const md5File = candidates.find(file => this.exists(file));
      let md5sums = { status: 'not_provided', coverage: 'Unknown; no package md5sums file was found' };
      if (md5File) {
        if (!within(infoRoot, this.real(md5File)) || this.info(md5File).type !== 'file') fail('HOST_DPKG_DATABASE_PATH_INVALID', md5File);
        for (let current = md5File; ; current = path.dirname(current)) {
          const stat = this.info(current);
          if (stat.uid !== 0 || stat.type === 'symlink' || (stat.mode & 0o022)) fail('HOST_DPKG_DATABASE_UNSAFE', current);
          if (path.dirname(current) === current) break;
        }
        const bytes = this.read(md5File);
        md5sums = { status: 'observed', path: md5File, bytes: bytes.length, sha256: sha(bytes),
          coverage: 'Local dpkg checksum-list bytes; not an upstream signature or proof that every package file has a checksum' };
      }
      return { owner, name, version, architecture, sourcePackage, sourceVersion, status,
        verification: 'dpkg-verify-exit-0-and-empty-output', md5sums };
    },
  };
}

function observe({ root, inventory, adapter = null, createdAt = null } = {}) {
  const io = adapter || systemAdapter();
  if (!adapter && process.platform !== 'linux') fail('HOST_LINUX_REQUIRED');
  if (adapter && adapter.kind !== 'synthetic-fixture') fail('HOST_ADAPTER_INVALID');
  // Tests replace I/O and lookup only; these production trust roots are never
  // configurable. A synthetic report is explicitly unable to prove a host.
  const synthetic = io.kind === 'synthetic-fixture';
  const appRoot = io.real(path.resolve(root));
  const appModules = path.join(appRoot, 'node_modules');
  if (!inventory || inventory.format !== 'grabenplaner-security-release-inventory' || inventory.schemaVersion !== 2 ||
      inventory.hostPolicy?.id !== POLICY_ID || inventory.hostPolicy?.version !== 1 ||
      inventory.mode !== 'installed' || !Array.isArray(inventory.installation?.packages) ||
      inventory.installation.physicalOnly !== true || !Array.isArray(inventory.installation.edges) ||
      inventory.installation.edges.length !== 0) fail('HOST_BASELINE_INVALID');
  const { contentSha256, ...inventoryBody } = inventory;
  if (digest(inventoryBody) !== contentSha256) fail('HOST_BASELINE_DOCUMENT_CHANGED');
  const filesObserved = new Map(), directoryObserved = new Map(), ownerCache = new Map(), fileCoverage = new Set(), aliasObserved = new Map();
  const baselinePackages = new Map(), externalPackages = new Map(), packageMetadata = new Map();
  let totalBytes = 0;
  function boundedRead(file) {
    const before = io.info(file);
    if (before.type !== 'file' || before.size > 128 * 1024 * 1024) fail('HOST_FILE_INVALID', file);
    const bytes = io.read(file), after = io.info(file);
    if (state(before) !== state(after) || bytes.length !== before.size) fail('HOST_FILE_CHANGED', file);
    totalBytes += bytes.length;
    if (totalBytes > 2 * 1024 * 1024 * 1024) fail('HOST_READ_LIMIT');
    return bytes;
  }
  function readManifest(directory) {
    if (packageMetadata.has(directory)) return packageMetadata.get(directory);
    let metadata;
    try { metadata = JSON.parse(boundedRead(path.join(directory, 'package.json')).toString('utf8').replace(/^\uFEFF/, '')); }
    catch (e) { if (e.code) throw e; fail('HOST_PACKAGE_METADATA_INVALID', directory); }
    if (!plain(metadata) || !packageName(metadata.name) || typeof metadata.version !== 'string' || !metadata.version || metadata.version.length > 200) fail('HOST_PACKAGE_METADATA_INVALID', directory);
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (metadata[key] === undefined) continue;
      if (!plain(metadata[key]) || Object.entries(metadata[key]).some(([name, range]) => !packageName(name) || typeof range !== 'string')) fail('HOST_DEPENDENCY_METADATA_INVALID', directory);
    }
    if (metadata.peerDependenciesMeta !== undefined && (!plain(metadata.peerDependenciesMeta) ||
        Object.entries(metadata.peerDependenciesMeta).some(([name, value]) => !packageName(name) || !plain(value) ||
          (value.optional !== undefined && typeof value.optional !== 'boolean')))) fail('HOST_DEPENDENCY_METADATA_INVALID', directory);
    packageMetadata.set(directory, metadata);
    return metadata;
  }
  function safeRelative(file) {
    if (typeof file !== 'string' || !file || file.includes('\\') || path.isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..')) fail('HOST_BASELINE_PATH_INVALID');
    return path.join(appRoot, ...file.split('/'));
  }
  function appTree(directory) {
    const result = [];
    for (const name of io.list(directory)) {
      if (name === 'node_modules') continue;
      const file = path.join(directory, name), stat = io.info(file);
      if (!within(appModules, io.real(file)) || stat.type === 'symlink') fail('HOST_APP_TREE_ESCAPE', file);
      if (stat.type === 'directory') result.push(...appTree(file));
      else if (stat.type === 'file') { const bytes = boundedRead(file); result.push({ path: relative(appRoot, file), bytes: bytes.length, sha256: sha(bytes) }); }
      else fail('HOST_APP_FILE_INVALID', file);
    }
    // Match the unchanged strict walk: sorted sibling entries, depth first.
    // Globally sorting paths would move a.js before directory a/b.js.
    return result;
  }
  // All physical app packages, including installed-but-unreachable packages,
  // are byte-checked before any actual-resolution result is accepted.
  let appFileCount = 0;
  for (const item of inventory.installation.packages) {
    const directory = io.real(safeRelative(item.path));
    if (!within(appModules, directory) || baselinePackages.has(directory) || !Array.isArray(item.files) || digest(item.files) !== item.contentSha256) fail('HOST_BASELINE_PACKAGE_INVALID', item.path);
    const actual = appTree(directory);
    if (digest(actual) !== item.contentSha256 || JSON.stringify(stable(actual)) !== JSON.stringify(stable(item.files))) fail('HOST_APP_CONTENT_MISMATCH', item.path);
    const metadata = readManifest(directory);
    if (metadata.name !== item.name || metadata.version !== item.version) fail('HOST_APP_METADATA_MISMATCH', item.path);
    baselinePackages.set(directory, item);
    appFileCount += actual.length;
  }
  const rootFile = path.join(appRoot, 'package.json'), rootBytes = boundedRead(rootFile);
  if (sha(rootBytes) !== inventory.inputs?.packageJson?.sha256 || rootBytes.length !== inventory.inputs?.packageJson?.bytes) fail('HOST_APP_ROOT_METADATA_MISMATCH');
  const rootMetadata = readManifest(appRoot);
  if (rootMetadata.name !== inventory.app?.name || rootMetadata.version !== inventory.app?.version) fail('HOST_APP_IDENTITY_MISMATCH');

  const osRoot = file => TRUSTED_OS_ROOTS.find(directory => within(directory, file)) || null;
  function safeAncestry(file) {
    for (let current = file; ; current = path.dirname(current)) {
      const stat = io.info(current);
      if (stat.uid !== 0 || (stat.type !== 'symlink' && (stat.mode & 0o022))) fail('HOST_OS_UNSAFE_OWNERSHIP_OR_MODE', current);
      if (stat.type !== 'directory' && stat.type !== 'symlink' && current !== file) fail('HOST_OS_ANCESTRY_INVALID', current);
      if (path.dirname(current) === current) break;
    }
  }
  function directOwnership(file) {
    const owners = io.owners(file);
    if (!Array.isArray(owners) || !owners.length) fail('HOST_DPKG_OWNER_MISSING', file);
    for (const owner of owners) if (!ownerCache.has(owner)) ownerCache.set(owner, io.verifyOwner(owner));
    return [...new Set(owners)].sort();
  }
  function lexicalAbsolute(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\\') || file.includes('\0') || path.normalize(file) !== file) fail('HOST_LOOKUP_ROOT_INVALID', String(file));
  }
  function aliasFailure(code, detail) { fail(aliasObserved.has(OS_LOOKUP_ALIAS.path) ? 'HOST_OS_ALIAS_CHANGED' : code, detail); }
  function proveAlias() {
    const alias = OS_LOOKUP_ALIAS;
    if (!io.exists(alias.path)) aliasFailure('HOST_OS_ALIAS_MISSING', alias.path);
    const before = io.info(alias.path);
    if (before.type !== 'symlink' || before.uid !== 0 || io.readlink(alias.path) !== alias.linkText ||
        io.real(alias.path) !== alias.target || io.info(alias.target).type !== 'directory' || io.real(alias.target) !== alias.target) aliasFailure('HOST_OS_ALIAS_INVALID', alias.path);
    safeAncestry(alias.path); safeAncestry(alias.target);
    // The link itself must belong only to the expected Debian nodejs binary
    // package. Descendant ownership is queried using canonical spelling below.
    const reportedOwners = io.owners(alias.path);
    if (!Array.isArray(reportedOwners) || reportedOwners.length !== 1 || reportedOwners[0].split(':')[0] !== alias.package) aliasFailure('HOST_OS_ALIAS_DPKG_OWNER_INVALID', alias.path);
    const owners = directOwnership(alias.path);
    if (owners.length !== 1 || ownerCache.get(owners[0])?.name !== alias.package) aliasFailure('HOST_OS_ALIAS_DPKG_OWNER_INVALID', alias.path);
    const linkText = io.readlink(alias.path), target = io.real(alias.path), after = io.info(alias.path);
    if (state(before) !== state(after) || linkText !== alias.linkText || target !== alias.target) aliasFailure('HOST_OS_ALIAS_CHANGED', alias.path);
    const record = { path: alias.path, type: 'symlink', target, linkText, linkTextSha256: sha(linkText), owners,
      metadata: { uid: before.uid, gid: before.gid, mode: before.mode, dev: before.dev, ino: before.ino,
        size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs },
      canonicalDescendantOwnershipRequired: true, verification: 'exact-root-owned-symlink-and-dpkg-verified-nodejs-owner' };
    const prior = aliasObserved.get(alias.path);
    if (prior && digest(prior) !== digest(record)) fail('HOST_OS_ALIAS_CHANGED', alias.path);
    aliasObserved.set(alias.path, record);
    return record;
  }
  function canonicalExternalPath(file) {
    lexicalAbsolute(file);
    if (!within(OS_LOOKUP_ALIAS.path, file)) return file;
    proveAlias();
    const canonical = path.join(OS_LOOKUP_ALIAS.target, path.relative(OS_LOOKUP_ALIAS.path, file));
    if (!within(OS_LOOKUP_ALIAS.target, canonical) || io.real(file) !== io.real(canonical)) fail('HOST_OS_ALIAS_PATH_ESCAPE', file);
    return canonical;
  }
  function ownership(file) {
    // dpkg owns /usr/share/nodejs/... spellings, not the equivalent lexical
    // descendants of its node_modules alias. The alias itself is owned nodejs.
    return directOwnership(file !== OS_LOOKUP_ALIAS.path && within(OS_LOOKUP_ALIAS.path, file) ? canonicalExternalPath(file) : file);
  }
  function osTree(file, active = new Set()) {
    const lexical = file;
    file = canonicalExternalPath(file);
    if (!osRoot(file)) fail('HOST_OS_PATH_ESCAPE', file);
    const real = io.real(file);
    if (!osRoot(real)) fail('HOST_OS_PATH_ESCAPE', file);
    safeAncestry(lexical); safeAncestry(file); safeAncestry(real);
    const stat = io.info(file), owners = ownership(file);
    if (stat.type === 'symlink') {
      const target = io.readlink(file), key = 'symlink:' + file;
      if (active.has(key)) fail('HOST_OS_LINK_CYCLE', file);
      const prior = filesObserved.get(file);
      const record = { path: file, type: 'symlink', uid: stat.uid, gid: stat.gid, mode: stat.mode,
        linkText: target, linkTextSha256: sha(target), target: real, owners };
      if (prior && digest(prior) !== digest(record)) fail('HOST_FILE_CHANGED', file);
      filesObserved.set(file, record);
      const next = new Set(active); next.add(key);
      osTree(real, next);
      if (state(stat) !== state(io.info(file)) || io.readlink(file) !== target || io.real(file) !== real) fail('HOST_FILE_CHANGED', file);
      return;
    }
    if (stat.type === 'directory') {
      if (active.has('directory:' + real)) fail('HOST_OS_LINK_CYCLE', file);
      if (directoryObserved.has(real)) return;
      const names = io.list(real);
      directoryObserved.set(real, { path: real, uid: stat.uid, gid: stat.gid, mode: stat.mode, owners, entriesSha256: digest(names) });
      const next = new Set(active); next.add('directory:' + real);
      for (const name of names) {
        if (name !== path.basename(name) || name === '.' || name === '..') fail('HOST_DIRECTORY_ENTRY_INVALID');
        osTree(path.join(real, name), next);
      }
      if (state(stat) !== state(io.info(file)) || digest(io.list(real)) !== digest(names)) fail('HOST_DIRECTORY_CHANGED', file);
      return;
    }
    if (stat.type !== 'file') fail('HOST_OS_FILE_INVALID', file);
    const bytes = boundedRead(real);
    const record = { path: real, type: 'file', uid: stat.uid, gid: stat.gid, mode: stat.mode,
      bytes: bytes.length, sha256: sha(bytes), owners };
    const prior = filesObserved.get(real);
    if (prior && digest(prior) !== digest(record)) fail('HOST_FILE_CHANGED', real);
    filesObserved.set(real, record); fileCoverage.add(real);
    if (filesObserved.size > 100000) fail('HOST_FILE_COUNT_LIMIT');
  }
  function classify(directory) {
    if (within(appModules, directory)) {
      if (!baselinePackages.has(directory)) fail('HOST_APP_PACKAGE_NOT_IN_BASELINE', directory);
      return 'app';
    }
    if (!osRoot(directory)) fail('HOST_RESOLUTION_UNAPPROVED_ROOT', directory);
    if (!externalPackages.has(directory)) {
      osTree(directory);
      const metadata = readManifest(directory);
      externalPackages.set(directory, { root: directory, name: metadata.name, version: metadata.version,
        packageJsonSha256: sha(boundedRead(path.join(directory, 'package.json'))), owners: ownership(directory) });
      if (externalPackages.size > 2000) fail('HOST_PACKAGE_COUNT_LIMIT');
    }
    return 'os-dpkg';
  }
  const queue = [[appRoot, rootMetadata]], seen = new Set([appRoot]), edges = [];
  while (queue.length) {
    const [from, manifest] = queue.shift();
    const declared = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, range] of Object.entries(declared).sort()) {
      const optional = Object.hasOwn(manifest.optionalDependencies || {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true;
      const lookup = io.lookup(from, name);
      let target = null, lexicalMetadata = null;
      for (const directory of lookup.metadataRoots) {
        lexicalAbsolute(directory);
        if (within(OS_LOOKUP_ALIAS.path, directory) && (io.exists(OS_LOOKUP_ALIAS.path) || aliasObserved.has(OS_LOOKUP_ALIAS.path))) proveAlias();
        const candidate = path.join(directory, ...name.split('/'), 'package.json');
        if (!io.exists(candidate)) continue;
        lexicalMetadata = candidate; target = io.real(path.dirname(candidate)); break;
      }
      if (!target && !optional) fail('HOST_REQUIRED_DEPENDENCY_MISSING', name + ' from ' + from);
      const kind = target ? classify(target) : null;
      const resolvedMetadata = lookup.resolve(name + '/package.json');
      const entry = lookup.resolve(name);
      if (target && resolvedMetadata.status === 'resolved' && io.real(resolvedMetadata.path) !== io.real(path.join(target, 'package.json'))) fail('HOST_METADATA_RESOLUTION_MISMATCH', name);
      if (target && entry.status === 'resolved' && !isBuiltin(entry.path)) {
        const actualEntry = io.real(entry.path);
        if (!within(target, actualEntry)) fail('HOST_ENTRYPOINT_PATH_ESCAPE', name);
      }
      if (!target && (resolvedMetadata.status === 'resolved' || entry.status === 'resolved' && !isBuiltin(entry.path))) fail('HOST_UNCLASSIFIED_RESOLUTION', name);
      if (target && kind === 'os-dpkg') {
        // A lexical package directory can itself be a dpkg symlink. Preserve
        // that alias and its root-owned, dpkg-owned target rather than hiding it.
        osTree(path.dirname(lexicalMetadata));
      }
      edges.push({ from, name, range, optional, status: target ? 'resolved' : 'optional_not_installed', target, kind,
        lexicalMetadata, lookupRoots: lookup.metadataRoots, actualNameLookupRoots: lookup.actualNameRoots,
        packageJsonRequireResolve: resolvedMetadata, entrypointRequireResolve: entry,
        builtinPrecedesDeclaredNpmPackage: entry.status === 'resolved' && isBuiltin(entry.path) });
      if (target && !seen.has(target)) { seen.add(target); queue.push([target, readManifest(target)]); }
    }
  }
  // Re-read already hashed external regular files and links after traversing the
  // closure. This is a bounded observation, not a filesystem snapshot or trace.
  for (const record of filesObserved.values()) {
    if (record.type === 'file') {
      if (sha(boundedRead(record.path)) !== record.sha256) fail('HOST_FILE_CHANGED', record.path);
    } else if (io.readlink(record.path) !== record.linkText || io.real(record.path) !== record.target) fail('HOST_FILE_CHANGED', record.path);
    safeAncestry(record.path);
  }
  for (const record of directoryObserved.values()) {
    const stat = io.info(record.path);
    if (stat.type !== 'directory' || stat.uid !== record.uid || stat.gid !== record.gid || stat.mode !== record.mode ||
        digest(io.list(record.path)) !== record.entriesSha256) fail('HOST_DIRECTORY_CHANGED', record.path);
    safeAncestry(record.path);
  }
  // Bind the local package database at both ends of the observation as well as
  // hashing the package files. Cached ownership cannot silently survive a
  // package update while the closure is being traversed.
  for (const [owner, record] of ownerCache) {
    if (digest(io.verifyOwner(owner)) !== digest(record)) fail('HOST_DPKG_DATABASE_CHANGED', owner);
  }
  for (const [directory, baseline] of baselinePackages) {
    if (digest(appTree(directory)) !== baseline.contentSha256) fail('HOST_APP_CONTENT_MISMATCH', baseline.path);
  }
  if (sha(boundedRead(rootFile)) !== inventory.inputs.packageJson.sha256) fail('HOST_APP_ROOT_METADATA_MISMATCH');
  const processEvidence = synthetic ? { synthetic: true } : {
    uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), cwd: process.cwd(), nodeVersion: process.version,
    executable: process.execPath, executableRealPath: io.real(process.execPath), executableSha256: sha(boundedRead(io.real(process.execPath))),
    execArgv: [...process.execArgv], globalPaths: [...globalPaths],
    environment: Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'NODE_PATH', 'NODE_OPTIONS'].map(name => [name, process.env[name] ?? null])),
  };
  // Revalidate after all file reads as well, including the executable read.
  // Identity fields detect replacing the link with another identical spelling.
  for (const alias of aliasObserved.values()) proveAlias(alias);
  const timestamp = createdAt || inventory.generatedAt;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) fail('HOST_CREATED_AT_INVALID');
  const result = { format: FORMAT, schemaVersion: 1, generatedAt: new Date(timestamp).toISOString(),
    assurance: { actualDeclaredMetadataResolutionObserved: !synthetic, synthetic,
      completeSystemSbom: false, runtimeExecutionTrace: false, vulnerabilityAssessment: false,
      serviceContextIndependentlyVerified: false },
    scope: 'Strict physical app package bytes plus actual-process declared metadata lookup and fixed-root, dpkg-verified OS dependency closure',
    limitations: ['No package entrypoint is executed; conditional, dynamic, undeclared and application-created module lookups are not exhaustively observed.',
      'require.resolve observations describe this observer process. Matching service user, Node binary, environment and mount view requires separately retained service-context evidence.',
      'dpkg verification is a local package-database integrity check, not an upstream authenticity signature or vulnerability scan; its file-type and checksum coverage is limited.',
      'External files and symlink targets are additionally SHA-256 hashed. Stable reads and end checks are not an atomic filesystem snapshot.'],
    policy: { id: POLICY_ID, fixedOsRoots: [...TRUSTED_OS_ROOTS], externalRootOwnerUid: 0, externalGroupOrOtherWritableAllowed: false,
      exactLookupAlias: { ...OS_LOOKUP_ALIAS }, arbitraryLookupAliasAllowed: false,
      externalDpkgOwnershipRequired: true, dpkgVerifyEmptyOutputRequired: true, maxFiles: 100000,
      maxFileBytes: 128 * 1024 * 1024, maxReadBytes: 2 * 1024 * 1024 * 1024 },
    baseline: { contentSha256, interpretation: 'Strict physical app package bytes; the complete declared dependency graph is observed by this host policy',
      app: inventory.app, appRoot, packagesByteChecked: baselinePackages.size, packageFilesByteChecked: appFileCount },
    observerProcess: processEvidence,
    edges, externalPackages: [...externalPackages.values()].sort((a, b) => a.root.localeCompare(b.root, 'en')),
    externalFiles: [...filesObserved.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    externalDirectories: [...directoryObserved.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    externalAliases: [...aliasObserved.values()],
    dpkgPackages: [...ownerCache.values()].sort((a, b) => a.owner.localeCompare(b.owner, 'en')),
  };
  return { ...result, contentSha256: digest(result) };
}
module.exports = { observe, digest, FORMAT, POLICY_ID, TRUSTED_OS_ROOTS };
