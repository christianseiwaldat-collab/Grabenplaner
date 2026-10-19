'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { projectSastReviews, readSastReviews } = require('../lib/security-sast-reviews');
const UI = require('../public/security-sast');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sast-review-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('gp-sast-review-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'lib')); fs.writeFileSync(path.join(root, 'lib/fixture.js'), 'synthetic();\n');
  const sha256 = hash(fs.readFileSync(path.join(root, 'lib/fixture.js')));
  const row = { rule: 'synthetic.rule', path: 'lib/fixture.js', start: { line: 1, column: 1 }, end: { line: 1, column: 12 },
    fingerprint: hash(JSON.stringify(['synthetic.rule', 'lib/fixture.js', 1, 1, 1, 12])), sourceSha256: sha256, sourceSha256Variants: [sha256],
    classification: 'reviewed_false_positive', priority: 'P3', reason: 'Synthetic isolated test input; no actual source verdict. The guard and context are bound to exact fixture bytes.',
    reviewer: 'Synthetic reviewer', reviewedOn: '2026-10-19', expiresOn: '2026-11-18', context: [{ path: 'lib/fixture.js', sha256, sha256Variants: [sha256], reason: 'Exact isolated synthetic test context.' }] };
  const policy = { schemaVersion: 1, dispositions: [row] }, options = { root, now: '2026-10-19T00:00:00Z' };
  return { root, row, policy, options };
}
test('SAST dates follow the scanner UTC boundary and source changes cannot remain current', t => {
  const { root, policy, options } = fixture(t);
  assert.equal(projectSastReviews(policy, options).summary.requiresReview, 0);
  assert.equal(projectSastReviews(policy, { ...options, now: '2026-11-04T00:00:00Z' }).summary.dueSoon, 1);
  assert.equal(projectSastReviews(policy, { ...options, now: '2026-11-18T23:59:59Z' }).summary.expired, 0);
  assert.equal(projectSastReviews(policy, { ...options, now: '2026-11-19T00:00:00Z' }).summary.expired, 1);
  fs.writeFileSync(path.join(root, 'lib/fixture.js'), 'changed();\n');
  const changed = projectSastReviews(policy, options); assert.equal(changed.summary.sourceChanged, 1); assert.equal(changed.reviews[0].requiresReview, true);
});
test('Missing packaged review context remains unknown, not silently passed or called changed', t => {
  const { row, policy, options } = fixture(t), sha256 = hash('synthetic test');
  row.context.push({ path: 'test/not-installed.test.js', sha256, sha256Variants: [sha256], reason: 'Test-only review context is not part of the runtime package.' });
  const value = projectSastReviews(policy, options); assert.equal(value.summary.contextIncomplete, 1); assert.equal(value.summary.sourceChanged, 0);
});
test('Malformed or overly broad decisions, dates and path traversal fail closed', t => {
  const { policy, options } = fixture(t);
  for (const mutate of [p => p.dispositions.push(p.dispositions[0]), p => p.dispositions[0].path = '../outside.js',
    p => p.dispositions[0].context[0].path = '../outside.js', p => p.dispositions[0].context[0].sha256Variants = ['*'],
    p => p.dispositions[0].fingerprint = 'a'.repeat(64), p => p.dispositions[0].expiresOn = '2027-11-18',
    p => p.dispositions[0].reviewedOn = '2026-02-30', p => p.dispositions[0].classification = 'risk_accepted',
    p => p.dispositions[0].reason = 'allow', p => p.dispositions[0].end.line = 0]) {
    const input = structuredClone(policy); mutate(input); assert.throws(() => projectSastReviews(input, options), e => e.code === 'SECURITY_AUDIT_SAST_INVALID');
  }
});
test('Policy loader distinguishes source checkout and shipped policy, and rejects missing/invalid input', t => {
  const { root, policy, options } = fixture(t);
  assert.throws(() => readSastReviews(options), e => e.statusCode === 503);
  fs.mkdirSync(path.join(root, 'scripts/security'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/security/sast-dispositions.json'), JSON.stringify(policy));
  assert.equal(readSastReviews(options).reviews.length, 1);
  fs.mkdirSync(path.join(root, 'lib/security-audits')); fs.writeFileSync(path.join(root, 'lib/security-audits/sast-dispositions.json'), '{');
  assert.throws(() => readSastReviews(options), e => e.statusCode === 503);
});
test('Hostile SAST text is escaped; filters keep expired and changed entries distinguishable', t => {
  const { row } = fixture(t); const hostile = '<img src=x onerror=alert(1)>';
  const html = UI.detailMarkup({ ...row, reason: hostile, reviewer: hostile, context: [{ path: hostile, reason: hostile }] });
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
  const rows = [{ deadlineState: 'expired', sourceState: 'matches', requiresReview: true }, { deadlineState: 'current', sourceState: 'changed', requiresReview: true }, { deadlineState: 'current', sourceState: 'matches', requiresReview: false }];
  assert.equal(UI.filtered(rows, '', '', true).length, 2); assert.equal(UI.filtered(rows, 'current', 'changed', false).length, 1);
});
