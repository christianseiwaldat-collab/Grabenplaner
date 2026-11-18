const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPolicy } = require('../scripts/security/verify-patch.cjs');
const policy = require('../scripts/security/patch-policy.json');

const reviewDate = new Date(policy.reviewedOn + 'T00:00:00Z');
const expiryDate = new Date(policy.expiresOn + 'T23:59:59Z');
const fixture = () => ({
  patchHash: policy.patchSha256,
  installedHash: policy.installedCommonJsSha256,
  workspace: `patchedDependencies:\n  ${policy.package}@${policy.version}: ${policy.patch}\n`,
  lock: `patchedDependencies:\n  ${policy.package}@${policy.version}: ${policy.patchSha256}\n`,
});

test('compatibility approval is exact and not an advisory waiver', () => {
  checkPolicy(policy, fixture(), reviewDate);
  checkPolicy(policy, fixture(), expiryDate);
  assert.deepEqual(policy.advisoryExceptions, []);
});

for (const field of ['patchHash', 'installedHash', 'workspace', 'lock']) {
  test(`compatibility approval rejects ${field} drift`, () => {
    const input = fixture();
    input[field] = field === 'workspace' || field === 'lock'
      ? input[field].replace('@5.0.12:', '@5.0.11:')
      : input[field] + 'changed';
    assert.throws(() => checkPolicy(policy, input, reviewDate));
  });
}

test('compatibility approval expires', () => {
  assert.throws(() => checkPolicy(policy, fixture(), new Date(+expiryDate + 1000)), /Expired or overbroad/);
});

test('compatibility approval cannot waive an advisory', () => {
  assert.throws(() => checkPolicy({ ...policy, advisoryExceptions: ['GHSA-fixture'] }, fixture(), reviewDate));
});

test('compatibility approval cannot be future-dated', () => {
  assert.throws(() => checkPolicy(policy, fixture(), new Date(+reviewDate - 1000)), /Expired or overbroad/);
});

test('compatibility approval rejects additional patched packages', () => {
  const input = fixture();
  input.workspace += '  another@1.0.0: lib/unreviewed.patch\n';
  assert.throws(() => checkPolicy(policy, input, reviewDate));
});
