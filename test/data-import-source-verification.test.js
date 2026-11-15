'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const T = require('../lib/data-import-source-tolerance');
const GATE = 'SOURCE_ROW_COUNT_MISMATCH';
const profile = {sourceSystem:'synthetic-source',sourceTable:'Rows',fingerprint:'a'.repeat(64),schemaSha256:'b'.repeat(64)};
const manifest = {sourceInstance:'synthetic-ledger',schemaSha256:profile.schemaSha256,fileSha256:'c'.repeat(64),
  declaredRows:1,expectedRows:2,gates:[GATE]};
function proofInput() { return {id:'synthetic-independent-verification',recordedAt:'2026-11-11T08:00:00.000Z',
  approvalReference:'explicit-owner-receipt-required',reason:'Independent synthetic logical and index scans agree',
  evidenceReference:'synthetic-independent-evidence',sourceSystem:profile.sourceSystem,sourceTable:profile.sourceTable,
  profileHash:profile.fingerprint,sourceInstance:manifest.sourceInstance,schemaSha256:profile.schemaSha256,
  fileSha256:manifest.fileSha256,declaredRows:manifest.declaredRows,expectedRows:manifest.expectedRows}; }

test('explicit verification mode accepts only an omitted flag or literal true and binds it to the proof fingerprint', () => {
  const legacy = T.defineDataImportSourceTolerance(proofInput());
  assert.equal(Object.hasOwn(legacy,'requiresExplicitApproval'),false);
  for (const flag of [false,null,undefined,'true',1])
    assert.throws(()=>T.defineDataImportSourceTolerance({...proofInput(),requiresExplicitApproval:flag}),
      error=>error.code==='IMPORT_TOLERANCE_INVALID');
  const pending = T.defineDataImportSourceTolerance({...proofInput(),requiresExplicitApproval:true});
  assert.notEqual(pending.fingerprint,legacy.fingerprint);
  assert.throws(()=>T.sourceToleranceRegistry([{...pending}]),error=>error.code==='IMPORT_TOLERANCE_UNTRUSTED');
});

test('installing independent verification makes evidence available while retaining the original count gate', () => {
  const pending = T.defineDataImportSourceTolerance({...proofInput(),requiresExplicitApproval:true});
  const registry = T.sourceToleranceRegistry([pending]);
  assert.equal(T.acceptSourceTolerances(manifest,profile,registry),manifest);
  assert.equal(T.matchingSourceTolerance(manifest,profile,registry),pending);
  assert.deepEqual(T.effectiveSourceGates(manifest,profile,registry),[GATE]);
  const wrongReceipt = {action:T.SOURCE_TOLERANCE_EVENT_PREFIX+'d'.repeat(64)};
  assert.ok(T.effectiveSourceGates(manifest,profile,registry,[wrongReceipt]).includes(GATE));
  const receipt = {action:T.SOURCE_TOLERANCE_EVENT_PREFIX+pending.fingerprint};
  assert.deepEqual(T.effectiveSourceGates(manifest,profile,registry,[receipt]),[]);
  assert.deepEqual(manifest.gates,[GATE]);
});

test('an inline independently verified proof cannot replace the separate approval receipt', () => {
  const pending = T.defineDataImportSourceTolerance({...proofInput(),requiresExplicitApproval:true});
  const registry = T.sourceToleranceRegistry([pending]);
  const inline = {...manifest,originalGates:[GATE],gates:[],acceptedDeviations:[pending]};
  assert.ok(T.effectiveSourceGates(inline,profile,registry).includes(GATE));
  const altered = {...inline,acceptedDeviations:[{...pending,requiresExplicitApproval:false}]};
  assert.ok(T.effectiveSourceGates(altered,profile,registry).includes('SOURCE_TOLERANCE_UNAVAILABLE'));
  const receipt = {action:T.SOURCE_TOLERANCE_EVENT_PREFIX+pending.fingerprint};
  assert.deepEqual(T.effectiveSourceGates(inline,profile,registry,[receipt]),[]);
  assert.ok(T.effectiveSourceGates(manifest,profile,[],[receipt]).includes('SOURCE_TOLERANCE_UNAVAILABLE'));
});
