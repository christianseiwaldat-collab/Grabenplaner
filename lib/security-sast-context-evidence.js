'use strict';
// Integrity within the verified release package, not an independent CI signature.
// The release operator pins evidence from the authenticated private CI artifact.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMAT = 'gp-sast-context-evidence-v1';
const EVIDENCE_PATH = 'lib/security-audits/sast-context-evidence.json';
const POLICY_PATH = 'lib/security-audits/sast-dispositions.json';
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function invalid() { throw Object.assign(new Error('Der paketgebundene SAST-Nachweis ist ungültig.'), { code: 'SECURITY_AUDIT_SAST_INVALID', statusCode: 503 }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..') && !/[:\x00-\x1f]/.test(value);
}
function regularBytes(root, relative, max = 16 * 1024 * 1024) {
  if (!safePath(relative)) invalid();
  const base = fs.realpathSync(root), parts = relative.split('/');
  let current = base;
  try {
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) invalid();
      if (index === parts.length - 1 && (!stat.isFile() || stat.size > max)) invalid();
    }
    const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > max) invalid();
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(current);
      if (bytes.length > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ino !== named.ino || before.dev !== named.dev || named.isSymbolicLink()) invalid();
      return bytes;
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function newlineHashes(bytes) {
  // No whitespace, encoding or lone-CR normalization; only explicit LF/CRLF.
  const lf = Buffer.from(bytes.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  return [...new Set([sha(bytes), sha(lf), sha(Buffer.from(lf.toString('binary').replace(/\n/g, '\r\n'), 'binary'))])].sort();
}
function excludedContext(relative) {
  if (!safePath(relative)) return false;
  if (['scripts/run-background-backup.js', 'scripts/manage-local-backup-archive.js'].includes(relative)) return false;
  return /^(test\/|scripts\/|lib\/persistence\/sqlite\/|lib\/persistence\/postgresql\/transfer\/)/.test(relative);
}
function validateEvidence(document, policy, policySha256, sourceCommit) {
  exact(document, ['format', 'schemaVersion', 'sourceCommit', 'policySha256', 'ci', 'gateSha256', 'contexts']);
  if (document.format !== FORMAT || document.schemaVersion !== 1 || !COMMIT.test(document.sourceCommit)
    || document.sourceCommit !== sourceCommit || !HASH.test(document.policySha256) || document.policySha256 !== policySha256
    || !HASH.test(document.gateSha256)) invalid();
  exact(document.ci, ['repository', 'workflow', 'runId', 'attempt']);
  if (document.ci.repository !== 'christianseiwaldat-collab/Grabenplaner' || document.ci.workflow !== '.github/workflows/security.yml'
    || !/^[1-9][0-9]{0,19}$/.test(document.ci.runId) || !/^[1-9][0-9]{0,19}$/.test(document.ci.attempt)
    || typeof document.ci.runId !== 'string' || typeof document.ci.attempt !== 'string') invalid();
  if (!Array.isArray(document.contexts) || document.contexts.length > 20000 || !Array.isArray(policy?.dispositions)) invalid();
  const needed = new Map();
  for (const row of policy.dispositions) for (const item of row.context || []) {
    if (!safePath(item.path) || !Array.isArray(item.sha256Variants)) invalid();
    const prior = needed.get(item.path);
    if (prior && JSON.stringify([...prior].sort()) !== JSON.stringify([...item.sha256Variants].sort())) invalid();
    needed.set(item.path, item.sha256Variants);
  }
  const contexts = new Map();
  for (const item of document.contexts) {
    exact(item, ['path', 'sha256', 'sha256Variants']);
    const accepted = needed.get(item.path);
    if (!accepted || contexts.has(item.path) || !HASH.test(item.sha256) || !Array.isArray(item.sha256Variants)
      || item.sha256Variants.length < 1 || item.sha256Variants.length > 3 || !item.sha256Variants.includes(item.sha256)
      || new Set(item.sha256Variants).size !== item.sha256Variants.length
      || item.sha256Variants.some(value => !HASH.test(value) || !accepted.includes(value))) invalid();
    contexts.set(item.path, item);
  }
  if (contexts.size !== needed.size) invalid();
  return contexts;
}
function loadPackagedEvidence(root, policy, policySha256) {
  const evidenceBytes = regularBytes(root, EVIDENCE_PATH);
  if (evidenceBytes === null) return null;
  const manifestBytes = regularBytes(root, 'grabenplaner-server-manifest.json');
  if (!manifestBytes) invalid();
  const manifest = JSON.parse(manifestBytes), document = JSON.parse(evidenceBytes);
  if (manifest.format !== 'grabenplaner-server-package' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)
    || manifest.files.length > 20000 || !COMMIT.test(manifest.sourceCommit)) invalid();
  const files = new Map();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || files.has(entry.path) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) invalid();
    files.set(entry.path, entry);
  }
  for (const [relative, bytes] of [[EVIDENCE_PATH, evidenceBytes], [POLICY_PATH, regularBytes(root, POLICY_PATH)]]) {
    const entry = files.get(relative);
    if (!bytes || !entry || entry.sha256 !== sha(bytes) || entry.bytes !== bytes.length) invalid();
  }
  const contexts = validateEvidence(document, policy, policySha256, manifest.sourceCommit);
  // Proof applies only to deliberately omitted files, never a deleted runtime file.
  for (const [relative] of contexts) if (excludedContext(relative) && files.has(relative)) invalid();
  return { contexts, ci: document.ci, sourceCommit: document.sourceCommit, sha256: sha(evidenceBytes), gateSha256: document.gateSha256 };
}
module.exports = { FORMAT, EVIDENCE_PATH, POLICY_PATH, sha, invalid, exact, safePath, regularBytes, newlineHashes, excludedContext, validateEvidence, loadPackagedEvidence };
