'use strict';
// Pre-orchestrator generic-cash fixture. The enclosing native qualification
// authenticates its fresh cluster; this helper never creates a source header.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract'), S = require('../lib/tradefoto-full-import-source');
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function seedLegacyCashHistory({ access, vault, file, scopeId = 'grabenplaner-main', ownerId = '00001', clock = () => new Date().toISOString() }) {
  if (process.platform !== 'linux' || process.getuid() === 0 || Object.values(os.networkInterfaces()).flat().some(address => !address.internal)
    || access?.getCapabilities?.().providerId !== 'postgresql' || !path.isAbsolute(file || '') || fs.realpathSync(file) !== file) fail('GP_LEGACY_CASH_FIXTURE_ISOLATION');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size < 4096 || stat.size > S.MAX_BYTES) fail('GP_LEGACY_CASH_FIXTURE_SOURCE');
  C.id(scopeId); C.id(ownerId); if (typeof clock !== 'function') fail('GP_LEGACY_CASH_FIXTURE_CLOCK');
  const at = C.utc(clock()), buffer = fs.readFileSync(file), fileSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const protection = await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({ access, vault, create: true, clock });
  const defs = S.definitions('cash'), actor = { scopeId, ownerId }, runs = new Map(); let manifest = false, current = null, complete = false;
  try {
    const writers = require('../lib/persistence/repositories/import-history').createImportHistoryWriters({ protection, authorize: () => true, resolveMasterSourceInstance: () => 'tradefoto-trade' });
    const engine = require('../lib/data-import-engine').createDataImportEngine({ repository: require('../lib/persistence/repositories/data-import').createDataImportRepository(access), protection,
      profiles: defs.map(def => def.profile), writers, sharedPayloads: true, allowPartialApply: false, getActor: () => actor, authorize: () => true, clock,
      sourceTolerances: require('../lib/tradefoto-source-tolerances').TRADEFOTO_SOURCE_TOLERANCES });
    await S.readTradeFotoFullSource({ buffer, kind: 'cash', send: async event => {
      if (event.type === 'manifest') {
        if (manifest || event.fileSha256 !== fileSha256 || event.bytes !== stat.size || !C.equal(event.tables.map(t => [t.name, t.profileHash]), defs.map(d => [d.name, d.profile.fingerprint]))) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL');
        manifest = true; return;
      }
      if (!manifest || complete) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL');
      if (event.type === 'table') {
        if (current || event.name !== defs[runs.size]?.name || event.expectedRows < 1) fail('GP_LEGACY_CASH_FIXTURE_TABLE');
        current = defs[runs.size]; runs.set(event.name, await engine.start({ profileHash: current.profile.fingerprint, attemptId: 'synthetic-legacy-cash-v1',
          manifest: { sourceInstance: 'tradefoto-cash', fileSha256, schemaSha256: current.profile.schemaSha256, expectedRows: event.expectedRows, declaredRows: event.declaredRows, snapshotAt: at, gates: [] } }));
        return { resumeAfter: 0 };
      }
      if (event.type === 'rows') {
        if (!current || current.name !== event.name) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL');
        const run = runs.get(event.name); runs.set(event.name, await engine.stage(run.id, { expectedRevision: run.revision, startRow: event.startRow, rows: event.rows })); return;
      }
      if (event.type === 'table-complete') {
        if (!current || current.name !== event.name) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL');
        const run = runs.get(event.name); runs.set(event.name, await engine.seal(run.id, run.revision)); current = null; return;
      }
      if (event.type !== 'complete' || current || runs.size !== defs.length) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL'); complete = true;
    } });
    if (!complete) fail('GP_LEGACY_CASH_FIXTURE_PROTOCOL'); const result = [];
    for (const def of defs) {
      let run = runs.get(def.name), steps = 0;
      while (run.status === 'reviewing') { if (++steps > 1000) fail('GP_LEGACY_CASH_FIXTURE_LIMIT'); run = await engine.review(run.id, run.revision); }
      if (run.gates.length || run.status !== 'ready') fail('GP_LEGACY_CASH_FIXTURE_GATE');
      while (run.status !== 'applied') { if (++steps > 1000 || !['ready', 'applying'].includes(run.status)) fail('GP_LEGACY_CASH_FIXTURE_STATE'); run = await engine.apply(run.id, run.revision); }
      result.push({ table: def.name, runId: run.id, profileHash: def.profile.fingerprint, rows: run.receivedRows, status: run.status });
    }
    return { syntheticOnly: true, actualAccessParser: true, injectedReader: false, genericCashHistory: true, coreSourceHeaderCreated: false,
      fileSha256, bytes: stat.size, scopeId, ownerId, snapshotAt: at, tables: result.length, rows: result.reduce((n, run) => n + run.rows, 0), runs: result };
  } finally { buffer.fill(0); protection.destroy(); }
}
module.exports = { seedLegacyCashHistory };
