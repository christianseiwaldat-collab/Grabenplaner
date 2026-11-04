'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const policy = require('../lib/portal-password-policy');
const DATA = path.join(__dirname, '..', 'lib', 'password-policy');
const SAFE = 'Kieselmond unter Segelwolken 83?';
const digest = value => createHash('sha256').update(value).digest();

function fixture(t, { common = [], breached = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-password-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  for (const [key, supplied] of [['common', common], ['breached', breached]]) {
    const values = [...supplied];
    while (values.length < 3000) values.push(`Synthetic-${key}-fixture-${values.length}`);
    const hashes = values.map(value => digest(value)).sort(Buffer.compare);
    const bytes = key === 'common' ? Buffer.from(hashes.map(value => value.toString('hex')).join('\n') + '\n') : Buffer.concat(hashes);
    manifest.artifacts[key].count = 3000;
    manifest.artifacts[key].bytes = bytes.length;
    manifest.artifacts[key].sha256 = digest(bytes).toString('hex');
    fs.writeFileSync(path.join(directory, manifest.artifacts[key].file), bytes);
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

test('bundled metadata describes one offline policy with real common and separate breach data', () => {
  assert.deepEqual(policy.metadata(), { policyVersion: 1, corpusVersion: 'seclists-60e43f4d-p15-v1',
    minLength: 15, maxLength: 256, minCodePoints: 15, maxCodePoints: 256, maxUtf8Bytes: 1024, available: true });
  assert.equal(policy.POLICY_VERSION, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  assert.equal(manifest.artifacts.common.count, 3000);
  assert.equal(manifest.commonSelection.finalSourceRow, 790039);
  assert.equal(manifest.commonSelection.metrics.policyCompatibleRows, 141033);
  assert.equal(manifest.artifacts.breached.count, 400992);
  assert.equal(manifest.breachedSelection.metrics.invalidUtf8Rows, 218);
});

test('real public source fixtures independently exercise common and breached rejection', () => {
  // Public dictionary fixtures, not GP account credentials. Both exceed the 15-code-point minimum.
  assert.equal(policy.assessExistingPassword('123456789012345').reason, 'common');
  assert.equal(policy.assessExistingPassword('abcdefghijklmnopqrstuvwxyz').reason, 'breached');
  assert.throws(() => policy.assertNewPassword('abcdefghijklmnopqrstuvwxyz'),
    error => error.status === 400 && error.code === 'PORTAL_PASSWORD_COMPROMISED');
  assert.equal(policy.assertNewPassword(SAFE).accepted, true);
});

test('values must be strings without implicit conversion', () => {
  for (const value of [undefined, null, 123456789012345, true, {}, [], new String(SAFE)]) {
    assert.equal(policy.assessExistingPassword(value).reason, 'type');
    assert.throws(() => policy.assertNewPassword(value), error => error.status === 400 && error.code === 'PORTAL_PASSWORD_TYPE_INVALID');
  }
});

test('length means Unicode code points instead of UTF-16 units or grapheme clusters', () => {
  assert.equal(policy.assessExistingPassword('🧭'.repeat(14)).reason, 'too_short');
  assert.equal(policy.assertNewPassword('🧭'.repeat(15)).accepted, true);
  assert.equal(policy.assessExistingPassword('e\u0301'.repeat(7)).reason, 'too_short');
  assert.equal(policy.assertNewPassword('e\u0301'.repeat(8)).accepted, true);
  assert.equal(policy.assessExistingPassword('Qz?'.repeat(4) + 'xy').reason, 'too_short');
  assert.equal(policy.assertNewPassword('Qz?'.repeat(5)).accepted, true);
});

test('well-formed Unicode and upper limits are enforced before expensive processing', () => {
  for (const value of [SAFE + '\ud800', '\udfff' + SAFE, '\ud800\ud800' + SAFE]) {
    assert.equal(policy.assessExistingPassword(value).reason, 'unicode');
  }
  for (const value of ['🧭'.repeat(64), '🧭'.repeat(256), 'Qz?'.repeat(85) + '!']) {
    assert.equal(policy.assertNewPassword(value).accepted, true);
  }
  assert.equal(Buffer.byteLength('🧭'.repeat(256), 'utf8'), 1024);
  for (const value of ['🧭'.repeat(257), 'Q'.repeat(257), 'Q'.repeat(1024 * 1024)]) {
    assert.equal(policy.assessExistingPassword(value).reason, 'too_long');
  }
});

test('lookup preserves raw case, whitespace and composed/decomposed Unicode', t => {
  const value = 'Ätherklang im Tal 52!';
  const { directory } = fixture(t, { breached: [value] });
  const isolated = policy.createPasswordPolicy({ dataDirectory: directory });
  assert.equal(isolated.assessExistingPassword(value).reason, 'breached');
  for (const distinct of [value.toLowerCase(), value.normalize('NFD'), ' ' + value, value + ' ']) {
    assert.equal(isolated.assertNewPassword(distinct).accepted, true);
  }
});

test('bounded full context candidates are blocked but unrelated passphrases containing a name are allowed', () => {
  const year = new Date().getUTCFullYear();
  assert.equal(policy.assessExistingPassword(`Grabenplaner${year}!`).reason, 'context');
  assert.equal(policy.assessExistingPassword(`GRABENPLANER${year}!`).reason, 'context');
  assert.equal(policy.assessExistingPassword('Synthetischer-Nutzer123', { displayName: 'Synthetischer Nutzer' }).reason, 'context');
  assert.equal(policy.assessExistingPassword('demo-login-unique123', { loginName: 'demo-login-unique' }).reason, 'context');
  assert.equal(policy.assessExistingPassword('987654321098765123', { employeeNumber: '987654321098765' }).reason, 'context');
  assert.equal(policy.assessExistingPassword('Synthetische-Firma123', { organizationName: 'Synthetische Firma' }).reason, 'context');
  assert.equal(policy.assertNewPassword('Grabenplaner trifft Kieselmond unter Segelwolken 83?').accepted, true);
  assert.equal(policy.assertNewPassword(SAFE, { displayName: 'a'.repeat(1000000) }).accepted, true);
});

test('missing files fail closed without throwing during existing-password assessment', () => {
  const missing = policy.createPasswordPolicy({ dataDirectory: path.join(os.tmpdir(), 'gp-missing-password-corpus-does-not-exist') });
  assert.equal(missing.metadata().available, false);
  assert.deepEqual(missing.assessExistingPassword(SAFE), { accepted: false, reason: 'unavailable', policyVersion: 1, corpusVersion: null });
  assert.throws(() => missing.assertNewPassword(SAFE), error => error.status === 503 && error.code === 'PORTAL_PASSWORD_POLICY_UNAVAILABLE');
});

test('changed or missing data is rejected, with no silent empty-list fallback', t => {
  const { directory } = fixture(t);
  const file = path.join(directory, 'breached-sha256.bin');
  const original = fs.readFileSync(file);
  const damaged = Buffer.from(original); damaged[0] ^= 0x01;
  fs.writeFileSync(file, damaged);
  assert.equal(policy.createPasswordPolicy({ dataDirectory: directory }).assessExistingPassword(SAFE).reason, 'unavailable');
  fs.unlinkSync(file);
  assert.equal(policy.createPasswordPolicy({ dataDirectory: directory }).assessExistingPassword(SAFE).reason, 'unavailable');
});

test('a matching checksum does not excuse wrong policy, insufficient records, or unsorted hashes', t => {
  const { directory, manifest } = fixture(t);
  const manifestFile = path.join(directory, 'manifest.json');
  for (const change of [m => { m.policyVersion = 2; }, m => { m.minimumCodePoints = 6; },
    m => { m.artifacts.common.count = 2999; }, m => { m.artifacts.breached.count = 0; },
    m => { m.artifacts.breached.file = '../outside.bin'; }]) {
    const altered = structuredClone(manifest); change(altered);
    fs.writeFileSync(manifestFile, JSON.stringify(altered));
    assert.equal(policy.createPasswordPolicy({ dataDirectory: directory }).metadata().available, false);
  }
  const file = path.join(directory, 'breached-sha256.bin');
  const bytes = fs.readFileSync(file); const first = Buffer.from(bytes.subarray(0, 32));
  bytes.copy(bytes, 0, 32, 64); first.copy(bytes, 32);
  fs.writeFileSync(file, bytes); manifest.artifacts.breached.sha256 = digest(bytes).toString('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal(policy.createPasswordPolicy({ dataDirectory: directory }).metadata().available, false);
});

test('corpus stays immutable in an already running process; restart revalidates it', t => {
  const { directory } = fixture(t, { breached: [SAFE] });
  const existing = policy.createPasswordPolicy({ dataDirectory: directory });
  fs.unlinkSync(path.join(directory, 'manifest.json'));
  assert.equal(existing.assessExistingPassword(SAFE).reason, 'breached');
  assert.equal(policy.createPasswordPolicy({ dataDirectory: directory }).assessExistingPassword(SAFE).reason, 'unavailable');
});

test('public policy errors and metadata do not disclose the submitted value or its lookup hash', () => {
  const value = 'abcdefghijklmnopqrstuvwxyz';
  try { policy.assertNewPassword(value); assert.fail('Expected rejection'); }
  catch (error) {
    const output = JSON.stringify({ message: error.message, ...error, metadata: policy.metadata() });
    assert.equal(output.includes(value), false);
    assert.equal(output.includes(digest(value).toString('hex')), false);
  }
});
