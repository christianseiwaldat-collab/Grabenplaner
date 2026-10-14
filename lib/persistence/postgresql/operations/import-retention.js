'use strict';
const C = require('../../../vps-storage-contract');
const { SOURCE_CATALOG } = require('../../../data-import-source-catalog');
const { definitions } = require('../../../tradefoto-full-import-source');
const T = require('../../../data-import-source-tolerance');
const { TRADEFOTO_SOURCE_TOLERANCES } = require('../../../tradefoto-source-tolerances');
const context = row => ['source', row.scope_id, row.owner_id, row.id, row.revision];
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const RETAINABLE = new Set(['applied', 'ready', 'needs_review', 'interrupted', 'purged']);
const LEGACY_TOLERANCE_EVENT = 'import.source-tolerance.accepted';
const TOLERANCE_RECEIPT_PATTERN = '^import[.]source-tolerance[.]accepted:[a-f0-9]{64}$';
function sourceReceipts(run) {
  const events = run.sourceToleranceEvents || [];
  // Match the engine's fail-closed receipt checks: a valid approval alongside
  // a malformed or foreign event must not authorize destructive retention.
  return Array.isArray(events) && events.every(event => T.sourceToleranceReceiptFingerprint(event)
    && event.runId === run.id && event.actorId === run.owner_id
    && Number.isSafeInteger(event.revision) && event.revision > 0 && event.revision <= run.revision) ? events : null;
}
function authenticatedSource(row, protection) {
  const data = protection.open(row.payload, context(row));
  const expected = protection.digest(['source', { scopeId: row.scope_id, ownerId: row.owner_id }, data.kind, data.fileSha256]);
  if (expected !== row.id || !SOURCE_CATALOG.some(item => item.available && item.kind === data.kind)) throw new Error('VPS_STORAGE_IMPORT_INTEGRITY');
  return { row, data };
}
function completeSuccessor(source, runs, { sourceTolerances = TRADEFOTO_SOURCE_TOLERANCES } = {}) {
  const registry = T.sourceToleranceRegistry(sourceTolerances);
  const d = source.data;
  if (!d.complete || d.status !== 'applied' || d.retirement || d.kind === 'cash'
      || d.kind === 'trade' && d.catalog?.complete !== true) return false;
  const required = definitions(d.kind);
  if (!Array.isArray(d.tables) || d.tables.length !== required.length) return false;
  return required.every((table, index) => {
    const entry = d.tables[index], run = runs.get(entry?.run?.id);
    if (entry?.name !== table.name || entry.profileHash !== table.profile.fingerprint || !run) return false;
    const manifest = json(run.manifest);
    const receipts = sourceReceipts(run);
    if (!receipts) return false;
    return run.scope_id === source.row.scope_id && run.owner_id === source.row.owner_id
      && run.profile_hash === table.profile.fingerprint && run.status === 'applied'
      && manifest.sourceInstance === 'tradefoto-' + d.kind && manifest.fileSha256 === d.fileSha256
      && manifest.schemaSha256 === table.profile.schemaSha256
      && Array.isArray(manifest.gates)
      && T.effectiveSourceGates(manifest, table.profile, registry, receipts).length === 0
      && run.received_count === entry.run.receivedRows && run.received_count === manifest.expectedRows
      && entry.declaredRows === manifest.declaredRows
      && !['invalid','conflict','staged','reverted'].some(state => entry.run.counts?.[state]) && !entry.run.gates?.length;
  });
}
function planSources(sources, runs, options) {
  const groups = new Map(), pairs = [], blocked = [];
  for (const source of [...sources].sort((a, b) => b.row.created_at.localeCompare(a.row.created_at) || b.row.id.localeCompare(a.row.id))) {
    const key = JSON.stringify([source.row.scope_id, source.row.owner_id, source.data.kind]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(source);
  }
  for (const group of groups.values()) {
    const latest = group[0], label = SOURCE_CATALOG.find(item => item.kind === latest.data.kind).fileName;
    if (!completeSuccessor(latest, runs, options)) {
      if (group.length > 1) blocked.push({ kind: latest.data.kind, label, reason: latest.data.kind === 'cash'
        ? 'Veröffentlichte Kassenstände werden gesondert geschützt.' : 'Der jüngste Import ist noch nicht vollständig übernommen und geprüft.' });
      continue;
    }
    for (const old of group.slice(1)) {
      if (old.data.storage === 'cash-compact-v1' || old.data.retirement?.complete
          || !RETAINABLE.has(old.data.status) || old.data.catalog?.pending || old.data.catalog?.pendingUndo
          || old.data.tables?.some(t => ['applying', 'reverting'].includes(runs.get(t.run?.id)?.status))) continue;
      const oldRuns = (old.data.tables || []).map(t => runs.get(t.run?.id)).filter(Boolean);
      if (!oldRuns.length || oldRuns.length !== old.data.tables.length || oldRuns.some(run => {
        const m = json(run.manifest);
        return !RETAINABLE.has(run.status) || run.scope_id !== old.row.scope_id || run.owner_id !== old.row.owner_id
          || m.sourceInstance !== 'tradefoto-' + old.data.kind || m.fileSha256 !== old.data.fileSha256;
      })) continue;
      pairs.push({ label, kind: old.data.kind, sourceId: old.row.id, sourceRevision: old.row.revision,
        successorId: latest.row.id, successorRevision: latest.row.revision,
        createdAt: old.row.created_at, successorCreatedAt: latest.row.created_at,
        runs: oldRuns.map(run => ({ id: run.id, revision: run.revision, status: run.status, rows: run.received_count })) });
    }
  }
  return { pairs, blocked, planSha256: C.digest(pairs) };
}
async function inspectImports(core, sales, protection, options) {
  const rows = (await core.query('SELECT id,scope_id,owner_id,revision::integer AS revision,created_at::text AS created_at,updated_at::text AS updated_at,payload FROM gp.data_import_sources ORDER BY created_at DESC,id DESC LIMIT 501')).rows;
  if (rows.length > 500) throw new Error('VPS_STORAGE_IMPORT_METADATA_LIMIT');
  const sources = rows.map(row => authenticatedSource(row, protection));
  const ids = [...new Set(sources.flatMap(s => (s.data.tables || []).map(t => t.run?.id).filter(Boolean)))];
  if (ids.length > 10000) throw new Error('VPS_STORAGE_IMPORT_METADATA_LIMIT');
  const runRows = ids.length ? (await sales.query('SELECT id,scope_id,owner_id,profile_hash,manifest,status,revision::integer AS revision,received_count::integer AS received_count FROM integration.data_import_runs WHERE id=ANY($1::text[])', [ids])).rows : [];
  const runs = new Map(runRows.map(row => [row.id, row]));
  const receipts = ids.length ? (await sales.query(`SELECT run_id,actor_id,revision::integer AS revision,action,at::text AS at
    FROM integration.data_import_events WHERE run_id=ANY($1::text[]) AND action LIKE $2`, [ids, T.SOURCE_TOLERANCE_EVENT_PREFIX+'%'])).rows : [];
  for (const event of receipts) {
    const run = runs.get(event.run_id);
    if (run) (run.sourceToleranceEvents ||= []).push({runId:event.run_id,actorId:event.actor_id,revision:event.revision,action:event.action,at:event.at});
  }
  const plan = planSources(sources, runs, options), eligibleIds = plan.pairs.flatMap(pair => pair.runs.map(run => run.id));
  const count = eligibleIds.length ? (await sales.query(`SELECT
    (SELECT count(*)::text FROM integration.data_import_rows WHERE run_id=ANY($1::text[])) AS rows,
    (SELECT count(*)::text FROM integration.data_import_changes WHERE run_id=ANY($1::text[])) AS changes`, [eligibleIds])).rows[0] : { rows: '0', changes: '0' };
  return { ...plan, rows: Number(count.rows), changes: Number(count.changes), sources, runs };
}
async function retireImports({ core, sales, protection, expectedPlan, progress = async () => {}, now = () => new Date().toISOString(), sourceTolerances = TRADEFOTO_SOURCE_TOLERANCES }) {
  const plan = await inspectImports(core, sales, protection, {sourceTolerances});
  if (plan.planSha256 !== expectedPlan) throw new Error('VPS_STORAGE_IMPORT_PLAN_CHANGED');
  if (!plan.pairs.length) throw new Error('VPS_STORAGE_NO_SUPERSEDED_IMPORTS');
  let removedRows = 0, removedChanges = 0, removedBlocks = 0;
  for (const pair of plan.pairs) {
    const source = plan.sources.find(s => s.row.id === pair.sourceId);
    // Durable Core intent precedes Sales work. A crash can resume this same
    // successor without offering an obsolete undo from a half-purged source.
    const intent = { successorId: pair.successorId, startedAt: source.data.retirement?.startedAt || now(), complete: false };
    source.data.retirement = intent;
    const updateSource = async complete => {
      const revision = source.row.revision;
      source.data.retirement.complete = complete;
      if (complete) {
        source.data.retirement.completedAt = now(); source.data.status = 'purged';
        // Retain only the small provenance envelope. Catalog rollback batches
        // and previous planning/selection details are import copies too.
        for (const field of ['catalog','progress','currentStep','dateProgress','selection','error','recheckedRun','excludedTableNames']) delete source.data[field];
        for (const table of source.data.tables) if (table.run) table.run = { id:table.run.id,status:'purged',receivedRows:table.run.receivedRows,canApply:false,
          ...(table.run.acceptedDeviations ? {acceptedDeviations:table.run.acceptedDeviations} : {}),
          ...(table.run.sourceToleranceReceipts ? {sourceToleranceReceipts:table.run.sourceToleranceReceipts} : {}) };
      }
      const payload = protection.seal(source.data, context({ ...source.row, revision: revision + 1 }));
      const result = await core.query('UPDATE gp.data_import_sources SET revision=revision+1,updated_at=$1,payload=$2 WHERE id=$3 AND revision=$4', [now(), payload, source.row.id, revision]);
      if (result.rowCount !== 1) throw new Error('VPS_STORAGE_IMPORT_PLAN_CHANGED');
      source.row.revision++;
    };
    await updateSource(false);
    for (const run of pair.runs) {
      while (true) {
        await sales.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        try {
          await sales.query("SET LOCAL lock_timeout='3s'");
          await sales.query("SET LOCAL statement_timeout='120s'");
          const fresh = (await sales.query('SELECT revision::integer AS revision,status FROM integration.data_import_runs WHERE id=$1 FOR UPDATE', [run.id])).rows[0];
          if (!fresh || fresh.revision !== run.revision || !RETAINABLE.has(fresh.status)) throw new Error('VPS_STORAGE_IMPORT_PLAN_CHANGED');
          const rows = (await sales.query('SELECT row_number::integer AS row_number FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number LIMIT 2000', [run.id])).rows;
          if (!rows.length) {
            // Approval evidence is tiny permanent provenance, not an obsolete
            // row/undo copy. Keep both legacy and exact-fingerprint receipts.
            await sales.query('DELETE FROM integration.data_import_events WHERE run_id=$1 AND action<>$2 AND action !~ $3',
              [run.id, LEGACY_TOLERANCE_EVENT, TOLERANCE_RECEIPT_PATTERN]);
            await sales.query('DELETE FROM integration.data_import_run_state_counts WHERE run_id=$1', [run.id]);
            await sales.query("UPDATE integration.data_import_runs SET status='purged',revision=revision+1,updated_at=$2 WHERE id=$1", [run.id, now()]);
            await sales.query('COMMIT'); break;
          }
          const through = rows.at(-1).row_number;
          const blocks = (await sales.query(`SELECT DISTINCT block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 AND row_number<=$2
            UNION SELECT DISTINCT block_id FROM integration.data_import_change_payload_refs WHERE run_id=$1 AND row_number<=$2`, [run.id, through])).rows.map(row => row.block_id);
          await sales.query('DELETE FROM integration.data_import_change_payload_refs WHERE run_id=$1 AND row_number<=$2', [run.id, through]);
          const changes = await sales.query('DELETE FROM integration.data_import_changes WHERE run_id=$1 AND row_number<=$2', [run.id, through]);
          await sales.query('DELETE FROM integration.data_import_row_payload_refs WHERE run_id=$1 AND row_number<=$2', [run.id, through]);
          const deleted = await sales.query('DELETE FROM integration.data_import_rows WHERE run_id=$1 AND row_number<=$2', [run.id, through]);
          let pruned = 0;
          if (blocks.length) pruned = (await sales.query(`DELETE FROM integration.data_import_payload_blocks b WHERE b.id=ANY($1::text[])
            AND NOT EXISTS(SELECT 1 FROM integration.data_import_row_payload_refs r WHERE r.block_id=b.id)
            AND NOT EXISTS(SELECT 1 FROM integration.data_import_change_payload_refs c WHERE c.block_id=b.id)`, [blocks])).rowCount;
          await sales.query('COMMIT');
          removedRows += deleted.rowCount; removedChanges += changes.rowCount; removedBlocks += pruned;
          await progress({ sourceId: source.row.id, removedRows, removedChanges, removedBlocks });
        } catch (error) { await sales.query('ROLLBACK'); throw error; }
      }
    }
    await updateSource(true);
  }
  return { retiredSources: plan.pairs.length, removedRows, removedChanges, removedBlocks, businessDataPreserved: true,
    retained: ['current-source', 'identity-links', 'business-records', 'business-references', 'indexes', 'minimal-provenance'] };
}
module.exports = { context, authenticatedSource, completeSuccessor, planSources, inspectImports, retireImports };
