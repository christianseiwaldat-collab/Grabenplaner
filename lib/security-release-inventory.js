'use strict';

// Offline evidence about one source tree / one installed runtime. This is not
// an authenticity signature, a vulnerability scan, or a complete system SBOM.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const hostInventory = require('./security-release-host-inventory');
const { canvasNativeInventory } = require('./security-native-canvas-inventory');
const FORMAT = 'grabenplaner-security-release-inventory';
const SOURCE_INVENTORY = 'lib/security-release-inventory.source.json';
const PACKAGE_MANIFEST = 'grabenplaner-server-manifest.json';
const sourceDirectories = ['lib', 'public', 'server-tools', 'services'];
const sourceFiles = ['server.js', 'backup.js', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'SECURITY.md', 'SERVERBETRIEB.md', 'scripts/security-release-inventory.js',
  'scripts/run-background-backup.js', 'scripts/manage-local-backup-archive.js'];
const vendorRoutes = [
  ['/vendor/quill', 'quill', 'dist'], ['/vendor/zxing-browser-v0.2.1', '@zxing/browser', 'umd'],
  ['/vendor/tesseract-v7', 'tesseract.js', 'dist'], ['/vendor/tesseract-core-v7', 'tesseract.js-core', '.'],
  ['/vendor/tesseract-data-deu-v1', '@tesseract.js-data/deu', '4.0.0_best_int'],
  ...['build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].map(part => ['/vendor/pdfjs-v6.2.108/' + part, 'pdfjs-dist', part]),
];
const operatingTools = [
  ['caddy', 'caddy', ['version']], ['systemd', 'systemctl', ['--version']],
  ['postgresql-client', 'psql', ['--version']], ['pg-dump', 'pg_dump', ['--version']],
  ['pg-restore', 'pg_restore', ['--version']], ['rclone', 'rclone', ['version']],
  ['clamav', 'clamscan', ['--version']], ['openssl', 'openssl', ['version']],
  ['python', 'python3', ['--version']], ['ssh-client', 'ssh', ['-V']],
];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const canonical = value => JSON.stringify(stable(value));
const digest = value => sha(canonical(value));
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fail(code, detail = '') { throw Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code }); }
function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
function regular(root, file) {
  if (!within(root, path.resolve(file)) || !within(root, fs.realpathSync.native(file))) fail('INVENTORY_PATH_ESCAPE');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVENTORY_FILE_INVALID', relative(root, file));
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (stat.size !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) fail('INVENTORY_FILE_CHANGED');
  return { path: relative(root, file), bytes: bytes.length, sha256: sha(bytes) };
}
function walk(root, directory, { omitNodeModules = false } = {}) {
  if (!fs.existsSync(directory)) return [];
  if (!within(root, fs.realpathSync.native(directory)) || fs.lstatSync(directory).isSymbolicLink()) fail('INVENTORY_PATH_ESCAPE');
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))) {
    if (omitNodeModules && entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('INVENTORY_CONTENT_LINK', relative(root, file));
    if (entry.isDirectory()) result.push(...walk(root, file, { omitNodeModules }));
    else if (entry.isFile()) result.push(regular(root, file));
    else fail('INVENTORY_FILE_INVALID', relative(root, file));
  }
  return result;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function sourceSnapshot(root) {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) if (!fs.existsSync(path.join(root, file))) fail('INVENTORY_SOURCE_MISSING', file);
  const files = [...sourceDirectories.flatMap(name => walk(root, path.join(root, name))),
    ...sourceFiles.filter(name => fs.existsSync(path.join(root, name))).map(name => regular(root, path.join(root, name)))]
    .filter(file => file.path !== SOURCE_INVENTORY).sort((a, b) => ordinal(a.path, b.path));
  if (files.some(file => /(^|\/)\.env($|\.)|\.(?:db|sqlite|sqlite3|p12|pfx|key|pem)$/i.test(file.path))) fail('INVENTORY_PRIVATE_SOURCE_REJECTED');
  const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  for (const match of workspace.matchAll(/^\s+[^\r\n:]+:\s+(lib\/vendor-patches\/[^\r\n]+\.patch)\s*$/gm)) {
    if (!files.some(file => file.path === match[1])) fail('INVENTORY_PATCH_MISSING', match[1]);
  }
  return { selection: { directories: sourceDirectories, files: sourceFiles, explicitlyExcluded: [SOURCE_INVENTORY, PACKAGE_MANIFEST] },
    files, sha256: digest(files) };
}
function resolvePackage(root, from, name) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) fail('INVENTORY_PACKAGE_NAME_INVALID');
  const loader = createRequire(path.join(from, 'package.json'));
  // Built-in names such as string_decoder can also name declared npm packages.
  // Inspect package lookup roots without requiring its executable entrypoint.
  for (const directory of loader.resolve.paths('gp-inventory-package-lookup') || []) {
    const candidate = path.join(directory, ...name.split('/'), 'package.json');
    if (!fs.existsSync(candidate)) continue;
    const actual = fs.realpathSync.native(path.dirname(candidate));
    if (!within(path.join(root, 'node_modules'), actual)) fail('INVENTORY_DEPENDENCY_ESCAPE', name);
    return actual;
  }
  return null;
}
function installedSnapshot(root, metadata, { physicalOnly = false } = {}) {
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules) || fs.lstatSync(modules).isSymbolicLink()) fail('INVENTORY_INSTALLATION_MISSING');
  const roots = new Set(), visitedModuleDirectories = new Set(), moduleDirectoryFiles = [], unclassifiedDirectories = [];
  function moduleFile(file) {
    if (fs.lstatSync(file).isSymbolicLink()) {
      const target = fs.realpathSync.native(file);
      if (!within(modules, target)) fail('INVENTORY_DEPENDENCY_ESCAPE');
      moduleDirectoryFiles.push({ path: relative(root, file), linkTarget: relative(root, target), target: regular(root, target) });
    } else moduleDirectoryFiles.push(regular(root, file));
  }
  function packageRoot(candidate) {
    const actual = fs.realpathSync.native(candidate);
    if (!within(modules, actual)) fail('INVENTORY_DEPENDENCY_ESCAPE');
    if (roots.has(actual)) return;
    if (!fs.existsSync(path.join(actual, 'package.json'))) {
      unclassifiedDirectories.push({ path: relative(root, actual), files: walk(root, actual, { omitNodeModules: true }) });
      scan(path.join(actual, 'node_modules'));
      return;
    }
    roots.add(actual); scan(path.join(actual, 'node_modules'));
  }
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    const actual = fs.realpathSync.native(directory);
    if (!within(modules, actual)) fail('INVENTORY_DEPENDENCY_ESCAPE');
    if (visitedModuleDirectories.has(actual)) return; visitedModuleDirectories.add(actual);
    for (const entry of fs.readdirSync(actual, { withFileTypes: true })) {
      if (entry.name === '.pnpm') {
        for (const child of fs.readdirSync(path.join(actual, entry.name), { withFileTypes: true })) {
          if (child.isDirectory()) scan(child.name === 'node_modules' ? path.join(actual, entry.name, child.name) : path.join(actual, entry.name, child.name, 'node_modules'));
          else moduleFile(path.join(actual, entry.name, child.name));
        }
      } else if (entry.name === '.bin' && entry.isDirectory()) {
        for (const child of fs.readdirSync(path.join(actual, entry.name))) moduleFile(path.join(actual, entry.name, child));
      } else if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const child of fs.readdirSync(path.join(actual, entry.name), { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) packageRoot(path.join(actual, entry.name, child.name));
          else moduleFile(path.join(actual, entry.name, child.name));
        }
      } else if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) packageRoot(path.join(actual, entry.name));
      else if (entry.isFile()) moduleFile(path.join(actual, entry.name));
      else if (entry.isSymbolicLink()) fail('INVENTORY_CONTENT_LINK');
    }
  }
  scan(modules);
  const reachable = new Set(), edges = [], queue = physicalOnly ? [] : [[root, metadata]];
  while (queue.length) {
    const [from, manifest] = queue.shift();
    const declared = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, range] of Object.entries(declared).sort()) {
      const optional = Object.hasOwn(manifest.optionalDependencies || {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true;
      const target = resolvePackage(root, from, name);
      if (!target && !optional) fail('INVENTORY_REQUIRED_DEPENDENCY_MISSING', name);
      edges.push({ from: from === root ? '.' : relative(root, from), name, range, optional,
        target: target ? relative(root, target) : null, status: target ? 'resolved' : 'optional_not_installed' });
      if (target && !reachable.has(target)) { reachable.add(target); roots.add(target); queue.push([target, json(path.join(target, 'package.json'))]); }
    }
  }
  const packages = [...roots].sort().map(directory => {
    const manifest = json(path.join(directory, 'package.json'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') fail('INVENTORY_PACKAGE_METADATA_INVALID');
    const files = walk(root, directory, { omitNodeModules: true });
    return { name: manifest.name, version: manifest.version, path: relative(root, directory),
      purl: 'pkg:npm/' + (manifest.name.startsWith('@') ? '%40' + manifest.name.slice(1) : manifest.name) + '@' + encodeURIComponent(manifest.version),
      license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type || null,
      status: physicalOnly ? 'physical_only' : reachable.has(directory) ? 'reachable' : 'present_not_reachable', files, contentSha256: digest(files) };
  });
  moduleDirectoryFiles.sort((a, b) => ordinal(a.path, b.path));
  unclassifiedDirectories.sort((a, b) => ordinal(a.path, b.path));
  return { scope: physicalOnly ? 'Strict physical application-package byte inventory; actual declared resolution is recorded separately in hostResolution' : 'Physical npm packages plus runtime dependency resolution; inactive store remnants are explicitly distinct',
    resolutionScope: physicalOnly ? 'No absence or reachability assertion from this physical snapshot' : 'Declared package dependencies, not a trace of conditional exports or every executed module',
    ...(physicalOnly ? { physicalOnly: true } : {}),
    packages, edges, moduleDirectoryFiles, unclassifiedDirectories, reachableCount: physicalOnly ? null : packages.filter(item => item.status === 'reachable').length,
    inactiveCount: physicalOnly ? null : packages.filter(item => item.status !== 'reachable').length, sha256: digest({ packages, edges, moduleDirectoryFiles, unclassifiedDirectories }) };
}
function commandVersion(command, args, timeout = 5000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024,
    env: { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
  if (result.error) return { status: result.error.code === 'ENOENT' ? 'unavailable' : 'error', version: null, error: result.error.code || 'EXECUTION_FAILED' };
  if (result.status !== 0) return { status: 'error', version: null, exitCode: result.status };
  return { status: 'observed', version: String(result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 1024) };
}
function runtimeSnapshot({ pnpmCli } = {}) {
  const pnpm = pnpmCli ? commandVersion(process.execPath, [path.resolve(pnpmCli), '--version'], 15000) : commandVersion('pnpm', ['--version'], 15000);
  return { scope: 'This process host only; does not describe an unobserved deployment host',
    node: { version: process.version, executableSha256: sha(fs.readFileSync(process.execPath)), components: { ...process.versions } }, pnpm,
    os: { platform: process.platform, architecture: process.arch, kernelRelease: os.release(),
      release: process.platform === 'linux' && fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : null },
    tools: operatingTools.map(([id, command, args]) => ({ id, command, ...commandVersion(command, args) })) };
}
function nativeWorker(root) {
  const loader = createRequire(path.join(root, 'package.json'));
  const components = { sqlite: { version: process.versions.sqlite || null, source: 'Node built-in runtime version' } };
  function loadBound(fromLoader, name, packageRoot) {
    if (!within(packageRoot, fs.realpathSync.native(fromLoader.resolve(name)))) fail('INVENTORY_NATIVE_ENTRYPOINT_MISMATCH');
    return fromLoader(name);
  }
  const sharpRoot = resolvePackage(root, root, 'sharp');
  if (sharpRoot) components.sharp = { ...loadBound(loader, 'sharp', sharpRoot).versions };
  const pdfjs = resolvePackage(root, root, 'pdfjs-dist');
  if (pdfjs) {
    const canvasRoot = resolvePackage(root, pdfjs, '@napi-rs/canvas');
    if (!canvasRoot) fail('INVENTORY_CANVAS_MISSING');
    loadBound(createRequire(path.join(pdfjs, 'package.json')), '@napi-rs/canvas', canvasRoot);
    const canvasVersion = json(path.join(canvasRoot, 'package.json')).version;
    const embedded = canvasNativeInventory({ applicationRoot: root, canvasRoot,
      loadedBindings: Object.keys(require.cache).filter(file => file.endsWith('.node')),
      libc: process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl') : null });
    components.canvas = { version: canvasVersion,
      embeddedLibraries: embedded.status === 'unknown' ? 'Package binary bytes inventoried; unreported internal library versions remain unknown' : embedded };
  }
  const bindings = Object.keys(require.cache).filter(file => file.endsWith('.node')).map(file => regular(root, file));
  return { status: 'observed', platform: process.platform, architecture: process.arch, components, loadedBindings: bindings.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}
function observeNative(root) {
  const result = spawnSync(process.execPath, [__filename, '--native-worker', root], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('INVENTORY_NATIVE_PROBE_FAILED', String(result.error?.code || result.stderr).slice(0, 600));
  return JSON.parse(result.stdout);
}
function binding(root, filename) { return fs.existsSync(path.join(root, filename)) ? regular(root, path.join(root, filename)) : null; }
function releaseBinding(root, metadata) {
  const packageManifest = binding(root, PACKAGE_MANIFEST), sourceInventory = binding(root, SOURCE_INVENTORY);
  if (packageManifest) {
    if (!sourceInventory) fail('INVENTORY_RELEASE_SOURCE_MISSING');
    const manifest = json(path.join(root, PACKAGE_MANIFEST)), seen = new Set();
    if (manifest.format !== 'grabenplaner-server-package' || manifest.schemaVersion !== 1 || manifest.appVersion !== metadata.version || !Array.isArray(manifest.files)) fail('INVENTORY_RELEASE_MANIFEST_INVALID');
    for (const entry of manifest.files) {
      if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(entry.path) || seen.has(entry.path)) fail('INVENTORY_RELEASE_PATH_INVALID');
      seen.add(entry.path);
      if (canonical(regular(root, path.resolve(root, entry.path))) !== canonical(entry)) fail('INVENTORY_RELEASE_HASH_MISMATCH', entry.path);
    }
    if (!seen.has(SOURCE_INVENTORY)) fail('INVENTORY_RELEASE_SOURCE_UNBOUND');
    const source = json(path.join(root, SOURCE_INVENTORY));
    if (source.mode !== 'source' || source.app?.sourceCommit !== manifest.sourceCommit) fail('INVENTORY_RELEASE_IDENTITY_MISMATCH');
  }
  return { packageManifest, sourceInventory, status: packageManifest ? 'Bound to locally verified package manifest bytes; authenticity requires trusted external verification' : 'Checkout observation; no package or deployed release identity asserted' };
}
function baseInventory(root, options = {}) {
  const mode = options.mode || 'installed';
  if (!['source', 'installed'].includes(mode)) fail('INVENTORY_MODE_INVALID');
  if (options.hostPolicy !== undefined && options.hostPolicy !== hostInventory.POLICY_ID) fail('INVENTORY_HOST_POLICY_INVALID');
  if (options.hostPolicy && mode !== 'installed') fail('INVENTORY_HOST_POLICY_MODE_INVALID');
  if (options.hostPolicy && process.platform !== 'linux') fail('INVENTORY_HOST_LINUX_REQUIRED');
  root = fs.realpathSync.native(path.resolve(root));
  const metadata = json(path.join(root, 'package.json'));
  const source = sourceSnapshot(root);
  const commit = options.sourceCommit || null;
  if (commit !== null && !/^[a-f0-9]{40}$/i.test(commit)) fail('INVENTORY_COMMIT_INVALID');
  const generatedAt = new Date(options.createdAt || Date.now()).toISOString();
  const installation = mode === 'installed' ? installedSnapshot(root, metadata, { physicalOnly: Boolean(options.hostPolicy) }) : null;
  const server = fs.existsSync(path.join(root, 'server.js')) ? fs.readFileSync(path.join(root, 'server.js'), 'utf8') : '';
  const vendored = vendorRoutes.filter(([route]) => server.includes(route)).map(([route, name, subdirectory]) => {
    const packageRoot = installation ? resolvePackage(root, root, name) || installation.packages.find(item => item.name === name && item.status === 'reachable')?.path : null;
    const directory = packageRoot && (path.isAbsolute(packageRoot) ? packageRoot : path.join(root, packageRoot));
    if (installation && (!directory || !fs.existsSync(path.join(directory, subdirectory)))) fail('INVENTORY_VENDOR_MISSING', route);
    return { route, package: name, directory: subdirectory,
      version: directory ? json(path.join(directory, 'package.json')).version : null,
      status: directory ? 'installed_and_hashed' : 'declared_source_route_requires_installation',
      packagePath: directory ? relative(root, directory) : null };
  });
  const knownRoutes = vendorRoutes.map(row => row[0]);
  for (const match of server.matchAll(/app\.use\(\s*["'](\/vendor\/[^"']+)["']/g)) if (!knownRoutes.includes(match[1])) fail('INVENTORY_VENDOR_ROUTE_UNCLASSIFIED', match[1]);
  const fonts = source.files.filter(file => /^public\/fonts\//.test(file.path));
  return { format: FORMAT, schemaVersion: options.hostPolicy ? 2 : 1, mode, generatedAt, app: { name: metadata.name, version: metadata.version, sourceCommit: commit },
    ...(options.hostPolicy ? { hostPolicy: { id: hostInventory.POLICY_ID, version: 1 },
      inventoryImplementation: { library: regular(__dirname, __filename),
        hostPolicyLibrary: regular(__dirname, require.resolve('./security-release-host-inventory')) } } : {}),
    assurance: { authenticity: 'Not signed by this generator; trust must come from the enclosing verified release/CI artifact',
      completeSystemSbom: false, vulnerabilityAssessment: false, deployedStateProven: false },
    source, inputs: { packageJson: binding(root, 'package.json'), lockfile: binding(root, 'pnpm-lock.yaml'), workspacePolicy: binding(root, 'pnpm-workspace.yaml'),
      localPatches: source.files.filter(file => file.path.startsWith('lib/vendor-patches/')), pythonRequirements: binding(root, 'services/planning-optimizer/requirements.txt') },
    releaseBinding: mode === 'installed' ? releaseBinding(root, metadata) : null,
    requirements: { target: { platform: 'linux', architecture: 'x64', node: metadata.engines?.node || null, packageManager: metadata.packageManager || null },
      operatingTools: operatingTools.map(([id, command]) => ({ id, command, version: null, status: 'Requires observation on the actual installation host' })),
      pythonEnvironment: 'If planning optimizer is enabled, separately retain installed Python distribution inventory; requirements hash alone is not an installed dependency inventory' },
    vendored: { browserRoutes: vendored, publicFonts: { files: fonts, provenance: binding(root, 'public/fonts/price-labels/assets.json'), versionStatus: 'Use per-file hashes and existing provenance; unreported upstream versions remain unknown' } },
    installation, observedRuntime: mode === 'installed' ? runtimeSnapshot(options) : null };
}
function generate(root, options = {}) {
  if ((options.mode || 'installed') === 'installed' && fs.existsSync(path.join(root, SOURCE_INVENTORY))) {
    const { hostPolicy, ...sourceOptions } = options;
    verify(root, json(path.join(root, SOURCE_INVENTORY)), sourceOptions);
  }
  const report = baseInventory(root, options);
  if (report.hostPolicy) report.hostResolution = hostInventory.observe({ root, inventory: { ...report, contentSha256: digest(report) } });
  report.native = report.mode === 'installed' ? observeNative(path.resolve(root)) : null;
  return { ...report, contentSha256: digest(report) };
}
function verify(root, report, options = {}) {
  if (!report || report.format !== FORMAT || ![1, 2].includes(report.schemaVersion) || !/^[0-9a-f]{64}$/.test(report.contentSha256 || '')) fail('INVENTORY_FORMAT_INVALID');
  if (report.schemaVersion === 2 && (report.mode !== 'installed' || canonical(report.hostPolicy) !== canonical({ id: hostInventory.POLICY_ID, version: 1 }) || !report.hostResolution)) fail('INVENTORY_HOST_POLICY_INVALID');
  if (report.schemaVersion === 1 && (report.hostPolicy !== undefined || report.hostResolution !== undefined)) fail('INVENTORY_HOST_POLICY_INVALID');
  const hostPolicy = report.schemaVersion === 2 ? hostInventory.POLICY_ID : undefined;
  if (options.hostPolicy !== undefined && options.hostPolicy !== hostPolicy) fail('INVENTORY_HOST_POLICY_MISMATCH');
  const { contentSha256, ...body } = report;
  if (digest(body) !== contentSha256) fail('INVENTORY_DOCUMENT_CHANGED');
  const current = baseInventory(root, { ...options, hostPolicy, mode: report.mode, sourceCommit: report.app?.sourceCommit, createdAt: report.generatedAt });
  // First compare all known bytes/resolution/runtime inputs. Never load changed
  // native packages merely to discover that their recorded hashes were wrong.
  if (canonical({ ...current, ...(hostPolicy ? { hostResolution: report.hostResolution } : {}), native: report.native }) !== canonical(body)) fail('INVENTORY_CONTENT_MISMATCH');
  if (hostPolicy) {
    const observed = hostInventory.observe({ root, inventory: { ...current, contentSha256: digest(current) } });
    if (canonical(observed) !== canonical(report.hostResolution)) fail('INVENTORY_HOST_CONTENT_MISMATCH');
  }
  if (report.mode === 'installed' && canonical(observeNative(path.resolve(root))) !== canonical(report.native)) fail('INVENTORY_NATIVE_MISMATCH');
  return { verified: true, mode: report.mode, appVersion: report.app.version, contentSha256 };
}
function cli(args = process.argv.slice(2)) {
  const [action, ...rest] = args, options = {};
  if (!['generate', 'verify'].includes(action)) fail('INVENTORY_USAGE', 'generate|verify --root <directory> --output|--input <json> [--mode source|installed] [--host-policy debian-nodejs-v1]');
  const keys = { '--root': 'root', '--output': 'output', '--input': 'input', '--mode': 'mode', '--source-commit': 'sourceCommit', '--created-at': 'createdAt', '--pnpm-cli': 'pnpmCli', '--host-policy': 'hostPolicy' };
  for (let index = 0; index < rest.length; index += 2) {
    if (!keys[rest[index]] || !rest[index + 1] || Object.hasOwn(options, keys[rest[index]])) fail('INVENTORY_ARGUMENT_INVALID');
    options[keys[rest[index]]] = rest[index + 1];
  }
  if (!options.root || action === 'generate' && !options.output || action === 'verify' && !options.input) fail('INVENTORY_ARGUMENT_MISSING');
  if (action === 'verify') { console.log(JSON.stringify(verify(options.root, json(options.input), options))); return; }
  const report = generate(options.root, options), output = path.resolve(options.output);
  const allowedSourceOutput = (options.mode === 'source' && output === path.resolve(options.root, SOURCE_INVENTORY));
  if (!allowedSourceOutput && (sourceDirectories.some(directory => within(path.resolve(options.root, directory), output)) || sourceFiles.some(file => output === path.resolve(options.root, file)))) fail('INVENTORY_OUTPUT_OVERWRITES_SOURCE');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ generated: true, mode: report.mode, appVersion: report.app.version,
    sourceFiles: report.source.files.length, packages: report.installation?.packages.length || null, contentSha256: report.contentSha256 }));
}
module.exports = { FORMAT, SOURCE_INVENTORY, generate, verify, cli, digest, sourceSnapshot, installedSnapshot };
if (require.main === module && process.argv[2] === '--native-worker') {
  try { process.stdout.write(JSON.stringify(nativeWorker(fs.realpathSync.native(process.argv[3])))); }
  catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
