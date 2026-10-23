'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
function invalid() { throw Object.assign(new Error('Die SAST-Bewertungen konnten nicht vollständig verifiziert werden.'), { code: 'SECURITY_AUDIT_SAST_INVALID', statusCode: 503 }); }
function safePath(value) {
  return typeof value === 'string' && value.length <= 500 && value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/[:\x00-\x1f]/.test(value);
}
function fileBytes(root, relative, max) {
  if (!safePath(relative)) invalid();
  const file = path.resolve(root, relative), realRoot = fs.realpathSync(root);
  try {
    const stat = fs.lstatSync(file), real = fs.realpathSync(file), rel = path.relative(realRoot, real);
    if (!stat.isFile() || stat.isSymbolicLink() || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || stat.size > max) invalid();
    return fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function variants(original, values) {
  if (!HASH.test(original || '') || !Array.isArray(values) || values.length < 1 || values.length > 3
    || values.some(value => !HASH.test(value)) || new Set(values).size !== values.length || !values.includes(original)) invalid();
  return values;
}
function projectSastReviews(policy, { root, now = new Date(), policySha256 = '' }) {
  const instant = new Date(now), today = instant.toISOString().slice(0, 10);
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.dispositions) || policy.dispositions.length > 20000) invalid();
  const sourceHashes = new Map(), seen = new Set();
  const readSource = relative => {
    if (!sourceHashes.has(relative)) { const bytes = fileBytes(root, relative, 32 * 1024 * 1024); sourceHashes.set(relative, bytes === null ? null : sha(bytes)); }
    return sourceHashes.get(relative);
  };
  const reviews = policy.dispositions.map(row => {
    if (!safePath(row.path) || typeof row.rule !== 'string' || row.rule.length > 300 || !row.rule
      || !['P0', 'P1', 'P2', 'P3'].includes(row.priority) || row.classification !== 'reviewed_false_positive'
      || typeof row.reason !== 'string' || row.reason.trim().length < 80 || row.reason.length > 12000
      || typeof row.reviewer !== 'string' || !row.reviewer.trim() || row.reviewer.length > 1000
      || !validDate(row.reviewedOn) || !validDate(row.expiresOn) || row.reviewedOn > today) invalid();
    for (const point of [row.start, row.end]) if (!Number.isSafeInteger(point?.line) || point.line < 1 || !Number.isSafeInteger(point?.column) || point.column < 1) invalid();
    if (row.end.line < row.start.line || (row.end.line === row.start.line && row.end.column < row.start.column)) invalid();
    const identity = sha(JSON.stringify([row.rule, row.path, row.start.line, row.start.column, row.end.line, row.end.column]));
    if (identity !== row.fingerprint || seen.has(identity)) invalid();
    seen.add(identity);
    const sourceVariants = variants(row.sourceSha256, row.sourceSha256Variants);
    const duration = (Date.parse(row.expiresOn) - Date.parse(row.reviewedOn)) / 86400000;
    if (duration < 0 || duration > (['P0', 'P1'].includes(row.priority) ? 14 : 30)) invalid();
    if (!Array.isArray(row.context) || !row.context.length || row.context.length > 100) invalid();
    const contextPaths = new Set();
    const context = row.context.map(item => {
      if (!safePath(item.path) || contextPaths.has(item.path) || typeof item.reason !== 'string' || item.reason.length < 20 || item.reason.length > 12000) invalid();
      contextPaths.add(item.path);
      const accepted = variants(item.sha256, item.sha256Variants), actualSha256 = readSource(item.path);
      return { path: item.path, reason: item.reason, sha256: item.sha256, actualSha256,
        state: actualSha256 === null ? 'not_installed' : accepted.includes(actualSha256) ? 'matches' : 'changed' };
    });
    const own = row.context.find(item => item.path === row.path);
    if (!own || own.sha256 !== row.sourceSha256 || JSON.stringify([...own.sha256Variants].sort()) !== JSON.stringify([...sourceVariants].sort())) invalid();
    const daysRemaining = Math.round((Date.parse(row.expiresOn) - Date.parse(today)) / 86400000);
    const deadlineState = daysRemaining < 0 ? 'expired' : daysRemaining <= 14 ? 'due_soon' : 'current';
    const sourceState = context.some(item => item.state === 'changed') ? 'changed' : context.some(item => item.state === 'not_installed') ? 'incomplete' : 'matches';
    return { fingerprint: identity, rule: row.rule, path: row.path, start: row.start, end: row.end,
      priority: row.priority, classification: row.classification, reason: row.reason, reviewer: row.reviewer,
      reviewedOn: row.reviewedOn, expiresOn: row.expiresOn, daysRemaining, deadlineState, sourceState,
      requiresReview: deadlineState !== 'current' || sourceState !== 'matches', sourceSha256: row.sourceSha256, context };
  });
  reviews.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.path.localeCompare(b.path) || a.start.line - b.start.line || a.fingerprint.localeCompare(b.fingerprint));
  const count = predicate => reviews.filter(predicate).length;
  return { schemaVersion: 1, generatedAt: instant.toISOString(), deadlineTimeZone: 'UTC', policySha256,
    capabilities: { read: true, managePolicy: false },
    summary: { total: reviews.length, expired: count(row => row.deadlineState === 'expired'), dueSoon: count(row => row.deadlineState === 'due_soon'),
      sourceChanged: count(row => row.sourceState === 'changed'), contextIncomplete: count(row => row.sourceState === 'incomplete'),
      requiresReview: count(row => row.requiresReview), nextExpiry: reviews[0]?.expiresOn || null },
    limits: ['Diese Ansicht zeigt die mitgelieferten Einzelbewertungen. Sie ersetzt keinen vollständigen Scan des aktuellen Quellstands.',
      'Fehlende Prüfdateien in einem Serverpaket sind kein Änderungsnachweis; der vollständige Prüfkontext muss im Quellstand erneut verifiziert werden.',
      'Eine Bewertung gilt nur für die dokumentierte Fundstelle und ihren Prüfkontext. Neue Quellen, abgelaufene Fristen oder neue Hinweise benötigen eine erneute Bewertung.',
      'Fristen gelten einschließlich des angegebenen Tages in UTC. Automatisierte Bewertungen sind keine menschlichen Freigaben.'], reviews };
}
function readSastReviews({ root = path.resolve(__dirname, '..'), now = new Date() } = {}) {
  try {
    const bytes = fileBytes(root, 'lib/security-audits/sast-dispositions.json', 16 * 1024 * 1024)
      ?? fileBytes(root, 'scripts/security/sast-dispositions.json', 16 * 1024 * 1024);
    if (bytes === null) invalid();
    return projectSastReviews(JSON.parse(bytes.toString('utf8')), { root, now, policySha256: sha(bytes) });
  } catch (error) { if (error.code === 'SECURITY_AUDIT_SAST_INVALID') throw error; invalid(); }
}
module.exports = { readSastReviews, projectSastReviews };
