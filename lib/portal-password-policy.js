'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const POLICY_VERSION = 1;
const MIN_CODE_POINTS = 15;
const MAX_CODE_POINTS = 256;
const MAX_UTF8_BYTES = 1024;
const MAX_CORPUS_BYTES = 32 * 1024 * 1024;
const DATA_DIRECTORY = path.join(__dirname, 'password-policy');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ERRORS = Object.freeze({
  type: ['PORTAL_PASSWORD_TYPE_INVALID', 'Bitte ein Passwort als Text eingeben.'],
  unicode: ['PORTAL_PASSWORD_UNICODE_INVALID', 'Das Passwort enthält eine ungültige Unicode-Zeichenfolge.'],
  too_short: ['PORTAL_PASSWORD_TOO_SHORT', 'Das neue Passwort muss mindestens 15 Zeichen lang sein.'],
  too_long: ['PORTAL_PASSWORD_TOO_LONG', 'Das neue Passwort darf höchstens 256 Zeichen und 1024 UTF-8-Bytes enthalten.'],
  common: ['PORTAL_PASSWORD_COMMON', 'Dieses Passwort wird zu häufig verwendet. Bitte eine andere, längere Passphrase wählen.'],
  breached: ['PORTAL_PASSWORD_COMPROMISED', 'Dieses Passwort ist aus einem Datenleck bekannt. Bitte ein anderes Passwort wählen.'],
  context: ['PORTAL_PASSWORD_CONTEXT', 'Das Passwort ist aus dem Konto- oder Anwendungsnamen leicht ableitbar. Bitte eine unabhängige Passphrase wählen.'],
  unavailable: ['PORTAL_PASSWORD_POLICY_UNAVAILABLE', 'Die lokale Passwortprüfung ist derzeit nicht verfügbar. Bitte die Administration verständigen.'],
});

function structuralReason(value) {
  if (typeof value !== 'string') return 'type';
  // Bound work before allocating the code-point array. A valid code point uses at most two UTF-16 units.
  if (value.length > MAX_CODE_POINTS * 2) return 'too_long';
  if (!value.isWellFormed()) return 'unicode';
  const length = [...value].length;
  if (length < MIN_CODE_POINTS) return 'too_short';
  if (length > MAX_CODE_POINTS || Buffer.byteLength(value, 'utf8') > MAX_UTF8_BYTES) return 'too_long';
  return null;
}

// Only complete, documented candidates are compared. No substring prohibition and no change to hashing input.
function contextCandidates(context = {}) {
  const supplied = context && typeof context === 'object' ? context : {};
  const names = ['Grabenplaner'];
  for (const key of ['loginName', 'employeeNumber', 'displayName', 'organizationName']) {
    const value = supplied[key];
    if (typeof value === 'string' && value.length <= 512 && value.isWellFormed()) names.push(value);
  }
  const candidates = new Set();
  const year = new Date().getUTCFullYear();
  const suffixes = ['', '1', '12', '123', '1234', '!', '1!', '123!',
    String(year - 1), String(year), String(year + 1), `${year - 1}!`, `${year}!`, `${year + 1}!`];
  for (const name of names) {
    const words = name.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (!words.length) continue;
    for (const base of new Set([words.join(' '), words.join(''), words.join('-'), words.join('_'), words.join('.')])) {
      for (const suffix of suffixes) {
        const candidate = base + suffix;
        if (structuralReason(candidate) === null) candidates.add(candidate);
      }
    }
  }
  return candidates;
}

function readArtifact(directory, specification, expectedFile) {
  if (!specification || specification.file !== expectedFile || !Number.isSafeInteger(specification.bytes)
      || specification.bytes < 1 || specification.bytes > MAX_CORPUS_BYTES
      || !/^[a-f0-9]{64}$/.test(specification.sha256 || '')) throw new Error('Invalid corpus manifest');
  const file = path.join(directory, expectedFile);
  if (fs.statSync(file).size !== specification.bytes) throw new Error('Invalid corpus size');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== specification.bytes || sha256(bytes) !== specification.sha256) throw new Error('Corpus integrity failure');
  return bytes;
}

function loadCorpus(directory) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (fs.statSync(manifestFile).size > 64 * 1024) throw new Error('Oversized manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.policyVersion !== POLICY_VERSION
      || manifest.minimumCodePoints !== MIN_CODE_POINTS || manifest.maximumCodePoints !== MAX_CODE_POINTS
      || manifest.maximumUtf8Bytes !== MAX_UTF8_BYTES || typeof manifest.corpusVersion !== 'string'
      || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(manifest.corpusVersion)
      || manifest.artifacts?.common?.count !== 3000 || !Number.isSafeInteger(manifest.artifacts?.breached?.count)
      || manifest.artifacts.breached.count < 3000) throw new Error('Incompatible corpus');
  const commonBytes = readArtifact(directory, manifest.artifacts.common, 'common-sha256.txt');
  const commonLines = commonBytes.toString('ascii').split('\n');
  if (commonLines.pop() !== '' || commonLines.length !== 3000
      || commonLines.some((line, index) => !/^[a-f0-9]{64}$/.test(line) || (index && commonLines[index - 1] >= line))) {
    throw new Error('Invalid common corpus');
  }
  const breached = readArtifact(directory, manifest.artifacts.breached, 'breached-sha256.bin');
  if (breached.length !== manifest.artifacts.breached.count * 32) throw new Error('Invalid breached corpus');
  for (let offset = 32; offset < breached.length; offset += 32) {
    if (Buffer.compare(breached.subarray(offset - 32, offset), breached.subarray(offset, offset + 32)) >= 0) {
      throw new Error('Unsorted breached corpus');
    }
  }
  return { manifest, common: new Set(commonLines), breached };
}

function includesDigest(sortedBytes, digest) {
  let low = 0, high = sortedBytes.length / 32 - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const comparison = Buffer.compare(sortedBytes.subarray(middle * 32, middle * 32 + 32), digest);
    if (comparison === 0) return true;
    if (comparison < 0) low = middle + 1; else high = middle - 1;
  }
  return false;
}

function createPasswordPolicy({ dataDirectory = DATA_DIRECTORY } = {}) {
  // Data is checked once per process and immutable thereafter. Updating the bundled corpus requires a restart.
  let corpus;
  try { corpus = loadCorpus(dataDirectory); } catch { corpus = null; }
  function result(reason) {
    return { accepted: reason === null, reason, policyVersion: POLICY_VERSION,
      corpusVersion: corpus?.manifest.corpusVersion || null };
  }
  function assessExistingPassword(value, context = {}) {
    const invalid = structuralReason(value);
    if (invalid) return result(invalid);
    if (!corpus) return result('unavailable');
    const digest = createHash('sha256').update(value, 'utf8').digest();
    if (corpus.common.has(digest.toString('hex'))) return result('common');
    if (includesDigest(corpus.breached, digest)) return result('breached');
    if (contextCandidates(context).has(value.toLowerCase())) return result('context');
    return result(null);
  }
  function assertNewPassword(value, context = {}) {
    const assessment = assessExistingPassword(value, context);
    if (assessment.accepted) return assessment;
    const [code, message] = ERRORS[assessment.reason];
    throw Object.assign(new Error(message), { status: assessment.reason === 'unavailable' ? 503 : 400, code,
      reason: assessment.reason, policyVersion: POLICY_VERSION });
  }
  function metadata() {
    return { policyVersion: POLICY_VERSION, corpusVersion: corpus?.manifest.corpusVersion || null,
      minLength: MIN_CODE_POINTS, maxLength: MAX_CODE_POINTS, minCodePoints: MIN_CODE_POINTS,
      maxCodePoints: MAX_CODE_POINTS, maxUtf8Bytes: MAX_UTF8_BYTES, available: Boolean(corpus) };
  }
  return Object.freeze({ assessExistingPassword, assertNewPassword, metadata });
}

const policy = createPasswordPolicy();
module.exports = { POLICY_VERSION, MIN_CODE_POINTS, MAX_CODE_POINTS, MAX_UTF8_BYTES,
  assessExistingPassword: policy.assessExistingPassword, assertNewPassword: policy.assertNewPassword,
  metadata: policy.metadata, createPasswordPolicy };
