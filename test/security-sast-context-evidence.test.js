'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const E = require('../lib/security-sast-context-evidence');
const { readSastReviews } = require('../lib/security-sast-reviews');
const { createEvidence, prepareEvidence } = require('../scripts/security/sast-context-evidence.cjs');
const UI = require('../public/security-sast');
const { spawnSync, execFileSync } = require('node:child_process');
const COMMIT = 'a'.repeat(40), NOW = '2026-10-31T08:00:00Z';
function write(root, relative, bytes) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), bytes);
}
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sast-evidence-'));
  t.after(() => { assert.equal(path.dirname(parent), os.tmpdir()); assert.ok(path.basename(parent).startsWith('gp-sast-evidence-')); fs.rmSync(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'source'), buildRoot = path.join(parent, 'package');
  const files = { 'lib/fixture.js': 'synthetic();\n', 'test/fixture.test.js': 'testOnly();\n' };
  for (const [relative, bytes] of Object.entries(files)) write(root, relative, bytes);
  const contexts = Object.entries(files).map(([relative, bytes]) => ({ path: relative, sha256: E.sha(bytes), sha256Variants: E.newlineHashes(Buffer.from(bytes)), reason: 'Exact synthetic context with bounded inputs; not a production verdict.' }));
  const row = { rule: 'synthetic.rule', path: 'lib/fixture.js', start: { line: 1, column: 1 }, end: { line: 1, column: 12 },
    fingerprint: E.sha(JSON.stringify(['synthetic.rule', 'lib/fixture.js', 1, 1, 1, 12])), sourceSha256: contexts[0].sha256, sourceSha256Variants: contexts[0].sha256Variants,
    classification: 'reviewed_false_positive', priority: 'P3', reason: 'Synthetic isolated test input, not a security verdict. Both runtime and intentionally excluded test context are tied to exact raw bytes.',
    reviewer: 'Synthetic reviewer', reviewedOn: '2026-10-30', expiresOn: '2026-11-29', context: contexts };
  const policy = { schemaVersion: 1, dispositions: [row] }, policyBytes = Buffer.from(JSON.stringify(policy));
  write(root, 'scripts/security/sast-dispositions.json', policyBytes);
  write(buildRoot, E.POLICY_PATH, policyBytes); write(buildRoot, 'lib/fixture.js', files['lib/fixture.js']);
  const finding = { fingerprint: row.fingerprint, rule: row.rule, path: row.path, start: row.start, end: row.end, sourceSha256: row.sourceSha256 };
  const gate = { schemaVersion: 1, gate: 'sast', complete: true, passed: true, status: 'passed', exitCode: 0,
    details: { blockingFindings: [], findings: [finding], reviewedFalsePositives: [{ fingerprint: row.fingerprint, reviewer: row.reviewer, expiresOn: row.expiresOn }],
      profiles: ['common', 'express', 'script_tag', 'express_property', 'express_response'].map((profile, index) => ({ profile, targetedFiles: 1, reportedScannedFiles: 1,
        complete: true, scannerExitCode: index ? 0 : 1, findings: index ? 0 : 1, analysisErrors: 0, fixpointTimeouts: [] })) } };
  const ci = { repository: 'christianseiwaldat-collab/Grabenplaner', workflow: '.github/workflows/security.yml', runId: '12345', attempt: '1' };
  const capture = overrides => createEvidence({ root, gateBytes: Buffer.from(JSON.stringify(gate)), sourceCommit: COMMIT, ci, now: NOW, ...overrides });
  const doc = capture(), evidenceBytes = Buffer.from(JSON.stringify(doc));
  const prepare = overrides => prepareEvidence({ root, buildRoot, evidenceBytes, evidenceSha256: E.sha(evidenceBytes), sourceCommit: COMMIT, now: NOW, ...overrides });
  function manifest(extra = {}) {
    const files = [E.POLICY_PATH, E.EVIDENCE_PATH, 'lib/fixture.js'].filter(relative => fs.existsSync(path.join(buildRoot, relative)))
      .map(relative => { const bytes = fs.readFileSync(path.join(buildRoot, relative)); return { path: relative, sha256: E.sha(bytes), bytes: bytes.length }; });
    write(buildRoot, 'grabenplaner-server-manifest.json', JSON.stringify({ format: 'grabenplaner-server-package', schemaVersion: 1, sourceCommit: COMMIT, files, ...extra }));
  }
  return { parent, root, buildRoot, policy, row, gate, ci, doc, evidenceBytes, capture, prepare, manifest,
    read: now => readSastReviews({ root: buildRoot, now: now || NOW }) };
}
const rejects = action => assert.throws(action, error => error.code === 'SECURITY_AUDIT_SAST_INVALID');
test('A private exact CI receipt resolves deliberately omitted test context without installing code', t => {
  const f = fixture(t);
  assert.equal(f.read().summary.contextIncomplete, 1);
  f.prepare(); f.manifest();
  const value = f.read();
  assert.equal(value.summary.contextIncomplete, 0); assert.equal(value.summary.contextEvidenced, 1);
  assert.equal(value.reviews[0].sourceState, 'evidenced'); assert.equal(value.reviews[0].requiresReview, false);
  assert.equal(value.reviews[0].context[1].actualSha256, null);
  assert.equal(value.contextEvidence.ci.runId, '12345');
  assert.equal(fs.existsSync(path.join(f.buildRoot, 'test')), false);
  assert.equal(fs.existsSync(path.join(f.buildRoot, 'public')), false);
});
test('Absent evidence remains incomplete; an orphan or unbound receipt fails closed', t => {
  const f = fixture(t); f.manifest(); assert.equal(f.read().summary.contextIncomplete, 1);
  f.prepare(); rejects(() => f.read());
  fs.unlinkSync(path.join(f.buildRoot, 'grabenplaner-server-manifest.json')); rejects(() => f.read());
});
test('External digest, commit, workflow, repository and policy mismatches are rejected before packaging', t => {
  const f = fixture(t);
  rejects(() => f.prepare({ evidenceSha256: '0'.repeat(64) }));
  rejects(() => f.prepare({ sourceCommit: 'b'.repeat(40) }));
  for (const mutate of [d => d.sourceCommit = 'b'.repeat(40), d => d.policySha256 = '0'.repeat(64),
    d => d.ci.repository = 'attacker/Grabenplaner', d => d.ci.workflow = '.github/workflows/other.yml',
    d => d.ci.runId = '../1', d => d.ci.attempt = 1, d => d.extra = true]) {
    const doc = structuredClone(f.doc); mutate(doc); const evidenceBytes = Buffer.from(JSON.stringify(doc));
    rejects(() => f.prepare({ evidenceBytes, evidenceSha256: E.sha(evidenceBytes) }));
  }
  assert.equal(fs.existsSync(path.join(f.buildRoot, E.EVIDENCE_PATH)), false);
});
test('Mutated proof bytes, policy bytes or manifest commit never retain evidence status', t => {
  const f = fixture(t); f.prepare(); f.manifest();
  write(f.buildRoot, E.EVIDENCE_PATH, Buffer.concat([f.evidenceBytes, Buffer.from(' ')])); rejects(() => f.read());
  write(f.buildRoot, E.EVIDENCE_PATH, f.evidenceBytes); f.manifest({ sourceCommit: 'b'.repeat(40) }); rejects(() => f.read());
  f.manifest(); fs.appendFileSync(path.join(f.buildRoot, E.POLICY_PATH), ' '); rejects(() => f.read());
});
test('Missing, duplicated, unrelated, traversing and changed context entries are rejected', t => {
  const f = fixture(t);
  for (const mutate of [d => d.contexts.pop(), d => d.contexts.push(d.contexts[0]), d => d.contexts[1].path = '../outside.js',
    d => d.contexts[1].path = 'test/unrelated.test.js', d => d.contexts[1].sha256 = '0'.repeat(64),
    d => d.contexts[1].sha256Variants.push('0'.repeat(64))]) {
    const doc = structuredClone(f.doc); mutate(doc); const evidenceBytes = Buffer.from(JSON.stringify(doc));
    rejects(() => f.prepare({ evidenceBytes, evidenceSha256: E.sha(evidenceBytes) }));
  }
});
test('Evidence cannot mask a changed or deleted runtime file, even if its manifest is rewritten', t => {
  const f = fixture(t); f.prepare(); f.manifest();
  write(f.buildRoot, 'lib/fixture.js', 'changed();\n'); f.manifest();
  assert.equal(f.read().reviews[0].sourceState, 'changed'); assert.equal(f.read().reviews[0].requiresReview, true);
  fs.unlinkSync(path.join(f.buildRoot, 'lib/fixture.js')); f.manifest();
  assert.equal(f.read().reviews[0].sourceState, 'incomplete');
});
test('Any present excluded context is read directly and a changed copy cannot use the old proof', t => {
  const f = fixture(t); f.prepare(); f.manifest();
  write(f.buildRoot, 'test/fixture.test.js', 'changed test();\n');
  assert.equal(f.read().reviews[0].sourceState, 'changed');
});
test('A valid CI proof does not extend the inclusive UTC review deadline', t => {
  const f = fixture(t); f.prepare(); f.manifest();
  assert.equal(f.read('2026-11-29T23:59:59Z').summary.expired, 0);
  const expired = f.read('2026-11-30T00:00:00Z');
  assert.equal(expired.summary.expired, 1); assert.equal(expired.reviews[0].requiresReview, true);
  rejects(() => f.capture({ now: '2026-11-30T00:00:00Z' }));
});
test('Failed, incomplete, timed-out or inconsistent scanner results cannot produce a context receipt', t => {
  const f = fixture(t);
  for (const mutate of [g => g.complete = false, g => g.passed = false, g => g.exitCode = 1,
    g => g.details.blockingFindings.push({}), g => g.details.profiles.pop(),
    g => g.details.profiles[0].fixpointTimeouts.push('file'), g => g.details.profiles[0].analysisErrors = 1,
    g => g.details.profiles[0].reportedScannedFiles = 0, g => g.details.findings[0].sourceSha256 = '0'.repeat(64),
    g => g.details.reviewedFalsePositives[0].expiresOn = '2026-12-30', g => g.details.reviewedFalsePositives = [],
    g => g.details.findings[0].start.column = 2, g => g.details.profiles[0].scannerExitCode = 0]) {
    const gate = structuredClone(f.gate); mutate(gate);
    rejects(() => f.capture({ gateBytes: Buffer.from(JSON.stringify(gate)) }));
  }
});
test('Packaging rejects changed source, missing runtime bytes and accidentally restored excluded modules', t => {
  const f = fixture(t);
  write(f.buildRoot, 'test/fixture.test.js', 'testOnly();\n'); rejects(() => f.prepare());
  fs.unlinkSync(path.join(f.buildRoot, 'test/fixture.test.js'));
  write(f.buildRoot, 'lib/fixture.js', 'changed();\n'); rejects(() => f.prepare());
  fs.unlinkSync(path.join(f.buildRoot, 'lib/fixture.js')); rejects(() => f.prepare());
  write(f.buildRoot, 'lib/fixture.js', 'synthetic();\n');
  write(f.root, 'test/fixture.test.js', 'changed();\n'); rejects(() => f.prepare());
});
test('Explicit LF/CRLF variants work, but whitespace changes do not', t => {
  const f = fixture(t);
  write(f.root, 'test/fixture.test.js', 'testOnly();\r\n'); write(f.buildRoot, 'lib/fixture.js', 'synthetic();\r\n');
  f.prepare(); f.manifest(); assert.equal(f.read().reviews[0].sourceState, 'evidenced');
  write(f.buildRoot, 'lib/fixture.js', 'synthetic(); \r\n'); assert.equal(f.read().reviews[0].sourceState, 'changed');
});
test('Capture does not widen a policy that permits only the exact LF bytes', t => {
  const f = fixture(t);
  f.row.context[1].sha256Variants = [f.row.context[1].sha256];
  write(f.root, 'scripts/security/sast-dispositions.json', JSON.stringify(f.policy));
  write(f.buildRoot, E.POLICY_PATH, JSON.stringify(f.policy));
  const doc = f.capture(), evidenceBytes = Buffer.from(JSON.stringify(doc));
  assert.deepEqual(doc.contexts.find(c => c.path === 'test/fixture.test.js').sha256Variants, [f.row.context[1].sha256]);
  f.prepare({ evidenceBytes, evidenceSha256: E.sha(evidenceBytes) }); f.manifest();
  assert.equal(f.read().summary.contextEvidenced, 1);
  write(f.buildRoot, 'test/fixture.test.js', 'testOnly();\r\n'); assert.equal(f.read().summary.sourceChanged, 1);
});
test('File and directory symlinks cannot supply source or packaged proof', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.prepare(); f.manifest();
  const evidence = path.join(f.buildRoot, E.EVIDENCE_PATH);
  fs.renameSync(evidence, evidence + '.real'); fs.symlinkSync(evidence + '.real', evidence); rejects(() => f.read());
  fs.unlinkSync(evidence); fs.renameSync(evidence + '.real', evidence);
  const audit = path.join(f.buildRoot, 'lib/security-audits'); fs.renameSync(audit, audit + '.real'); fs.symlinkSync(audit + '.real', audit, 'dir'); rejects(() => f.read());
});
test('Known exclusions never classify runtime backup scripts as omitted test contexts', () => {
  for (const name of ['test/a.js', 'scripts/a.js', 'lib/persistence/sqlite/a.js', 'lib/persistence/postgresql/transfer/a.js']) assert.equal(E.excludedContext(name), true);
  for (const name of ['scripts/run-background-backup.js', 'scripts/manage-local-backup-archive.js', 'lib/runtime.js', '../test/a.js']) assert.equal(E.excludedContext(name), false);
});

test('Evidence metadata registration grants no database driver, provider or configuration access', () => {
  const { architectureBoundaryViolationsForText: check } = require('../scripts/audit-persistence-coupling');
  const file = 'lib/security-sast-context-evidence.js';
  assert.deepEqual(check(file, fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')), []);
  for (const source of [
    "const driver = require('pg');",
    "const driver = require('node:" + "sqlite');",
    'const provider = createPersistenceProviderFacade(adapter);',
    'const statement = definePersistenceStatement({});',
    'const selected = process.env.DB_PROVIDER;',
    'const secret = process.env.DATABASE_URL;',
  ]) assert.ok(check(file, source).length > 0, source);
});
test('UI and export states distinguish CI proof from local bytes and escape hostile metadata', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const markup = UI.evidenceMarkup({ status: 'package_bound', ci: { runId: hostile, attempt: hostile }, sourceCommit: hostile, sha256: hostile });
  assert.ok(!markup.includes('<img')); assert.ok(markup.includes('&lt;img'));
  const detail = UI.detailMarkup({ sourceState: 'evidenced', context: [{ path: hostile, state: 'ci_evidence', evidenceSha256: hostile }] });
  assert.ok(detail.includes('Nicht ausgeliefert')); assert.ok(!detail.includes('<img'));
  assert.equal(UI.filtered([{ sourceState: 'evidenced' }, { sourceState: 'incomplete' }], '', 'evidenced', false).length, 1);
});
test('Real CLI captures only the clean CI commit and stages the externally pinned private receipt', t => {
  const f = fixture(t), cli = path.resolve(__dirname, '../scripts/security/sast-context-evidence.cjs');
  const now = new Date(); f.row.reviewedOn = now.toISOString().slice(0, 10);
  f.row.expiresOn = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  f.gate.details.reviewedFalsePositives[0].expiresOn = f.row.expiresOn;
  write(f.root, 'scripts/security/sast-dispositions.json', JSON.stringify(f.policy)); write(f.buildRoot, E.POLICY_PATH, JSON.stringify(f.policy));
  for (const relative of ['lib/security-sast-reviews.js', 'lib/security-sast-context-evidence.js', 'scripts/security/sast-context-evidence.cjs']) {
    write(f.root, relative, fs.readFileSync(path.join(__dirname, '..', relative)));
  }
  write(f.buildRoot, 'lib/security-sast-reviews.js', '// Synthetic package presence marker\n');
  write(f.buildRoot, 'lib/security-sast-context-evidence.js', '// Synthetic new contract presence marker\n');
  const git = args => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']);
  git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic fixture']);
  let sourceCommit = git(['rev-parse', 'HEAD']);
  const output = path.join(f.parent, 'ci-evidence.json'), gateFile = path.join(f.parent, 'gate.json');
  fs.writeFileSync(gateFile, JSON.stringify(f.gate));
  const env = { ...process.env, GITHUB_SHA: sourceCommit, GITHUB_REPOSITORY: f.ci.repository, GITHUB_RUN_ID: f.ci.runId,
    GITHUB_RUN_ATTEMPT: f.ci.attempt, GITHUB_REF: 'refs/heads/synthetic', GITHUB_WORKFLOW_REF: `${f.ci.repository}/${f.ci.workflow}@refs/heads/synthetic` };
  const run = (args, overrides = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const captureArgs = ['capture', '--root', f.root, '--gate', gateFile, '--output', output];
  assert.notEqual(run(captureArgs, { GITHUB_SHA: COMMIT }).status, 0); assert.equal(fs.existsSync(output), false);
  git(['rm', '--cached', 'test/fixture.test.js']);
  git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Untracked context negative control']);
  assert.notEqual(run(captureArgs, { GITHUB_SHA: git(['rev-parse', 'HEAD']) }).status, 0, 'Untracked context must not be attributed to a commit.');
  assert.equal(fs.existsSync(output), false);
  git(['add', 'test/fixture.test.js']);
  git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Restore synthetic tracked context']);
  sourceCommit = git(['rev-parse', 'HEAD']); env.GITHUB_SHA = sourceCommit;
  fs.appendFileSync(path.join(f.root, 'lib/fixture.js'), '// dirty'); assert.notEqual(run(captureArgs).status, 0);
  write(f.root, 'lib/fixture.js', 'synthetic();\n');
  const captured = run(captureArgs); assert.equal(captured.status, 0, captured.stderr);
  const evidenceBytes = fs.readFileSync(output); assert.equal(JSON.parse(evidenceBytes).sourceCommit, sourceCommit);
  const args = ['prepare', '--root', f.root, '--build-root', f.buildRoot, '--source-commit', sourceCommit, '--evidence', output, '--sha256', E.sha(evidenceBytes)];
  if (process.platform === 'win32') {
    const builder = fs.readFileSync(path.join(__dirname, '../server-tools/package/New-GrabenplanerLinuxServerPackage.ps1'), 'utf8');
    const block = builder.match(/^    if \(Test-Path -LiteralPath \(Join-Path \$buildRoot 'lib\\security-sast-reviews\.js'\)\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(block);
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    const packageStep = digest => {
      const script = `$ErrorActionPreference = 'Stop'\n$sourceRoot = ${quote(f.root)}\n$buildRoot = ${quote(f.buildRoot)}\n$sourceCommit = ${quote(sourceCommit)}\n$SastContextEvidence = ${quote(output)}\n$SastContextEvidenceSha256 = ${quote(digest)}\n${block}`;
      return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    };
    assert.notEqual(packageStep('').status, 0, 'The real package block must require an external CI pin.');
    const staged = packageStep(E.sha(evidenceBytes)); assert.equal(staged.status, 0, staged.stderr);
  } else {
    const staged = run(args); assert.equal(staged.status, 0, staged.stderr);
  }
  f.manifest({ sourceCommit }); assert.equal(f.read(now).summary.contextEvidenced, 1);
  assert.notEqual(run(args).status, 0, 'A staged receipt may not be silently replaced.');
});
