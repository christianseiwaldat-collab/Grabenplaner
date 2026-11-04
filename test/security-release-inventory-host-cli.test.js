'use strict';

// Real Linux CLI integration. All application packages are temporary fixtures;
// no OS package tree or service is modified, and ordinary entrypoints must not
// execute. The fixed-root/dpkg trust policy has separate synthetic tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inventory = require('../lib/security-release-inventory');

const linux = { skip: process.platform !== 'linux' };
const cli = path.resolve(__dirname, '../scripts/security-release-inventory.js');
const policyId = 'debian-nodejs-v1';
const fixed = ['--source-commit', '1'.repeat(40), '--created-at', '2026-10-22T10:00:00Z'];

function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-inventory-host-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'entrypoint-executed');
  const entrypoint = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw new Error('ordinary entrypoint executed');\n`;
  write(root, 'package.json', { name: 'synthetic-gp', version: '0.0.1-test', dependencies: { alpha: '1.0.0' } });
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write(root, 'pnpm-workspace.yaml', 'allowBuilds: {}\n');
  write(root, 'lib/source.js', 'module.exports = "synthetic";\n');
  write(root, 'node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', main: 'index.js', dependencies: { beta: '2.0.0' } });
  write(root, 'node_modules/alpha/index.js', entrypoint);
  write(root, 'node_modules/beta/package.json', { name: 'beta', version: '2.0.0', main: 'index.js' });
  write(root, 'node_modules/beta/index.js', entrypoint);
  write(root, 'node_modules/inactive/package.json', { name: 'inactive', version: '0.1.0', main: 'index.js' });
  write(root, 'node_modules/inactive/index.js', entrypoint);
  return { root, marker };
}
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
    // An injected preload or NODE_PATH is not part of these self-contained
    // fixtures. Do not disable Node's normal global lookup implementation.
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
}
function success(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function rejected(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'CLI unexpectedly accepted invalid evidence/options');
  assert.match(result.stderr, /(?:INVENTORY|HOST)_[A-Z_]+|EEXIST/);
}
function generated(root, { host = true, output = 'result.json', mode = 'installed' } = {}) {
  const filename = path.join(root, output);
  success(run(['generate', '--root', root, '--output', filename, '--mode', mode, ...fixed,
    ...(host ? ['--host-policy', policyId] : [])]));
  return { filename, report: JSON.parse(fs.readFileSync(filename, 'utf8')) };
}
function verify(root, filename, extra = []) {
  return run(['verify', '--root', root, '--input', filename, ...extra]);
}
function rehash(report) {
  const { contentSha256, ...body } = report;
  report.contentSha256 = inventory.digest(body);
  return report;
}
function rehashHost(report) {
  if (report.hostResolution && Object.hasOwn(report.hostResolution, 'contentSha256')) rehash(report.hostResolution);
  return rehash(report);
}

test('Linux CLI opt-in binds schema 2 physical bytes and separately observed declared graph without executing packages', linux, t => {
  const { root, marker } = fixture(t);
  const { filename, report } = generated(root);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.hostPolicy, { id: policyId, version: 1 });
  assert.equal(report.mode, 'installed');
  assert.equal(report.installation.physicalOnly, true);
  assert.equal(report.installation.reachableCount, null);
  assert.equal(report.installation.inactiveCount, null);
  assert.deepEqual(report.installation.edges, []);
  assert.deepEqual(report.installation.packages.map(item => item.status), ['physical_only', 'physical_only', 'physical_only']);
  assert.equal(report.hostResolution.format, 'grabenplaner-security-release-host-inventory');
  assert.equal(report.hostResolution.policy.id, policyId);
  assert.equal(report.hostResolution.assurance.actualDeclaredMetadataResolutionObserved, true);
  assert.equal(report.hostResolution.assurance.synthetic, false);
  assert.equal(report.hostResolution.assurance.runtimeExecutionTrace, false);
  assert.equal(report.hostResolution.assurance.completeSystemSbom, false);
  assert.deepEqual(report.hostResolution.edges.map(edge => [edge.name, edge.kind, edge.status]).sort(),
    [['alpha', 'app', 'resolved'], ['beta', 'app', 'resolved']]);
  assert.deepEqual(report.hostResolution.externalPackages, []);
  assert.equal(success(verify(root, filename)).verified, true);
  assert.equal(success(verify(root, filename, ['--host-policy', policyId])).verified, true);
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI retains strict installed and source schema 1 without host-policy fields', linux, t => {
  const { root, marker } = fixture(t);
  const strict = generated(root, { host: false, output: 'strict.json' });
  assert.equal(strict.report.schemaVersion, 1);
  assert.equal(Object.hasOwn(strict.report, 'hostPolicy'), false);
  assert.equal(Object.hasOwn(strict.report, 'hostResolution'), false);
  assert.equal(strict.report.installation.reachableCount, 2);
  assert.equal(strict.report.installation.inactiveCount, 1);
  assert.equal(success(verify(root, strict.filename)).verified, true);
  const source = generated(root, { host: false, mode: 'source', output: 'source.json' });
  assert.equal(source.report.schemaVersion, 1);
  assert.equal(source.report.installation, null);
  assert.equal(Object.hasOwn(source.report, 'hostPolicy'), false);
  assert.equal(success(verify(root, source.filename)).verified, true);
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI refuses unknown, duplicate, incomplete and source-incompatible host-policy arguments before writing evidence', linux, t => {
  const { root, marker } = fixture(t);
  const invalid = [
    ['--host-policy', 'unapproved-policy'],
    ['--host-policy', policyId, '--host-policy', policyId],
    ['--host-policy'],
    ['--host-policy', policyId, '--mode', 'source'],
    ['--host-policy', policyId, '--host-policy-root', '/tmp'],
  ];
  for (let index = 0; index < invalid.length; index++) {
    const output = path.join(root, `rejected-${index}.json`);
    rejected(run(['generate', '--root', root, '--output', output, ...invalid[index]]));
    assert.equal(fs.existsSync(output), false);
  }
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI cannot apply an explicit host policy to pre-existing strict or source evidence', linux, t => {
  const { root, marker } = fixture(t);
  for (const mode of ['source', 'installed']) {
    const { filename } = generated(root, { host: false, mode, output: `${mode}.json` });
    rejected(verify(root, filename, ['--host-policy', policyId]));
  }
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI rejects host-policy identity, version and schema downgrades even with a new document checksum', linux, t => {
  const { root, marker } = fixture(t);
  const { report } = generated(root);
  const mutations = [
    value => { value.hostPolicy.id = 'unapproved-policy'; },
    value => { value.hostPolicy.version = 2; },
    value => { delete value.hostPolicy; },
    value => { value.schemaVersion = 1; },
    value => { value.mode = 'source'; },
    value => { value.hostPolicy.extraTrustRoot = '/tmp'; },
  ];
  for (let index = 0; index < mutations.length; index++) {
    const changed = JSON.parse(JSON.stringify(report));
    mutations[index](changed);
    const filename = write(root, `policy-tamper-${index}.json`, rehash(changed));
    rejected(verify(root, filename));
  }
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI rejects unknown verify policy rather than trusting a schema 2 document', linux, t => {
  const { root, marker } = fixture(t);
  const { filename } = generated(root);
  rejected(verify(root, filename, ['--host-policy', 'unapproved-policy']));
  rejected(verify(root, filename, ['--host-policy', policyId, '--host-policy', policyId]));
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI reobserves host graph and fixed policy, rejecting nested tampering after both hashes are recomputed', linux, t => {
  const { root, marker } = fixture(t);
  const { report } = generated(root);
  const mutations = [
    value => { value.hostResolution.edges[0].target = '/tmp/untrusted-package'; },
    value => { value.hostResolution.edges = []; },
    value => { value.hostResolution.policy.fixedOsRoots.push('/tmp'); },
    value => { value.hostResolution.assurance.runtimeExecutionTrace = true; },
    value => { value.hostResolution.externalPackages.push({ name: 'unobserved', version: '1', root: '/tmp/unobserved' }); },
  ];
  for (let index = 0; index < mutations.length; index++) {
    const changed = JSON.parse(JSON.stringify(report));
    mutations[index](changed);
    const filename = write(root, `graph-tamper-${index}.json`, rehashHost(changed));
    rejected(verify(root, filename));
  }
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI rejects recorded package-byte tampering despite recomputed inner and outer checksums', linux, t => {
  const { root, marker } = fixture(t);
  const { report } = generated(root);
  const pkg = report.installation.packages.find(item => item.name === 'alpha');
  pkg.files.find(item => item.path.endsWith('/index.js')).sha256 = '0'.repeat(64);
  pkg.contentSha256 = inventory.digest(pkg.files);
  report.installation.sha256 = inventory.digest({ packages: report.installation.packages, edges: report.installation.edges,
    moduleDirectoryFiles: report.installation.moduleDirectoryFiles, unclassifiedDirectories: report.installation.unclassifiedDirectories });
  const filename = write(root, 'byte-tamper.json', rehash(report));
  rejected(verify(root, filename));
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI detects changed installed bytes and source bytes before executing package entrypoints', linux, t => {
  const { root, marker } = fixture(t);
  const { filename } = generated(root);
  const entrypoint = fs.readFileSync(path.join(root, 'node_modules/beta/index.js'));
  write(root, 'node_modules/beta/index.js', 'throw new Error("changed installed entrypoint");\n');
  rejected(verify(root, filename));
  fs.writeFileSync(path.join(root, 'node_modules/beta/index.js'), entrypoint);
  write(root, 'lib/source.js', 'changed source bytes\n');
  rejected(verify(root, filename));
  assert.equal(fs.existsSync(marker), false);
});

test('Linux CLI checks host-policy bytes before its explicitly permitted native probe executes again', linux, t => {
  const { root, marker } = fixture(t);
  const nativeMarker = path.join(root, 'native-probe-executed');
  write(root, 'package.json', { name: 'synthetic-gp', version: '0.0.1-test', dependencies: { alpha: '1.0.0', sharp: '1.0.0' } });
  write(root, 'node_modules/sharp/package.json', { name: 'sharp', version: '1.0.0', main: 'index.js' });
  write(root, 'node_modules/sharp/index.js', `require('node:fs').writeFileSync(${JSON.stringify(nativeMarker)}, 'native probe'); module.exports = {versions:{vips:'synthetic-1'}};\n`);
  const { filename, report } = generated(root);
  assert.equal(report.native.components.sharp.vips, 'synthetic-1');
  assert.equal(fs.existsSync(nativeMarker), true, 'the explicit native probe was not observed');
  fs.unlinkSync(nativeMarker);
  write(root, 'node_modules/sharp/index.js', `require('node:fs').writeFileSync(${JSON.stringify(nativeMarker)}, 'changed native probe'); module.exports = {versions:{vips:'synthetic-2'}};\n`);
  const result = verify(root, filename);
  rejected(result);
  assert.match(result.stderr, /INVENTORY_CONTENT_MISMATCH/);
  assert.equal(fs.existsSync(nativeMarker), false, 'verification executed changed native package bytes');
  assert.equal(fs.existsSync(marker), false, 'an ordinary package entrypoint executed');
});

test('Linux CLI host policy preserves strict app-tree escape rejection and output overwrite guards', linux, t => {
  const { root, marker } = fixture(t);
  const { filename } = generated(root);
  const prior = fs.readFileSync(filename);
  rejected(run(['generate', '--root', root, '--output', filename, '--host-policy', policyId, ...fixed]));
  assert.deepEqual(fs.readFileSync(filename), prior);
  const sourcePath = path.join(root, 'lib/source.js');
  const source = fs.readFileSync(sourcePath);
  rejected(run(['generate', '--root', root, '--output', sourcePath, '--host-policy', policyId, ...fixed]));
  assert.deepEqual(fs.readFileSync(sourcePath), source);
  write(root, 'outside/package.json', { name: 'escape', version: '1.0.0' });
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'node_modules/escape'), 'dir');
  for (const host of [false, true]) {
    const output = path.join(root, `escape-${host}.json`);
    rejected(run(['generate', '--root', root, '--output', output, ...(host ? ['--host-policy', policyId] : [])]));
    assert.equal(fs.existsSync(output), false);
  }
  assert.equal(fs.existsSync(marker), false);
});
