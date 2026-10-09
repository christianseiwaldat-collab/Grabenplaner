'use strict';
const C = require('./data-import-contract'), D = require('./tradefoto-bestell/decimal');
const M = require('./sales-bwl-simulation-model'), Data = require('./sales-article-report-data'), S = require('./sales-bwl-simulation-statements');
function createSalesBwlSimulationSnapshots(options) { return require('./sales-bwl-abc-store').createSalesBwlAbcStore(options); }
const contextFor = (env, auth, fingerprint) => ['bwl-simulation-snapshot-v1', env.scopeId, auth.identity, fingerprint];
async function context(env) {
  const result = M.unavailableContext(env.session), active = await env.source('ARTIKEL_FILIALEN', 'tradefoto-trade');
  const locations = (await Data.locationsFor(env)).filter(l => l.locationId).map(l => ({ id: l.id, label: l.label }));
  return { ...result, available: !!active, locations, sourceAt: active?.manifest.snapshotAt || null, sourceFingerprint: await S.fingerprint(env.tx, env.scopeId, env.protection) };
}
async function calculate(env, input) {
  const auth = M.authority(env.session), normalized = M.normalize(input, auth.caps), q = normalized.filters;
  const available = (await Data.locationsFor(env)).filter(l => l.locationId);
  if (q.locations.some(id => !available.some(l => l.id === id))) C.fail('BWL_SIMULATION_FORBIDDEN', 403);
  const branches = available.filter(l => !q.locations.length || q.locations.includes(l.id)), active = await env.source('ARTIKEL_FILIALEN', 'tradefoto-trade');
  if (!active) C.fail('BWL_SIMULATION_SOURCE_UNAVAILABLE', 503);
  const sourceFingerprint = await S.fingerprint(env.tx, env.scopeId, env.protection);
  // Tax fields are read with the separate current price projection; EK fields
  // remain governed by the existing catalog + inventory cost permissions.
  const selection = await Data.articleCandidates(env, { ...auth.caps, margin: auth.caps.prices }, q);
  const stock = await Data.stockRows(env, active, branches, selection.candidates);
  const rows = stock.pairs.map(pair => M.currentRow({ ...pair, catalog: selection.catalog.get(String(pair.source.EAN)) }, auth.caps))
    .filter(r => q.stock !== 'positive' || r.quantity !== null && D.compare(r.quantity, '0') > 0)
    .sort((a, b) => a.articleNumber.localeCompare(b.articleNumber, 'de-AT', { numeric: true }) || a.locationId.localeCompare(b.locationId) || a.id.localeCompare(b.id));
  const snapshot = M.calculate(rows, normalized, auth.caps, { sourceAt: active.manifest.snapshotAt, sourceFingerprint,
    generatedAt: new Date().toISOString(), scanned: stock.scanned, candidateScanned: selection.scanned });
  if (Buffer.byteLength(C.canonical(snapshot)) > M.LIMITS.snapshotBytes) C.fail('BWL_SIMULATION_LIMIT', 413);
  await env.fresh(env.tx);
  const context = contextFor(env, auth, sourceFingerprint), analysisId = env.simulationSnapshots.begin(context);
  return { snapshot, snapshotToken: env.simulationSnapshots.put(env.protection, context, analysisId, 'snapshot', snapshot) };
}
async function run(env, operation, input) {
  const auth = M.authority(env.session);
  if (operation === 'context') { C.exact(input, []); return context(env); }
  if (operation === 'calculate') return calculate(env, input);
  if (operation === 'snapshot') {
    C.exact(input, ['snapshotToken']); C.text(input.snapshotToken, 16384);
    const fingerprint = await S.fingerprint(env.tx, env.scopeId, env.protection);
    try { return env.simulationSnapshots.read(env.protection, contextFor(env, auth, fingerprint), input.snapshotToken).value; }
    catch (error) { if (error.status === 413) throw error; C.fail('BWL_SIMULATION_SNAPSHOT_EXPIRED', 409); }
  }
  C.fail('BWL_SIMULATION_OPERATION_INVALID');
}
module.exports = { run, context, calculate, createSalesBwlSimulationSnapshots };
