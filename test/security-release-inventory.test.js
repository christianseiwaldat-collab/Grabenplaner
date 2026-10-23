'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const inventory = require('../lib/security-release-inventory');
const repository = path.resolve(__dirname, '..');
const fixed = { sourceCommit: '1'.repeat(40), createdAt: '2026-10-18T10:00:00Z' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t, { installed = true, sharp = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-security-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', { name: 'synthetic-gp', version: '0.0.1-test', packageManager: 'pnpm@11.7.0', engines: { node: '>=24' }, dependencies: sharp ? { sharp: '1.0.0' } : { alpha: '1.0.0' } });
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write(root, 'pnpm-workspace.yaml', 'allowBuilds: {}\n');
  write(root, 'lib/source.js', 'module.exports = "synthetic";\n');
  if (installed) {
    const first = sharp ? 'sharp' : 'alpha';
    write(root, `node_modules/${first}/package.json`, { name: first, version: '1.0.0', main: 'index.js', dependencies: { beta: '2.0.0' }, optionalDependencies: { absent: '1.0.0' } });
    write(root, `node_modules/${first}/index.js`, 'module.exports = {versions:{vips:"synthetic-1"}};\n');
    write(root, 'node_modules/beta/package.json', { name: 'beta', version: '2.0.0', license: 'MIT' });
    write(root, 'node_modules/beta/index.js', 'module.exports = 2;\n');
    write(root, 'node_modules/old/package.json', { name: 'old', version: '0.1.0' });
    write(root, 'node_modules/.modules.yaml', 'synthetic: true\n');
  }
  return root;
}
function bindPackage(root) {
  const source = inventory.generate(root, { ...fixed, mode: 'source' });
  write(root, inventory.SOURCE_INVENTORY, source);
  const bytes = fs.readFileSync(path.join(root, inventory.SOURCE_INVENTORY));
  write(root, 'grabenplaner-server-manifest.json', { format: 'grabenplaner-server-package', schemaVersion: 1,
    appVersion: '0.0.1-test', sourceCommit: fixed.sourceCommit,
    files: [...source.source.files, { path: inventory.SOURCE_INVENTORY, bytes: bytes.length, sha256: sha(bytes) }] });
  return source;
}

test('source inventory is deterministic and explicitly excludes cyclic documents', t => {
  const root = fixture(t, { installed: false });
  const first = inventory.generate(root, { ...fixed, mode: 'source' });
  write(root, inventory.SOURCE_INVENTORY, first);
  assert.deepEqual(inventory.generate(root, { ...fixed, mode: 'source' }), first);
  assert.equal(first.installation, null);
  assert.equal(first.observedRuntime, null);
  assert.equal(first.assurance.completeSystemSbom, false);
  assert.ok(!first.source.files.some(item => item.path === inventory.SOURCE_INVENTORY));
  assert.equal(inventory.verify(root, first).verified, true);
});

test('installed inventory includes transitive and inactive packages, bytes, metadata and unknowns', t => {
  const root = fixture(t);
  const report = inventory.generate(root, fixed);
  assert.equal(report.installation.reachableCount, 2);
  assert.equal(report.installation.inactiveCount, 1);
  assert.equal(report.installation.packages.find(item => item.name === 'old').status, 'present_not_reachable');
  assert.equal(report.installation.edges.find(item => item.name === 'absent').status, 'optional_not_installed');
  assert.ok(report.installation.moduleDirectoryFiles.some(item => item.path === 'node_modules/.modules.yaml'));
  assert.equal(report.native.components.sqlite.version, process.versions.sqlite);
  assert.equal(report.observedRuntime.node.version, process.version);
  assert.match(report.releaseBinding.status, /Checkout/);
  assert.ok(report.requirements.operatingTools.every(item => item.version === null));
  assert.equal(inventory.verify(root, report).verified, true);
});

test('missing installation and required transitive dependencies fail closed', t => {
  const root = fixture(t, { installed: false });
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_INSTALLATION_MISSING/);
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', dependencies: { missing: '1' } });
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_REQUIRED_DEPENDENCY_MISSING/);
});

test('declared npm packages sharing a Node built-in name are inventoried as packages', t => {
  const root = fixture(t);
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', dependencies: { string_decoder: '1.0.0' } });
  write(root, 'node_modules/string_decoder/package.json', { name: 'string_decoder', version: '1.0.0' });
  const report = inventory.generate(root, fixed);
  assert.equal(report.installation.packages.find(item => item.name === 'string_decoder').status, 'reachable');
  assert.equal(report.installation.edges.find(item => item.name === 'string_decoder').status, 'resolved');
});

test('document manipulation and changed source bytes cannot be blessed by a new checksum', t => {
  const root = fixture(t);
  const report = inventory.generate(root, { ...fixed, mode: 'source' });
  report.app.version = '9.9.9';
  assert.throws(() => inventory.verify(root, report), /INVENTORY_DOCUMENT_CHANGED/);
  const { contentSha256, ...body } = report;
  report.contentSha256 = inventory.digest(body);
  assert.throws(() => inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
  const original = inventory.generate(root, { ...fixed, mode: 'source' });
  write(root, 'lib/source.js', 'changed');
  assert.throws(() => inventory.verify(root, original), /INVENTORY_CONTENT_MISMATCH/);
});

test('package changes and loose shadow entrypoints are rejected before native code executes', t => {
  const root = fixture(t, { sharp: true });
  const report = inventory.generate(root, fixed);
  const marker = path.join(root, 'shadow-executed');
  write(root, 'node_modules/sharp.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); module.exports = require('./sharp/index.js');`);
  assert.throws(() => inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_NATIVE_PROBE_FAILED/);
  assert.equal(fs.existsSync(marker), false);
  fs.unlinkSync(path.join(root, 'node_modules/sharp.js'));
  write(root, 'node_modules/beta/index.js', 'module.exports = "changed";');
  assert.throws(() => inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
});

test('dependency links cannot escape the installation tree', t => {
  const root = fixture(t, { installed: false });
  write(root, 'outside/package.json', { name: 'alpha', version: '1.0.0' });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'node_modules/alpha'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_DEPENDENCY_ESCAPE/);
});

test('JSON shadows and directories without package metadata stay inside the byte contract', t => {
  const root = fixture(t, { sharp: true });
  const report = inventory.generate(root, fixed);
  write(root, 'node_modules/sharp.json', { versions: { vips: 'synthetic-1' } });
  assert.throws(() => inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_NATIVE_PROBE_FAILED/);
  fs.unlinkSync(path.join(root, 'node_modules/sharp.json'));
  write(root, 'node_modules/without-manifest/index.js', 'module.exports=1;');
  assert.throws(() => inventory.verify(root, report), /INVENTORY_CONTENT_MISMATCH/);
  const current = inventory.generate(root, fixed);
  assert.equal(current.installation.unclassifiedDirectories.length, 1);
  write(root, 'node_modules/without-manifest/index.js', 'module.exports=2;');
  assert.throws(() => inventory.verify(root, current), /INVENTORY_CONTENT_MISMATCH/);
});

test('packaged runtime binds source inventory and outer manifest and verifies their bytes', t => {
  const root = fixture(t);
  const source = bindPackage(root);
  const report = inventory.generate(root, fixed);
  assert.match(report.releaseBinding.status, /Bound/);
  assert.match(report.releaseBinding.packageManifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.verify(root, report).verified, true);
  write(root, 'lib/source.js', 'tampered');
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_CONTENT_MISMATCH/);
  write(root, 'lib/source.js', 'module.exports = "synthetic";\n');
  const manifestPath = path.join(root, 'grabenplaner-server-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files.find(item => item.path === inventory.SOURCE_INVENTORY).sha256 = '0'.repeat(64);
  write(root, 'grabenplaner-server-manifest.json', manifest);
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_RELEASE_HASH_MISMATCH/);
  assert.equal(source.mode, 'source');
});

test('release manifest cannot omit source binding, redirect paths or mismatch identity', t => {
  const root = fixture(t);
  bindPackage(root);
  const manifestPath = path.join(root, 'grabenplaner-server-manifest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath));
  write(root, 'grabenplaner-server-manifest.json', { ...original, files: original.files.filter(item => item.path !== inventory.SOURCE_INVENTORY) });
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_RELEASE_SOURCE_UNBOUND/);
  write(root, 'grabenplaner-server-manifest.json', { ...original, sourceCommit: '2'.repeat(40) });
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_RELEASE_IDENTITY_MISMATCH/);
  write(root, 'grabenplaner-server-manifest.json', { ...original, files: [...original.files, { path: '../outside' }] });
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_RELEASE_PATH_INVALID/);
  fs.unlinkSync(path.join(root, inventory.SOURCE_INVENTORY));
  assert.throws(() => inventory.generate(root, fixed), /INVENTORY_RELEASE_SOURCE_MISSING/);
});

test('missing declared local patches and private source material are rejected', t => {
  const root = fixture(t, { installed: false });
  write(root, 'pnpm-workspace.yaml', 'patchedDependencies:\n  alpha@1.0.0: lib/vendor-patches/alpha.patch\n');
  assert.throws(() => inventory.generate(root, { ...fixed, mode: 'source' }), /INVENTORY_PATCH_MISSING/);
  write(root, 'lib/vendor-patches/alpha.patch', 'synthetic patch');
  assert.equal(inventory.generate(root, { ...fixed, mode: 'source' }).inputs.localPatches.length, 1);
  write(root, 'lib/private.key', 'synthetic');
  assert.throws(() => inventory.generate(root, { ...fixed, mode: 'source' }), /INVENTORY_PRIVATE_SOURCE_REJECTED/);
});

test('CLI refuses missing installs, duplicate flags and overwrite of source or prior evidence', t => {
  const root = fixture(t, { installed: false });
  const cli = path.join(repository, 'scripts/security-release-inventory.js');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.notEqual(run(['generate', '--root', root, '--output', path.join(root, 'result.json')]).status, 0);
  assert.notEqual(run(['generate', '--root', root, '--root', root]).status, 0);
  const args = ['generate', '--root', root, '--mode', 'source', '--output', path.join(root, 'result.json')];
  assert.equal(run(args).status, 0);
  assert.notEqual(run(args).status, 0);
  assert.notEqual(run(['generate', '--root', root, '--mode', 'source', '--output', path.join(root, 'lib/new.js')]).status, 0);
});

test('builder binds source inventory before its unchanged file manifest without running package installation', () => {
  const builder = fs.readFileSync(path.join(repository, 'server-tools/package/New-GrabenplanerLinuxServerPackage.ps1'), 'utf8');
  assert.ok(builder.indexOf('$inventoryCli generate --mode source') < builder.indexOf('$manifestFiles ='));
  assert.match(builder, /--source-commit \$sourceCommit --created-at \$sourceTimestamp/);
  assert.match(builder, /\$inventoryCli verify --root \$buildRoot --input \$sourceInventoryPath/);
  assert.match(builder, /format = 'grabenplaner-server-package'/);
  assert.match(builder, /files = \$manifestFiles/);
  assert.doesNotMatch(builder, /pnpm[^\n]+install/);
});
