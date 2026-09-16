'use strict';
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const H = require('../../tradefoto-history-profiles');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../statements/cash-publications');
const { CASH_SNAPSHOT_STATEMENTS: SNAPSHOTS, CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const { IMPORT_MASTER_STATEMENTS: M } = require('../statements/import-master-data');
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require('../../tradefoto-article-source-profile');
const { createCashSnapshotStore } = require('./cash-snapshots');
const { defineTradeFotoSalesPolicy } = require('../../tradefoto-sales-rules');
const { resolveCashSalesPolicy } = require('../../cash-source-policies');
const { CASH_PUBLICATION_BATCHES: BATCHES } = require('../statements/cash-publication-batches');
const FIELDS = Object.freeze({ FILIALEN: 'locationKey', MITARBEITER: 'sellerKey', ARTIKEL_STAMM: 'articleKey', KUNDEN: 'customerKey' });
const stateContext = r => ['cash-publication-state-v1', r.scopeId, r.revision];
const publicationContext = r => ['cash-publication-v1', r.id, r.scopeId, r.datasetId, r.ownerId, r.createdAt];
const bindingContext = r => ['cash-publication-binding-v1', r.publicationId, r.kind, Buffer.from(r.sourceKey).toString('hex'), r.targetId, r.historical];
const same = (a, b) => { if (!C.equal(a, b)) C.fail('IMPORT_HISTORY_INTEGRITY'); };
function createCashPublications({ access, protection, scopeId, policies = [], clock = () => new Date().toISOString() }) {
  C.id(scopeId);
  const batched=access.getCapabilities?.().providerId==='postgresql';
  const referenceKey = (kind, value) => Buffer.from(protection.digest(['cash-compact-v1', 'source-reference', scopeId, FIELDS[kind], String(value)]), 'hex');
  async function state(tx) {
    const row = await tx.queryOne(S.state, { scopeId });
    if (!row) return { row: { scopeId, revision: 0 }, data: { active: null, previous: null, events: [] } };
    const data = protection.open(row.payload, stateContext(row));
    C.exact(data, ['active', 'previous', 'events']);
    if (data.active) C.sha(data.active); if (data.previous) C.sha(data.previous);
    if (!Array.isArray(data.events)) C.fail('IMPORT_HISTORY_INTEGRITY');
    return { row, data };
  }
  async function candidate(tx, id, ownerId) {
    const reader = createCashSnapshotStore({ access, protection, actor: { scopeId, ownerId } }).reader;
    const dataset = await reader.load(tx, id);
    if (!dataset.data.complete || dataset.data.status !== 'ready' || dataset.data.tables.some(t => !t.verified || !t.complete || t.verifiedRows !== t.expectedRows || t.sourceHash !== t.verifiedHash)) C.fail('IMPORT_SOURCE_INCOMPLETE', 409);
    // Sealed verification evidence binds the transactionally maintained counts
    // and generations. Legacy verified datasets use the migration's generation
    // zero; a later source mutation cannot become a new trusted baseline.
    const inventory = await tx.queryAll(SNAPSHOTS.inventory, { datasetSlot: dataset.row.slot });
    same(inventory.length, TABLES.length);
    dataset.data.tables.forEach((table, index) => same(inventory[index], {
      tableIndex: index, rowCount: table.expectedRows, generation: table.verifiedGeneration ?? 0,
    }));
    return { reader, dataset };
  }
  async function load(tx, id) {
    C.sha(id); const row = await tx.queryOne(S.publication, { id, scopeId });
    if (!row) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    const data = protection.open(row.payload, publicationContext(row));
    const result = await candidate(tx, row.datasetId, row.ownerId);
    same(data.fileSha256, result.dataset.data.fileSha256);
    same(data.sourceEvidence, C.fingerprint(result.dataset.data.tables.map(t => [t.name, t.expectedRows, t.sourceHash])));
    same(await tx.queryOne(S.bindingInventory, { publicationId: id }), { rowCount: data.bindingCount, generation: data.bindingGeneration ?? 0 });
    const policy = defineTradeFotoSalesPolicy(data.policy);
    same(policy.fingerprint, data.policyFingerprint);
    return { row, data, policy: resolveCashSalesPolicy(policy), ...result };
  }
  async function references(tx, dataset, reader, kind, after = '', limit = 100) {
    if (!Object.hasOwn(FIELDS, kind)) C.fail('IMPORT_MASTER_KIND_INVALID');
    C.integer(limit, 1, 1000); if (after) C.sha(after);
    const records = await tx.queryAll(S.references[kind], { datasetSlot: dataset.row.slot, after: after ? Buffer.from(after, 'hex') : Buffer.alloc(0), limit: limit + 1 });
    const selected=records.slice(0,limit),prefetched=new Map();
    if(batched)for(const index of new Set(selected.map(r=>r.tableIndex))){
      const wanted=[...new Set(selected.filter(r=>r.tableIndex===index).map(r=>r.sourceRow))];
      if(!TABLES[index])C.fail('IMPORT_HISTORY_INTEGRITY');
      const found=await tx.queryAll(BATCHES.rows[index],{datasetSlot:dataset.row.slot,rows:wanted});
      if(found.length!==wanted.length)C.fail('IMPORT_HISTORY_INTEGRITY');
      for(const row of found){
        const key=index+':'+row.sourceRow;
        if(row.datasetSlot!==dataset.row.slot||!wanted.includes(row.sourceRow)||prefetched.has(key))C.fail('IMPORT_HISTORY_INTEGRITY');
        prefetched.set(key,row);
      }
    }
    const items = [], seen = new Set();
    for (const record of selected) {
      const key = Buffer.from(record.sourceKey).toString('hex'); if (seen.has(key)) continue; seen.add(key);
      const table = TABLES[record.tableIndex], row = batched?prefetched.get(record.tableIndex+':'+record.sourceRow):await tx.queryOne(table.statements.row, { datasetSlot: dataset.row.slot, sourceRow: record.sourceRow });
      if (!row) C.fail('IMPORT_HISTORY_INTEGRITY');
      const decoded = reader.decode(dataset, table, row);
      const ref = H.historyReferenceRequests('cash', table.name, decoded.normalized.data).find(r => r.table === kind && r.key && referenceKey(kind, r.key[0]).equals(Buffer.from(record.sourceKey)));
      if (!ref || !Buffer.from(row[FIELDS[kind]]).equals(Buffer.from(record.sourceKey))) C.fail('IMPORT_HISTORY_INTEGRITY');
      items.push({ sourceId: ref.key[0], key });
    }
    return { items, next: records.length > limit ? Buffer.from(records[limit - 1].sourceKey).toString('hex') : null };
  }
  async function allReferences(tx, dataset, reader, kind) {
    const result = new Map(); let after = '';
    do { const page = await references(tx, dataset, reader, kind, after, 1000); for (const r of page.items) result.set(r.sourceId, r.key); after = page.next; } while (after);
    return result;
  }
  async function verifiedBindings(tx, publication, kind) {
    const records = await tx.queryAll(S.bindings, { publicationId: publication.row.id, kind, limit: 10001 });
    same(records.length, publication.data.bindingCounts[kind]);
    return records.map(row => {
      const data = protection.open(row.payload, bindingContext(row));
      same([data.kind, data.sourceKey, data.targetId, data.historical], [kind, Buffer.from(row.sourceKey).toString('hex'), row.targetId, row.historical]);
      same(Buffer.from(referenceKey(kind, data.sourceId)).toString('hex'), data.sourceKey);
      return data;
    });
  }
  async function mappingSetup(tx, dataset, reader, current, projection) {
    const targets = [], mappings = [], locations = [];
    let omitted = 0;
    const canLocate = projection.tables.some(t => t.table === 'FILIALEN' && t.write);
    if (canLocate) {
      let after = '';
      do {
        const page = await tx.queryAll(M.locationTargets, { query: '', after, limit: 1000 });
        targets.push(...page); after = page.length === 1000 ? page.at(-1).id : '';
        if (targets.length > 10000) C.fail('IMPORT_COMPOSITION_INVALID');
      } while (after);
    }
    const previous = current.data.active ? await load(tx, current.data.active) : null;
    // Only reuse sealed, still valid bindings for categories the current user
    // may manage. Article bindings are resolved against the current catalog by
    // the existing resolveArticles option during preview.
    for (const kind of ['FILIALEN', 'MITARBEITER', 'KUNDEN']) {
      if (!projection.tables.some(t => t.table === kind && t.write)) continue;
      const old = previous ? await verifiedBindings(tx, previous, kind) : [];
      if (kind !== 'FILIALEN' && !old.length) continue;
      const references = await allReferences(tx, dataset, reader, kind), prior = new Map(old.map(m => [m.sourceId, m]));
      const numeric = value => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : null, sourceNumbers = new Map();
      if (kind === 'FILIALEN') for (const sourceId of references.keys()) {
        const key = numeric(sourceId); sourceNumbers.set(key, (sourceNumbers.get(key) || 0) + 1);
      }
      for (const sourceId of references.keys()) {
        const binding = prior.get(sourceId);
        const target = binding ? kind === 'FILIALEN' ? targets.find(t => t.id === binding.targetId)
          : await tx.queryOne(kind === 'MITARBEITER' ? M.employee : M.crmGet, { id: binding.targetId }) : null;
        const reusable = target && (target.active !== false || binding.historical);
        if (binding && !reusable) omitted++;
        if (kind === 'FILIALEN') {
          // Exact IDs first. A padding-only match is a visible suggestion, and
          // is offered only when it points to one existing active location.
          const exact = targets.find(t => t.active && t.id === sourceId);
          const matches = exact ? [exact] : targets.filter(t => t.active && numeric(sourceId) !== null && sourceNumbers.get(numeric(sourceId)) === 1 && numeric(t.id) === numeric(sourceId));
          const suggested = reusable ? target : !binding && matches.length === 1 ? matches[0] : null;
          locations.push({ sourceId, targetId: suggested?.id || '', historical: !!(reusable && binding.historical),
            match: reusable ? 'previous' : suggested ? 'same_id' : null });
        } else if (reusable) mappings.push({ kind, sourceId, targetId: target.id, historical: binding.historical });
      }
    }
    locations.sort((a, b) => a.sourceId.localeCompare(b.sourceId, 'de', { numeric: true }) || a.sourceId.localeCompare(b.sourceId));
    return { locations, targets, mappings, omitted };
  }
  async function plan(tx, actor, input, projection, sessionSignature) {
    C.exact(input, ['sourceId', 'expectedRevision', 'mappings', 'resolveArticles', 'label', 'policyId']);
    C.sha(input.sourceId); C.integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER); C.text(input.label, 160); C.id(input.policyId);
    if (typeof input.resolveArticles !== 'boolean' || !Array.isArray(input.mappings) || input.mappings.length > 10000) C.fail('IMPORT_COMPOSITION_INVALID');
    const current = await state(tx); if (current.row.revision !== input.expectedRevision) C.fail('IMPORT_REVISION_CONFLICT', 409);
    const { reader, dataset } = await candidate(tx, input.sourceId, actor.ownerId);
    const selectedPolicy = policies.find(p => p.id === input.policyId && (p.appliesTo === 'matching_cash_schema' || p.fileSha256 === dataset.data.fileSha256));
    if (!selectedPolicy) C.fail('IMPORT_SALES_POLICY_UNTRUSTED');
    const definition = { ...selectedPolicy.policy, scopeId, sourceInstance: 'tradefoto-cash' };
    const policy = defineTradeFotoSalesPolicy(definition);
    const requested = input.mappings.map(m => {
      C.exact(m, ['kind', 'sourceId', 'targetId', 'historical']);
      if (!Object.hasOwn(FIELDS, m.kind) || !projection.tables.some(t => t.table === m.kind && t.write)) C.fail('IMPORT_FORBIDDEN', 403);
      C.text(m.sourceId, 255); C.id(m.targetId); if (m.sourceId === '0' || typeof m.historical !== 'boolean') C.fail('IMPORT_MAPPING_SOURCE_UNAVAILABLE', 409);
      return { ...m };
    });
    const sources = new Map(), bindings = [], locations = [], unique = new Set();
    const explicitArticles = new Set(requested.filter(m => m.kind === 'ARTIKEL_STAMM').map(m => m.sourceId));
    if (input.resolveArticles && !projection.tables.some(t => t.table === 'ARTIKEL_STAMM' && t.write)) C.fail('IMPORT_FORBIDDEN', 403);
    for (const kind of new Set([...requested.map(m => m.kind), ...(input.resolveArticles ? ['ARTIKEL_STAMM'] : [])])) sources.set(kind, await allReferences(tx, dataset, reader, kind));
    const articleTargets=new Map();
    if(batched){
      const keys=[...new Set(input.resolveArticles?[...sources.get('ARTIKEL_STAMM').keys()]:requested.filter(m=>m.kind==='ARTIKEL_STAMM').map(m=>m.sourceId))];
      for(let offset=0;offset<keys.length;offset+=1000){
        const chunk=keys.slice(offset,offset+1000);
        for(const row of await tx.queryAll(BATCHES.articles,{sourceSystem:TRADEFOTO_ARTICLE_SOURCE_SYSTEM,keys:chunk})){
          const {sourceArticleKey,...target}=row;
          if(!chunk.includes(sourceArticleKey)||articleTargets.has(sourceArticleKey))C.fail('IMPORT_HISTORY_INTEGRITY');
          articleTargets.set(sourceArticleKey,target);
        }
      }
    }
    const articleTarget=sourceId=>batched?articleTargets.get(sourceId)||null:tx.queryOne(M.articleBySource,{sourceSystem:TRADEFOTO_ARTICLE_SOURCE_SYSTEM,sourceArticleKey:sourceId});
    if (input.resolveArticles) for (const [sourceId] of sources.get('ARTIKEL_STAMM')) {
      if (explicitArticles.has(sourceId)) continue;
      const target = await articleTarget(sourceId);
      if (target) requested.push({ kind: 'ARTIKEL_STAMM', sourceId, targetId: target.id, historical: !target.active });
    }
    for (const m of requested) {
      const key = sources.get(m.kind)?.get(m.sourceId); if (!key) C.fail('IMPORT_MAPPING_SOURCE_UNAVAILABLE', 409);
      const identity = m.kind + ':' + key; if (unique.has(identity)) C.fail('IMPORT_MAPPING_DUPLICATE', 409); unique.add(identity);
      const target = m.kind==='ARTIKEL_STAMM'?await articleTarget(m.sourceId):await tx.queryOne(m.kind === 'FILIALEN' ? M.location : m.kind === 'MITARBEITER' ? M.employee : M.crmGet,{id:m.targetId});
      if (!target || target.id !== m.targetId) C.fail('IMPORT_MAPPING_TARGET_MISSING', 409);
      if (target.active === false && !m.historical) C.fail('IMPORT_MAPPING_INACTIVE_TARGET', 409);
      if (m.kind === 'FILIALEN' && !locations.some(l => l.id === target.id)) {
        const labels = await tx.queryAll(M.locationTargets, { query: target.id, after: '', limit: 100 });
        locations.push({ id: target.id, label: labels.find(l => l.id === target.id)?.label || target.id });
      }
      // CRM/personnel source fields never enter the publication; only an explicit
      // reference and its target revision/state are sealed for this dataset.
      bindings.push({ kind: m.kind, sourceId: m.sourceId, sourceKey: key, targetId: target.id, historical: m.historical,
        targetRevision: target.revision || null, targetActive: target.active ?? null });
    }
    if (!locations.length) C.fail('IMPORT_MAPPING_LOCATION_REQUIRED', 409);
    bindings.sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceKey.localeCompare(b.sourceKey));
    const data = { label: input.label, createdBy: actor.ownerId, datasetRevision: dataset.row.revision, fileSha256: dataset.data.fileSha256,
      bindingCount: bindings.length, bindingGeneration: bindings.length,
      bindingCounts: Object.fromEntries(Object.keys(FIELDS).map(kind => [kind, bindings.filter(b => b.kind === kind).length])),
      locations, policy: definition, policyFingerprint: policy.fingerprint,
      sourceEvidence: C.fingerprint(dataset.data.tables.map(t => [t.name, t.expectedRows, t.sourceHash])) };
    const planHash = protection.digest(['cash-activation-plan-v1', actor, sessionSignature, current, input.sourceId, data, bindings]);
    return { current, dataset, data, bindings, planHash };
  }
  async function writeState(tx, previous, data) {
    const revision = previous.row.revision + 1, row = { scopeId, revision, payload: protection.seal(data, stateContext({ scopeId, revision })) };
    const result = revision === 1 ? await tx.execute(S.insertState, row) : await tx.execute(S.updateState, { ...row, revision: previous.row.revision });
    if (result.rowsAffected !== 1) C.fail('IMPORT_REVISION_CONFLICT', 409);
    return revision;
  }
  return Object.freeze({ state, load, candidate, references, referenceKey, mappingSetup,
    async verifyFilterBindings(tx, publication, kind) {
      await verifiedBindings(tx, publication, kind);
    },
    async active(tx) { const current = await state(tx); return current.data.active ? load(tx, current.data.active) : null; },
    plan,
    async activate(tx, actor, input, projection, signature, expectedPlan) {
      C.sha(expectedPlan); const p = await plan(tx, actor, input, projection, signature);
      if (p.planHash !== expectedPlan) C.fail('IMPORT_PREVIEW_CHANGED', 409);
      const row = { id: crypto.randomBytes(32).toString('hex'), scopeId, datasetId: input.sourceId, ownerId: actor.ownerId, createdAt: C.utc(clock()) };
      await tx.execute(S.insertPublication, { ...row, payload: protection.seal(p.data, publicationContext(row)) });
      let batch=[];
      for (const binding of p.bindings) {
        const b = { publicationId: row.id, kind: binding.kind, sourceKey: Buffer.from(binding.sourceKey, 'hex'), targetId: binding.targetId, historical: binding.historical };
        const value={...b,payload:protection.seal(binding,bindingContext(b))};
        if(!batched)await tx.execute(S.insertBinding,value);
        else{
          batch.push({...value,sourceKey:value.sourceKey.toString('hex')});
          if(batch.length===200||binding===p.bindings.at(-1)){
            if((await tx.execute(BATCHES.bindings,{rows:batch})).rowsAffected!==batch.length)C.fail('IMPORT_HISTORY_INTEGRITY');
            batch=[];
          }
        }
      }
      const data = { active: row.id, previous: p.current.data.active, events: [...p.current.data.events, { action: 'activate', from: p.current.data.active, to: row.id, actor: actor.ownerId, at: row.createdAt }] };
      const revision = await writeState(tx, p.current, data);
      return { revision, active: row.id, previous: data.previous, label: p.data.label };
    },
    async rollback(tx, actor, expectedRevision, expectedPlan, signature, execute = false) {
      C.integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER); const current = await state(tx);
      if (current.row.revision !== expectedRevision) C.fail('IMPORT_REVISION_CONFLICT', 409);
      if (!current.data.active || !current.data.previous) C.fail('IMPORT_UNDO_UNAVAILABLE', 409);
      const active = await load(tx, current.data.active), previous = await load(tx, current.data.previous);
      if (active.data.createdBy !== actor.ownerId) C.fail('IMPORT_FORBIDDEN', 403);
      const planHash = protection.digest(['cash-rollback-plan-v1', actor, signature, current]);
      if (!execute) return { planHash, revision: current.row.revision, label: previous.data.label };
      if (expectedPlan !== planHash) C.fail('IMPORT_PREVIEW_CHANGED', 409);
      const data = { active: current.data.previous, previous: current.data.active,
        events: [...current.data.events, { action: 'rollback', from: current.data.active, to: current.data.previous, actor: actor.ownerId, at: C.utc(clock()) }] };
      return { revision: await writeState(tx, current, data), active: data.active, previous: data.previous, label: previous.data.label };
    },
    async reference(tx, publicationId, kind, key) {
      if (key === null || key === undefined || key === '' || key === '0') return { status: 'unassigned', targetId: null };
      const row = await tx.queryOne(S.binding, { publicationId, kind, sourceKey: referenceKey(kind, key) });
      if (!row) return { status: 'unassigned', targetId: null };
      const data = protection.open(row.payload, bindingContext(row));
      same([data.kind, data.sourceId, data.sourceKey, data.targetId, data.historical], [kind, String(key), Buffer.from(row.sourceKey).toString('hex'), row.targetId, row.historical]);
      return { status: row.historical ? 'historical_mapping' : 'linked', targetId: row.targetId };
    },
  });
}
module.exports = { createCashPublications, CASH_REFERENCE_FIELDS: FIELDS };
