'use strict';
// Private CI payload. No source text, credentials, public artifact or network I/O.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const E = require('../../lib/security-sast-context-evidence');
const { projectSastReviews } = require('../../lib/security-sast-reviews');
const POLICY_SOURCE = 'scripts/security/sast-dispositions.json';
function policyAt(root, now) {
  const bytes = E.regularBytes(root, POLICY_SOURCE);
  if (!bytes) E.invalid();
  const policy = JSON.parse(bytes), policySha256 = E.sha(bytes);
  const projected = projectSastReviews(policy, { root, now, policySha256 });
  if (projected.summary.expired || projected.summary.sourceChanged || projected.summary.contextIncomplete) E.invalid();
  return { bytes, policy, policySha256 };
}
function createEvidence({ root, gateBytes, sourceCommit, ci, now = new Date() }) {
  const { policy, policySha256 } = policyAt(root, now), gate = JSON.parse(gateBytes);
  if (gate.schemaVersion !== 1 || gate.gate !== 'sast' || gate.complete !== true || gate.passed !== true
    || gate.status !== 'passed' || gate.exitCode !== 0) E.invalid();
  const details = gate.details;
  if (!details || !Array.isArray(details.blockingFindings) || details.blockingFindings.length
    || !Array.isArray(details.findings) || !Array.isArray(details.reviewedFalsePositives) || !Array.isArray(details.profiles)) E.invalid();
  const names = ['common', 'express', 'script_tag', 'express_property', 'express_response'];
  if (details.profiles.length !== names.length || new Set(details.profiles.map(p => p.profile)).size !== names.length) E.invalid();
  for (const profile of details.profiles) {
    if (!names.includes(profile.profile) || profile.complete !== true || profile.analysisErrors !== 0
      || !Array.isArray(profile.fixpointTimeouts) || profile.fixpointTimeouts.length
      || !Number.isSafeInteger(profile.targetedFiles) || profile.targetedFiles < 1 || profile.reportedScannedFiles !== profile.targetedFiles
      || !Number.isSafeInteger(profile.findings) || profile.findings < 0 || profile.scannerExitCode !== (profile.findings ? 1 : 0)) E.invalid();
  }
  const rows = new Map(policy.dispositions.map(row => [row.fingerprint, row]));
  if (details.findings.length !== rows.size || details.reviewedFalsePositives.length !== rows.size
    || details.profiles.reduce((sum, p) => sum + p.findings, 0) !== rows.size) E.invalid();
  const seen = new Set(), reviewed = new Set(), findingHashes = new Map();
  for (const item of details.findings) {
    const row = rows.get(item.fingerprint);
    if (row && !findingHashes.has(row.path)) findingHashes.set(row.path, E.sha(E.regularBytes(root, row.path, 32 * 1024 * 1024)));
    if (!row || seen.has(item.fingerprint) || row.rule !== item.rule || row.path !== item.path
      || row.start.line !== item.start?.line || row.start.column !== item.start?.column
      || row.end.line !== item.end?.line || row.end.column !== item.end?.column
      || item.sourceSha256 !== findingHashes.get(row.path)) E.invalid();
    seen.add(item.fingerprint);
  }
  for (const item of details.reviewedFalsePositives) {
    const row = rows.get(item.fingerprint);
    if (!row || reviewed.has(item.fingerprint) || item.expiresOn !== row.expiresOn || item.reviewer !== row.reviewer) E.invalid();
    reviewed.add(item.fingerprint);
  }
  const paths = [...new Set(policy.dispositions.flatMap(row => row.context.map(item => item.path)))].sort();
  const approved = new Map(policy.dispositions.flatMap(row => row.context.map(item => [item.path, item.sha256Variants])));
  const contexts = paths.map(relative => {
    const bytes = E.regularBytes(root, relative, 32 * 1024 * 1024);
    if (!bytes) E.invalid();
    if (findingHashes.has(relative) && findingHashes.get(relative) !== E.sha(bytes)) E.invalid();
    return { path: relative, sha256: E.sha(bytes), sha256Variants: E.newlineHashes(bytes).filter(value => approved.get(relative).includes(value)) };
  });
  const document = { format: E.FORMAT, schemaVersion: 1, sourceCommit, policySha256, ci, gateSha256: E.sha(gateBytes), contexts };
  E.validateEvidence(document, policy, policySha256, sourceCommit);
  return document;
}
function prepareEvidence({ root, buildRoot, evidenceBytes, evidenceSha256, sourceCommit, now = new Date() }) {
  // The supplied digest is an external pin from authenticated CI retrieval, not
  // a digest trusted merely because it is written inside the supplied document.
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256 || '') || E.sha(evidenceBytes) !== evidenceSha256) E.invalid();
  const { policy, policySha256 } = policyAt(root, now), document = JSON.parse(evidenceBytes);
  const contexts = E.validateEvidence(document, policy, policySha256, sourceCommit);
  const shippedPolicy = E.regularBytes(buildRoot, E.POLICY_PATH);
  if (!shippedPolicy || E.sha(shippedPolicy) !== policySha256) E.invalid();
  for (const [relative, item] of contexts) {
    const source = E.regularBytes(root, relative, 32 * 1024 * 1024);
    if (!source || item.sha256Variants.some(value => !E.newlineHashes(source).includes(value))) E.invalid();
    const shipped = E.regularBytes(buildRoot, relative, 32 * 1024 * 1024);
    if (E.excludedContext(relative)) { if (shipped !== null) E.invalid(); }
    else if (!shipped || !item.sha256Variants.includes(E.sha(shipped))) E.invalid();
  }
  const destination = path.join(buildRoot, E.EVIDENCE_PATH);
  fs.writeFileSync(destination, evidenceBytes, { flag: 'wx', mode: 0o600 });
  return { sourceCommit, ci: document.ci, sha256: evidenceSha256, contexts: contexts.size };
}
function main(argv) {
  const action = argv.shift(), options = {};
  const allowed = new Set(['--root', '--gate', '--output', '--build-root', '--evidence', '--sha256', '--source-commit']);
  while (argv.length) {
    const key = argv.shift(), value = argv.shift();
    if (!allowed.has(key) || !value || Object.hasOwn(options, key)) E.invalid();
    options[key] = value;
  }
  const root = path.resolve(options['--root'] || '.');
  const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('git', ['-C', root, 'diff', '--exit-code', 'HEAD', '--'], { stdio: 'pipe', windowsHide: true });
  const tracked = new Set(execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).split('\0'));
  const policy = JSON.parse(E.regularBytes(root, POLICY_SOURCE));
  if (!tracked.has(POLICY_SOURCE) || !Array.isArray(policy.dispositions)
    || policy.dispositions.some(row => !Array.isArray(row.context) || row.context.some(item => !tracked.has(item.path)))) E.invalid();
  if (action === 'capture') {
    if (process.env.GITHUB_SHA !== sourceCommit || process.env.GITHUB_WORKFLOW_REF !== `${process.env.GITHUB_REPOSITORY}/.github/workflows/security.yml@${process.env.GITHUB_REF}`) E.invalid();
    const gateFile = path.resolve(options['--gate']);
    const gateBytes = E.regularBytes(path.dirname(gateFile), path.basename(gateFile), 64 * 1024 * 1024);
    const result = createEvidence({ root, gateBytes, sourceCommit, ci: { repository: process.env.GITHUB_REPOSITORY,
      workflow: '.github/workflows/security.yml', runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT } });
    fs.writeFileSync(options['--output'], JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  } else if (action === 'prepare') {
    if (options['--source-commit'] !== sourceCommit) E.invalid();
    const location = path.resolve(options['--evidence']);
    prepareEvidence({ root, buildRoot: path.resolve(options['--build-root']), sourceCommit,
      evidenceBytes: E.regularBytes(path.dirname(location), path.basename(location)), evidenceSha256: options['--sha256'] });
  } else E.invalid();
}
if (require.main === module) {
  try { main(process.argv.slice(2)); process.stdout.write('SAST context evidence verified.\n'); }
  catch { process.stderr.write('SAST context evidence verification failed.\n'); process.exitCode = 1; }
}
module.exports = { createEvidence, prepareEvidence };
