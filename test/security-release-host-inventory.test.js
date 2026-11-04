'use strict';

// Fully synthetic Linux-path fixtures. No real package, dpkg database, network,
// service or application entrypoint is accessed. Run on Linux with node --test.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const crypto = require('node:crypto');
const { isBuiltin } = require('node:module');
const { observe, digest, FORMAT, POLICY_ID } = require('../lib/security-release-host-inventory');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const appRoot = '/opt/gp-fixture';
const client = appRoot + '/node_modules/client';
const osRoot = '/usr/share/nodejs';
const encoding = osRoot + '/encoding';
const iconv = osRoot + '/iconv-lite';
const safer = osRoot + '/safer-buffer';
const linux = { skip: process.platform !== 'linux' };

function fixture() {
  const nodes = new Map(), verified = [], forcedEntries = new Map();
  let inode = 1;
  function dir(name, owner = null) {
    name = path.resolve(name);
    if (name !== '/' && !nodes.has(path.dirname(name))) dir(path.dirname(name));
    if (!nodes.has(name)) nodes.set(name, { type: 'directory', uid: 0, gid: 0, mode: 0o755, dev: 1, ino: inode++, size: 0, mtimeMs: 0, ctimeMs: 0, owner });
    else if (owner) nodes.get(name).owner = owner;
  }
  function put(name, contents, owner = null) {
    dir(path.dirname(name));
    const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents);
    const old = nodes.get(name);
    nodes.set(name, { type: 'file', uid: 0, gid: 0, mode: 0o644, dev: 1, ino: old?.ino || inode++,
      size: bytes.length, mtimeMs: (old?.mtimeMs || 0) + 1, ctimeMs: (old?.ctimeMs || 0) + 1, bytes, owner });
  }
  function link(name, target, owner) {
    dir(path.dirname(name));
    nodes.set(name, { type: 'symlink', uid: 0, gid: 0, mode: 0o777, dev: 1, ino: inode++, size: target.length, mtimeMs: 1, ctimeMs: 1, target, owner });
  }
  function real(name, depth = 0) {
    if (depth > 40) throw Object.assign(new Error('fixture symlink cycle'), { code: 'ELOOP' });
    const parts = path.resolve(name).split('/').filter(Boolean);
    let current = '/';
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const value = nodes.get(current);
      if (!value) throw Object.assign(new Error('fixture missing: ' + current), { code: 'ENOENT' });
      if (value.type === 'symlink') return real(path.resolve(path.dirname(current), value.target, ...parts.slice(i + 1)), depth + 1);
    }
    return current;
  }
  function named(name) {
    if (name === '/') return '/';
    return path.join(real(path.dirname(name)), path.basename(name));
  }
  function info(name) {
    const value = nodes.get(named(name));
    if (!value) throw Object.assign(new Error('fixture missing: ' + name), { code: 'ENOENT' });
    const { bytes, target, owner, ...stat } = value;
    return { ...stat };
  }
  function exists(name) { try { info(name); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  function roots(from) {
    const values = [];
    for (let current = from; ; current = path.dirname(current)) {
      if (path.basename(current) !== 'node_modules') values.push(path.join(current, 'node_modules'));
      if (current === '/') break;
    }
    values.push(osRoot);
    return [...new Set(values)];
  }
  const adapter = {
    kind: 'synthetic-fixture', info, exists, real,
    readlink(name) { return nodes.get(named(name)).target; },
    list(directory) {
      const actual = real(directory);
      return [...nodes.keys()].filter(name => name !== actual && path.dirname(name) === actual).map(name => path.basename(name)).sort();
    },
    read(name) {
      const value = nodes.get(named(name));
      if (value.type !== 'file') throw Object.assign(new Error('fixture not file'), { code: 'EISDIR' });
      return Buffer.from(value.bytes);
    },
    owners(name) { const owner = nodes.get(named(name)).owner; return owner ? [owner] : []; },
    verifyOwner(owner) {
      verified.push(owner);
      return { owner, name: owner, version: '1.0-1', architecture: 'all', status: 'ii ', verification: 'synthetic-clean-dpkg-verification' };
    },
    lookup(from, name) {
      const metadataRoots = roots(from);
      return { metadataRoots, actualNameRoots: isBuiltin(name) ? null : metadataRoots,
        resolve(specifier) {
          if (isBuiltin(specifier)) return { status: 'resolved', path: specifier };
          const metadataOnly = specifier.endsWith('/package.json');
          const packageSpecifier = metadataOnly ? specifier.slice(0, -'/package.json'.length) : specifier;
          if (!metadataOnly && forcedEntries.has(from + '\0' + specifier)) return { status: 'resolved', path: forcedEntries.get(from + '\0' + specifier) };
          for (const base of metadataRoots) {
            if (!metadataOnly && exists(path.join(base, packageSpecifier + '.js'))) return { status: 'resolved', path: path.join(base, packageSpecifier + '.js') };
            const metadataFile = path.join(base, packageSpecifier, 'package.json');
            if (!exists(metadataFile)) continue;
            if (metadataOnly) return { status: 'resolved', path: real(metadataFile) };
            let metadata;
            try { metadata = JSON.parse(adapter.read(metadataFile).toString('utf8')); }
            catch { return { status: 'unresolved', code: 'ERR_INVALID_PACKAGE_CONFIG' }; }
            const entry = path.resolve(path.dirname(metadataFile), metadata.main || 'index.js');
            return exists(entry) ? { status: 'resolved', path: real(entry) } : { status: 'unresolved', code: 'MODULE_NOT_FOUND' };
          }
          return { status: 'unresolved', code: 'MODULE_NOT_FOUND' };
        } };
    },
  };
  dir('/');
  function pkg(directory, metadata, owner = null) {
    dir(directory, owner);
    put(directory + '/package.json', JSON.stringify(metadata), owner);
    put(directory + '/index.js', 'throw new Error("entrypoint must never execute");\n', owner);
  }
  pkg(appRoot, { name: 'gp-fixture', version: '1.0.0', dependencies: { client: '^2.7.0' } });
  pkg(client, { name: 'client', version: '2.7.0', peerDependencies: { encoding: '^0.1.0' }, peerDependenciesMeta: { encoding: { optional: true } } });
  pkg(encoding, { name: 'encoding', version: '0.1.13', dependencies: { 'iconv-lite': '^0.6.0' } }, 'node-encoding');
  pkg(iconv, { name: 'iconv-lite', version: '0.6.3', dependencies: { 'safer-buffer': '^2.1.2' } }, 'node-iconv-lite');
  pkg(safer, { name: 'safer-buffer', version: '2.1.2' }, 'node-safer-buffer');
  function packageFiles(directory) {
    const result = [];
    for (const entry of adapter.list(directory)) {
      if (entry === 'node_modules') continue;
      const name = path.join(directory, entry), value = nodes.get(name);
      if (value.type === 'directory') result.push(...packageFiles(name));
      else if (value.type === 'file') result.push({ path: path.relative(appRoot, name), bytes: value.bytes.length, sha256: sha(value.bytes) });
    }
    return result;
  }
  function baseline(extraPackages = []) {
    const rootBytes = adapter.read(appRoot + '/package.json');
    const packages = [client, ...extraPackages].map(directory => {
      const metadata = JSON.parse(adapter.read(directory + '/package.json').toString('utf8')), files = packageFiles(directory);
      return { name: metadata.name, version: metadata.version, path: path.relative(appRoot, directory), files, contentSha256: digest(files) };
    });
    const report = { format: 'grabenplaner-security-release-inventory', schemaVersion: 2, mode: 'installed',
      hostPolicy: { id: POLICY_ID, version: 1 },
      generatedAt: '2026-10-22T10:00:00.000Z',
      app: { name: 'gp-fixture', version: '1.0.0', sourceCommit: '1'.repeat(40) },
      inputs: { packageJson: { path: 'package.json', bytes: rootBytes.length, sha256: sha(rootBytes) } },
      installation: { packages, physicalOnly: true, edges: [] } };
    return { ...report, contentSha256: digest(report) };
  }
  const inventory = baseline();
  return { adapter, nodes, verified, forcedEntries, dir, put, link, pkg, baseline, inventory };
}
function run(f) { return observe({ root: appRoot, inventory: f.inventory, adapter: f.adapter }); }
function fails(f, code) { assert.throws(() => run(f), error => error.code === code); }

test('recursively inventories real fixture resolution, with immutable strict app baseline and explicit limits', linux, () => {
  const f = fixture(), result = run(f);
  assert.equal(result.externalPackages.length, 3);
  assert.equal(result.externalFiles.filter(item => item.type === 'file').length, 6);
  assert.equal(result.edges.length, 4);
  assert.deepEqual(result.dpkgPackages.map(item => item.owner), ['node-encoding', 'node-iconv-lite', 'node-safer-buffer']);
  assert.equal(result.baseline.packagesByteChecked, 1);
  assert.equal(result.baseline.packageFilesByteChecked, 2);
  assert.equal(result.edges.find(item => item.name === 'encoding').kind, 'os-dpkg');
  assert.equal(result.assurance.completeSystemSbom, false);
  assert.equal(result.assurance.runtimeExecutionTrace, false);
  assert.equal(result.assurance.actualDeclaredMetadataResolutionObserved, false);
  assert.equal(result.format, FORMAT);
  assert.equal(result.policy.id, POLICY_ID);
  assert.equal(result.generatedAt, f.inventory.generatedAt);
  const { contentSha256, ...body } = result;
  assert.equal(contentSha256, digest(body));
});

test('hashes a dpkg-owned symlink and its independently owned external target', linux, () => {
  const f = fixture();
  f.put(iconv + '/shared.js', 'module.exports = 1;\n', 'node-iconv-lite');
  f.link(encoding + '/shared.js', '../iconv-lite/shared.js', 'node-encoding');
  const result = run(f), link = result.externalFiles.find(item => item.path === encoding + '/shared.js');
  assert.equal(link.type, 'symlink');
  assert.equal(link.target, iconv + '/shared.js');
  assert.ok(result.externalFiles.find(item => item.path === iconv + '/shared.js').sha256);
});

test('preserves strict depth-first package file order for directory and sibling filename collisions', linux, () => {
  const f = fixture();
  f.put(client + '/a/b.js', 'nested');
  f.put(client + '/a.js', 'sibling');
  f.inventory = f.baseline();
  assert.equal(run(f).baseline.packageFilesByteChecked, 4);
});

test('records builtin precedence while retaining the declared npm package metadata graph', linux, () => {
  const f = fixture(), builtinPackage = appRoot + '/node_modules/string_decoder';
  f.pkg(builtinPackage, { name: 'string_decoder', version: '1.3.0' });
  f.put(client + '/package.json', JSON.stringify({ name: 'client', version: '2.7.0', dependencies: { string_decoder: '^1.3.0' },
    peerDependencies: { encoding: '^0.1.0' }, peerDependenciesMeta: { encoding: { optional: true } } }));
  f.inventory = f.baseline([builtinPackage]);
  const result = run(f), edge = result.edges.find(item => item.name === 'string_decoder');
  assert.equal(edge.builtinPrecedesDeclaredNpmPackage, true);
  assert.equal(edge.kind, 'app');
  assert.equal(edge.status, 'resolved');
});

test('retains a genuinely absent optional dependency without inventing host success', linux, () => {
  const f = fixture();
  for (const name of [...f.nodes.keys()]) if (name === encoding || name.startsWith(encoding + '/')) f.nodes.delete(name);
  const result = run(f);
  assert.equal(result.externalPackages.length, 0);
  assert.equal(result.edges.find(item => item.name === 'encoding').status, 'optional_not_installed');
});

test('rejects OS files missing dpkg ownership', linux, () => {
  const f = fixture(); f.nodes.get(encoding + '/index.js').owner = null; fails(f, 'HOST_DPKG_OWNER_MISSING');
});
test('rejects an OS package failing dpkg verification', linux, () => {
  const f = fixture(); f.adapter.verifyOwner = () => { throw Object.assign(new Error('synthetic mismatch'), { code: 'HOST_DPKG_VERIFY_MISMATCH' }); };
  fails(f, 'HOST_DPKG_VERIFY_MISMATCH');
});
test('rejects group-writable external files', linux, () => {
  const f = fixture(); f.nodes.get(encoding + '/index.js').mode = 0o664; fails(f, 'HOST_OS_UNSAFE_OWNERSHIP_OR_MODE');
});
test('rejects writable root ancestry even when the package itself is safe', linux, () => {
  const f = fixture(); f.nodes.get('/usr/share').mode = 0o777; fails(f, 'HOST_OS_UNSAFE_OWNERSHIP_OR_MODE');
});
test('rejects non-root-owned external files', linux, () => {
  const f = fixture(); f.nodes.get(encoding + '/index.js').uid = 252; fails(f, 'HOST_OS_UNSAFE_OWNERSHIP_OR_MODE');
});
test('rejects external package roots escaping fixed OS roots', linux, () => {
  const f = fixture();
  for (const name of [...f.nodes.keys()]) if (name === encoding || name.startsWith(encoding + '/')) f.nodes.delete(name);
  f.pkg('/tmp/untrusted-encoding', { name: 'encoding', version: '0.1.13' }, 'node-encoding');
  f.link(encoding, '/tmp/untrusted-encoding', 'node-encoding'); fails(f, 'HOST_RESOLUTION_UNAPPROVED_ROOT');
});
test('rejects package content symlinks escaping fixed OS roots', linux, () => {
  const f = fixture(); f.put('/tmp/escape.js', 'escape', 'node-encoding');
  f.link(encoding + '/escape.js', '/tmp/escape.js', 'node-encoding'); fails(f, 'HOST_OS_PATH_ESCAPE');
});
test('rejects missing required dependencies in the recursively observed OS closure', linux, () => {
  const f = fixture();
  for (const name of [...f.nodes.keys()]) if (name === safer || name.startsWith(safer + '/')) f.nodes.delete(name);
  fails(f, 'HOST_REQUIRED_DEPENDENCY_MISSING');
});
test('rejects malformed external package metadata', linux, () => {
  const f = fixture(); f.put(encoding + '/package.json', '{bad', 'node-encoding'); fails(f, 'HOST_PACKAGE_METADATA_INVALID');
});
test('rejects malformed dependency declarations', linux, () => {
  const f = fixture(); f.put(encoding + '/package.json', JSON.stringify({ name: 'encoding', version: '0.1.13', dependencies: [] }), 'node-encoding');
  fails(f, 'HOST_DEPENDENCY_METADATA_INVALID');
});
test('rejects app bytes changed after the strict inventory', linux, () => {
  const f = fixture(); f.put(client + '/index.js', 'tampered'); fails(f, 'HOST_APP_CONTENT_MISMATCH');
});
test('rejects app files absent from the strict package inventory', linux, () => {
  const f = fixture(); f.put(client + '/unrecorded.js', 'extra'); fails(f, 'HOST_APP_CONTENT_MISMATCH');
});
test('requires a physical-only baseline instead of silently trusting an isolated graph', linux, () => {
  const f = fixture(); f.inventory.installation.physicalOnly = false;
  const { contentSha256, ...body } = f.inventory; f.inventory.contentSha256 = digest(body);
  fails(f, 'HOST_BASELINE_INVALID');
});
test('rejects malformed baseline document hashes before observing the graph', linux, () => {
  const f = fixture(); f.inventory.app.version = '9.9.9'; fails(f, 'HOST_BASELINE_DOCUMENT_CHANGED');
});
test('rejects an unclassified loose file shadowing a package entrypoint', linux, () => {
  const f = fixture(); f.put(osRoot + '/encoding.js', 'unclassified shadow', 'node-encoding'); fails(f, 'HOST_ENTRYPOINT_PATH_ESCAPE');
});
test('rejects package metadata resolving to a different root than metadata lookup', linux, () => {
  const f = fixture(), original = f.adapter.lookup;
  f.adapter.lookup = (from, name) => {
    const lookup = original(from, name), resolve = lookup.resolve;
    lookup.resolve = specifier => specifier === 'encoding/package.json' ? { status: 'resolved', path: iconv + '/package.json' } : resolve(specifier);
    return lookup;
  };
  fails(f, 'HOST_METADATA_RESOLUTION_MISMATCH');
});
test('rejects same-length external tampering during a metadata-only read', linux, () => {
  const f = fixture(), read = f.adapter.read;
  let changed = false;
  f.adapter.read = file => {
    const bytes = read(file);
    if (file === encoding + '/index.js' && !changed) { changed = true; f.put(file, Buffer.alloc(bytes.length, 88), 'node-encoding'); }
    return bytes;
  };
  fails(f, 'HOST_FILE_CHANGED');
});
test('rejects arbitrary replacement adapters and never accepts caller-supplied OS root lists', linux, () => {
  const f = fixture(); f.adapter.kind = 'caller-trusted'; fails(f, 'HOST_ADAPTER_INVALID');
});

const aliasRoot = '/usr/share/node_modules';
function aliasFixture() {
  const f = fixture(), owners = f.adapter.owners;
  f.link(aliasRoot, 'nodejs', 'nodejs');
  f.ownershipQueries = [];
  f.adapter.owners = file => {
    f.ownershipQueries.push(file);
    // Model dpkg's exact path spelling: descendants of the alias are not in
    // its file database. Only the alias link itself and canonical files are.
    if (file.startsWith(aliasRoot + '/')) return [];
    return owners(file);
  };
  return f;
}

test('accepts only the exact dpkg-nodejs-owned lookup alias and canonicalizes all descendant ownership queries', linux, () => {
  const f = aliasFixture(), result = run(f);
  assert.equal(result.externalAliases.length, 1);
  const alias = result.externalAliases[0];
  assert.equal(alias.path, aliasRoot);
  assert.equal(alias.linkText, 'nodejs');
  assert.equal(alias.linkTextSha256, sha('nodejs'));
  assert.equal(alias.target, '/usr/share/nodejs');
  assert.deepEqual(alias.owners, ['nodejs']);
  assert.equal(alias.metadata.uid, 0);
  assert.equal(alias.canonicalDescendantOwnershipRequired, true);
  assert.equal(result.externalPackages.length, 3);
  assert.deepEqual(result.dpkgPackages.map(item => item.owner), ['node-encoding', 'node-iconv-lite', 'node-safer-buffer', 'nodejs']);
  assert.equal(result.edges.find(edge => edge.name === 'iconv-lite').lexicalMetadata, aliasRoot + '/iconv-lite/package.json');
  assert.ok(f.ownershipQueries.includes(aliasRoot));
  assert.ok(f.ownershipQueries.includes(iconv + '/package.json'));
  assert.equal(f.ownershipQueries.some(file => file.startsWith(aliasRoot + '/')), false);
  assert.equal(result.policy.fixedOsRoots.includes(aliasRoot), false);
  assert.equal(result.policy.arbitraryLookupAliasAllowed, false);
  assert.equal(result.assurance.serviceContextIndependentlyVerified, false);
});

test('rejects an equivalent absolute link target instead of the exact nodejs spelling', linux, () => {
  const f = aliasFixture(); f.nodes.get(aliasRoot).target = '/usr/share/nodejs'; fails(f, 'HOST_OS_ALIAS_INVALID');
});
test('rejects dot-segment spelling even when it resolves to the expected alias target', linux, () => {
  const f = aliasFixture(); f.nodes.get(aliasRoot).target = '../share/nodejs'; fails(f, 'HOST_OS_ALIAS_INVALID');
});
test('rejects an alias targeting another OS directory', linux, () => {
  const f = aliasFixture(); f.dir('/usr/share/other-nodejs', 'nodejs'); f.nodes.get(aliasRoot).target = 'other-nodejs';
  fails(f, 'HOST_OS_ALIAS_INVALID');
});
test('rejects a physical alias directory even when root-owned and attributed to nodejs', linux, () => {
  const f = aliasFixture(); f.nodes.delete(aliasRoot); f.dir(aliasRoot, 'nodejs'); fails(f, 'HOST_OS_ALIAS_INVALID');
});
test('rejects a non-root-owned alias link', linux, () => {
  const f = aliasFixture(); f.nodes.get(aliasRoot).uid = 353; fails(f, 'HOST_OS_ALIAS_INVALID');
});
test('rejects an alias with the wrong dpkg package owner', linux, () => {
  const f = aliasFixture(); f.nodes.get(aliasRoot).owner = 'node-unrelated'; fails(f, 'HOST_OS_ALIAS_DPKG_OWNER_INVALID');
});
test('rejects an alias without any dpkg owner', linux, () => {
  const f = aliasFixture(); f.nodes.get(aliasRoot).owner = null; fails(f, 'HOST_OS_ALIAS_DPKG_OWNER_INVALID');
});
test('rejects an alias jointly attributed to nodejs and an unexpected package', linux, () => {
  const f = aliasFixture(), owners = f.adapter.owners;
  f.adapter.owners = file => file === aliasRoot ? ['nodejs', 'node-unrelated'] : owners(file);
  fails(f, 'HOST_OS_ALIAS_DPKG_OWNER_INVALID');
});
test('requires clean dpkg verification of the alias-owning nodejs package', linux, () => {
  const f = aliasFixture(), verifyOwner = f.adapter.verifyOwner;
  f.adapter.verifyOwner = owner => {
    if (owner === 'nodejs') throw Object.assign(new Error('synthetic nodejs mismatch'), { code: 'HOST_DPKG_VERIFY_MISMATCH' });
    return verifyOwner(owner);
  };
  fails(f, 'HOST_DPKG_VERIFY_MISMATCH');
});
test('rejects writable alias ancestry', linux, () => {
  const f = aliasFixture(); f.nodes.get('/usr/share').mode = 0o775; fails(f, 'HOST_OS_UNSAFE_OWNERSHIP_OR_MODE');
});
test('rejects lookup-root traversal before normalization can disguise its spelling', linux, () => {
  const f = aliasFixture(), lookup = f.adapter.lookup;
  f.adapter.lookup = (from, name) => {
    const result = lookup(from, name);
    if (from === encoding) result.metadataRoots.unshift(aliasRoot + '/../node_modules');
    return result;
  };
  fails(f, 'HOST_LOOKUP_ROOT_INVALID');
});
test('does not let the valid alias authorize a descendant package escape', linux, () => {
  const f = aliasFixture();
  for (const name of [...f.nodes.keys()]) if (name === iconv || name.startsWith(iconv + '/')) f.nodes.delete(name);
  f.pkg('/tmp/untrusted-iconv', { name: 'iconv-lite', version: '0.6.3' }, 'node-iconv-lite');
  f.link(iconv, '/tmp/untrusted-iconv', 'node-iconv-lite');
  fails(f, 'HOST_RESOLUTION_UNAPPROVED_ROOT');
});
test('rejects a loose entrypoint shadow reached through the valid alias', linux, () => {
  const f = aliasFixture(); f.put(osRoot + '/iconv-lite.js', 'unclassified alias shadow', 'node-iconv-lite');
  fails(f, 'HOST_ENTRYPOINT_PATH_ESCAPE');
});
test('does not accept another root-owned nodejs-owned alias as an additional trusted tree', linux, () => {
  const f = aliasFixture(), lookup = f.adapter.lookup, otherAlias = '/usr/share/vendor_node_modules';
  f.link(otherAlias, 'nodejs', 'nodejs');
  f.adapter.lookup = (from, name) => {
    const result = lookup(from, name);
    if (from === encoding) result.metadataRoots.unshift(otherAlias);
    return result;
  };
  fails(f, 'HOST_OS_PATH_ESCAPE');
});

for (const [label, mutate] of [
  ['removed', f => f.nodes.delete(aliasRoot)],
  ['retargeted', f => { f.nodes.get(aliasRoot).target = '/usr/share/nodejs'; }],
  ['replaced by a new identical link', f => f.link(aliasRoot, 'nodejs', 'nodejs')],
  ['replaced by a directory', f => { f.nodes.delete(aliasRoot); f.dir(aliasRoot, 'nodejs'); }],
  ['reassigned to a different dpkg package', f => { f.nodes.get(aliasRoot).owner = 'node-unrelated'; }],
]) {
  test('detects the proved alias being ' + label + ' during the final app metadata read', linux, () => {
    const f = aliasFixture(), read = f.adapter.read;
    let rootReads = 0;
    f.adapter.read = file => {
      const bytes = read(file);
      if (file === appRoot + '/package.json' && ++rootReads === 3) mutate(f);
      return bytes;
    };
    fails(f, 'HOST_OS_ALIAS_CHANGED');
  });
}

function rehash(f) {
  const { contentSha256, ...body } = f.inventory;
  f.inventory.contentSha256 = digest(body);
}

test('native host output has a deterministic timestamp and content hash', linux, () => {
  const f = fixture();
  assert.deepEqual(run(f), run(f));
  const observed = observe({ root: appRoot, inventory: f.inventory, adapter: f.adapter, createdAt: '2026-10-23T01:00:00Z' });
  assert.equal(observed.generatedAt, '2026-10-23T01:00:00.000Z');
});

test('rejects a missing timestamp instead of introducing verification-time drift', linux, () => {
  const f = fixture(); delete f.inventory.generatedAt; rehash(f);
  fails(f, 'HOST_CREATED_AT_INVALID');
});

test('requires the native schema and exact versioned host policy', linux, () => {
  for (const mutate of [
    f => { f.inventory.schemaVersion = 1; },
    f => { delete f.inventory.hostPolicy; },
    f => { f.inventory.hostPolicy.id = 'caller-roots'; },
    f => { f.inventory.hostPolicy.version = 2; },
  ]) {
    const f = fixture(); mutate(f); rehash(f); fails(f, 'HOST_BASELINE_INVALID');
  }
});

test('rejects a prepopulated graph masquerading as a physical-only observation', linux, () => {
  const f = fixture(); f.inventory.installation.edges.push({ name: 'encoding', status: 'optional_not_installed' }); rehash(f);
  fails(f, 'HOST_BASELINE_INVALID');
});

test('accepts a required host dependency directly declared by the app', linux, () => {
  const f = fixture();
  f.put(appRoot + '/package.json', JSON.stringify({ name: 'gp-fixture', version: '1.0.0', dependencies: { client: '^2.7.0', encoding: '^0.1.0' } }));
  f.inventory = f.baseline();
  const edge = run(f).edges.find(item => item.from === appRoot && item.name === 'encoding');
  assert.equal(edge.kind, 'os-dpkg');
  assert.equal(edge.optional, false);
  assert.equal(edge.status, 'resolved');
});

test('recursively resolves a cyclic declared OS graph without hiding or infinitely repeating edges', linux, () => {
  const f = fixture();
  f.put(safer + '/package.json', JSON.stringify({ name: 'safer-buffer', version: '2.1.2', dependencies: { encoding: '^0.1.0' } }), 'node-safer-buffer');
  const result = run(f);
  assert.equal(result.externalPackages.length, 3);
  assert.equal(result.edges.length, 5);
  assert.ok(result.edges.some(edge => edge.from === safer && edge.target === encoding));
});

test('rejects a dpkg package database changing between the beginning and end of observation', linux, () => {
  const f = fixture(), verify = f.adapter.verifyOwner, calls = new Map();
  f.adapter.verifyOwner = owner => {
    const count = (calls.get(owner) || 0) + 1; calls.set(owner, count);
    const value = verify(owner);
    return count > 1 && owner === 'node-encoding' ? { ...value, version: '2.0-1' } : value;
  };
  fails(f, 'HOST_DPKG_DATABASE_CHANGED');
});

test('rejects path segments masquerading as declared package names', linux, () => {
  for (const name of ['.', '..', '@scope/.', '@scope/..']) {
    const f = fixture();
    f.put(encoding + '/package.json', JSON.stringify({ name: 'encoding', version: '0.1.13', dependencies: { [name]: '1.0.0' } }), 'node-encoding');
    fails(f, 'HOST_DEPENDENCY_METADATA_INVALID');
  }
});

test('rejects a loose JSON entrypoint shadow independently of matching metadata', linux, () => {
  const f = fixture(); f.put(osRoot + '/encoding.json', '{}', 'node-encoding');
  f.forcedEntries.set(client + '\0encoding', osRoot + '/encoding.json');
  fails(f, 'HOST_ENTRYPOINT_PATH_ESCAPE');
});

test('keeps package-export restrictions explicit without executing entrypoints to infer them', linux, () => {
  const f = fixture(), original = f.adapter.lookup;
  f.adapter.lookup = (from, name) => {
    const lookup = original(from, name), resolve = lookup.resolve;
    lookup.resolve = specifier => specifier === 'encoding/package.json' ?
      { status: 'unresolved', code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' } : resolve(specifier);
    return lookup;
  };
  const edge = run(f).edges.find(item => item.name === 'encoding');
  assert.equal(edge.kind, 'os-dpkg');
  assert.equal(edge.packageJsonRequireResolve.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  assert.equal(edge.entrypointRequireResolve.status, 'resolved');
});

test('rejects an external special file instead of treating it as package content', linux, () => {
  const f = fixture(); f.nodes.get(encoding + '/index.js').type = 'fifo';
  fails(f, 'HOST_OS_FILE_INVALID');
});

test('enforces the per-file byte bound before reading external content', linux, () => {
  const f = fixture(); f.nodes.get(encoding + '/index.js').size = 128 * 1024 * 1024 + 1;
  fails(f, 'HOST_FILE_INVALID');
});

test('discovers the host binary-package name independently of the npm safer-buffer name', linux, () => {
  const f = aliasFixture();
  for (const [name, node] of f.nodes) if (name === safer || name.startsWith(safer + '/')) node.owner = 'node-safe-buffer';
  const result = run(f);
  assert.ok(result.externalPackages.some(item => item.name === 'safer-buffer' && item.owners.includes('node-safe-buffer')));
  assert.ok(result.dpkgPackages.some(item => item.owner === 'node-safe-buffer'));
});
