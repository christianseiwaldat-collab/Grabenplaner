"use strict";
const C = require('./data-import-contract');
const TRUSTED = new WeakSet();
const GATE = 'SOURCE_ROW_COUNT_MISMATCH';
// Composition-only capability. No upload/HTTP manifest can create an approval.
function defineDataImportSourceTolerance(input) {
  C.exact(input, ['id', 'recordedAt', 'approvalReference', 'reason', 'evidenceReference',
    'sourceSystem', 'sourceInstance', 'sourceTable', 'profileHash', 'schemaSha256', 'fileSha256', 'declaredRows', 'expectedRows']);
  const proof = { id: C.id(input.id), gate: GATE, recordedAt: C.utc(input.recordedAt),
    approvalReference: C.text(input.approvalReference, 240), reason: C.text(input.reason, 1000), evidenceReference: C.text(input.evidenceReference, 300),
    sourceSystem: C.id(input.sourceSystem), sourceInstance: C.id(input.sourceInstance), sourceTable: C.text(input.sourceTable),
    profileHash: C.sha(input.profileHash), schemaSha256: C.sha(input.schemaSha256), fileSha256: C.sha(input.fileSha256),
    declaredRows: C.integer(input.declaredRows), expectedRows: C.integer(input.expectedRows) };
  if (proof.expectedRows >= proof.declaredRows) C.fail('IMPORT_TOLERANCE_INVALID');
  proof.fingerprint = C.fingerprint(proof);
  C.freeze(proof); TRUSTED.add(proof); return proof;
}
function sourceToleranceRegistry(proofs) {
  if (!Array.isArray(proofs) || proofs.some(p => !TRUSTED.has(p)) || new Set(proofs.map(p => p.id)).size !== proofs.length) C.fail('IMPORT_TOLERANCE_UNTRUSTED');
  return Object.freeze([...proofs]);
}
function matches(proof, manifest, profile) {
  return proof.sourceSystem === profile.sourceSystem && proof.sourceTable === profile.sourceTable && proof.profileHash === profile.fingerprint
    && proof.schemaSha256 === profile.schemaSha256
    && ['sourceInstance', 'schemaSha256', 'fileSha256', 'declaredRows', 'expectedRows'].every(key => proof[key] === manifest[key]);
}
function acceptSourceTolerances(manifest, profile, registry) {
  const proof = registry.find(p => matches(p, manifest, profile));
  if (!proof || !manifest.gates.includes(GATE)) return manifest;
  return C.freeze({ ...manifest, originalGates: [...manifest.gates], gates: manifest.gates.filter(g => g !== GATE), acceptedDeviations: [proof] });
}
function originalManifest(manifest) {
  if (!manifest.acceptedDeviations) return manifest;
  const { originalGates, acceptedDeviations, ...original } = manifest;
  return { ...original, gates: originalGates };
}
function effectiveSourceGates(manifest, profile, registry) {
  const gates = [...manifest.gates];
  if (manifest.acceptedDeviations?.some(proof => !registry.some(p => C.equal(p, proof) && matches(p, manifest, profile)))) gates.push('SOURCE_TOLERANCE_UNAVAILABLE');
  return gates;
}
module.exports = { defineDataImportSourceTolerance, sourceToleranceRegistry, acceptSourceTolerances, originalManifest, effectiveSourceGates };
