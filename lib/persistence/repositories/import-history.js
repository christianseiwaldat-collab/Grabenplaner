"use strict";
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const H = require('../../tradefoto-history-profiles');
const { assertPersistenceAccess } = require('../contract');
const { IMPORT_HISTORY_STATEMENTS: S } = require('../statements/import-history');
const { IMPORT_MASTER_STATEMENTS: MS } = require('../statements/import-master-data');
const { DATA_IMPORT_STATEMENTS: DS } = require('../statements/data-import');
const { createImportMasterReferenceReader } = require('./import-master-data');
const { reconcileTradeFotoReceipt } = require('../../tradefoto-sales-rules');
const { historyBusinessDate } = require('../../sales-history-query');
const versionContext = (record, version) => ['history-version', record.scopeId, record.sourceInstance, record.source, record.sourceTable,
  record.id, record.identityHash, record.profileHash, version.revision, version.fileSha256, version.snapshotAt, version.importedBy,
  version.importedAt, version.runId, version.masterSourceInstance, version.businessDate, version.parentId, version.parentRevision];
const segmentContext = (record, version, dataClass) => [...versionContext(record, version), 'segment', dataClass];
const consumerId = (record, version) => 'history.' + record.id + '.' + version.revision;
async function expectOne(tx, statement, parameters) {
  if ((await tx.execute(statement, parameters)).rowsAffected !== 1) C.fail('IMPORT_CONCURRENT_CHANGE', 409);
}
function safeFailure(error) {
  if (error instanceof C.DataImportError) throw error;
  if (['PERSISTENCE_RETRYABLE_TRANSACTION', 'PERSISTENCE_UNIQUE_VIOLATION'].includes(error?.code)) C.fail('IMPORT_CONCURRENT_CHANGE', 409);
  C.fail('IMPORT_OPERATION_FAILED', 500);
}
function checkHeader(record) {
  const profile = H.profileFor(record.source, record.sourceTable);
  if (record.profileHash !== profile.fingerprint) C.fail('IMPORT_HISTORY_PROFILE_UNAVAILABLE');
  return profile;
}
function referenceIndex(protection, scopeId, reference) {
  return reference.targetId && ['linked', 'historical_mapping'].includes(reference.status)
    ? protection.digest(['history-reference', scopeId, reference.targetKind, reference.targetId]) : null;
}
async function loadVersion(tx, protection, record, revision = record.revision, prefetched = null) {
  const profile = checkHeader(record), version = prefetched?.versions.get(record.id + ':' + revision) || await tx.queryOne(S.version, { recordId: record.id, revision });
  if (!version) C.fail('IMPORT_HISTORY_VERSION_MISSING', 409);
  const meta = protection.open(version.payload, versionContext(record, version)), data = {};
  C.exact(meta, ['references', 'dependencyToken', 'dataHash', 'restoredFromRevision']);
  C.sha(meta.dependencyToken); C.sha(meta.dataHash);
  if (!Array.isArray(meta.references) || meta.references.length > 30) C.fail('IMPORT_HISTORY_INTEGRITY');
  const segments = prefetched?.segments.get(record.id + ':' + revision) || await tx.queryAll(S.segments, { recordId: record.id, revision });
  for (const segment of segments) {
    const values = protection.open(segment.payload, segmentContext(record, version, segment.dataClass));
    C.exact(values, profile.fields.map(f => f.target));
    for (const [key, value] of Object.entries(values)) { if (Object.hasOwn(data, key)) C.fail('IMPORT_HISTORY_INTEGRITY'); data[key] = value; }
  }
  const normalized = C.normalizeDataImportRow(profile, H.historySource(record.source, record.sourceTable, data));
  if (!C.equal(normalized.data, data) || protection.digest(data) !== meta.dataHash
    || H.historyIdentity(protection, record, record.source, record.sourceTable, normalized.key) !== record.identityHash) C.fail('IMPORT_HISTORY_INTEGRITY');
  if (!C.equal(segments.map(s => s.dataClass).sort(), H.historySegments(record.source, record.sourceTable, data).map(s => s.dataClass).sort())) C.fail('IMPORT_HISTORY_INTEGRITY');
  const indices = prefetched?.references.get(record.id + ':' + revision) || await tx.queryAll(S.references, { recordId: record.id, revision });
  const expected = meta.references.map(ref => ({ recordId: record.id, revision, role: ref.role, dataClass: ref.dataClass,
    masterRecordId: ref.recordId, lookupHash: referenceIndex(protection, record.scopeId, ref) })).sort((a, b) => a.role.localeCompare(b.role));
  if (!C.equal([...indices].sort((a, b) => a.role.localeCompare(b.role)), expected)) C.fail('IMPORT_HISTORY_INTEGRITY');
  return { target: { id: record.id, revision, data }, version, meta };
}
function createImportHistoryWriters({ protection, authorize, resolveMasterSourceInstance }) {
  // Pairing of cash source and Trade masters is explicit trusted composition,
  // not guessed from a filename or coincident customer/seller numbers.
  if (typeof authorize !== 'function' || typeof resolveMasterSourceInstance !== 'function') C.fail('IMPORT_COMPOSITION_INVALID');
  const readReference = createImportMasterReferenceReader({ protection, authorize });
  return Object.freeze(Object.fromEntries(H.TRADEFOTO_HISTORY_PROFILES.map(profile => {
    const source = H.TRADEFOTO_HISTORY_METADATA.tables.find(t => t.sourceSystem === profile.sourceSystem && t.name === profile.sourceTable).source;
    function context(value) {
      if (!value || value.sourceSystem !== profile.sourceSystem || value.sourceTable !== profile.sourceTable || value.profileHash !== profile.fingerprint) C.fail('IMPORT_HISTORY_CONTEXT_INVALID');
      C.id(value.scopeId); C.id(value.ownerId); C.id(value.sourceInstance); C.sha(value.fileSha256); C.utc(value.snapshotAt); C.utc(value.at); C.sha(value.runId); return value;
    }
    const identity = (value, key) => H.historyIdentity(protection, value, source, profile.sourceTable, key);
    async function header(tx, id, value) {
      context(value); C.id(id); const record = await tx.queryOne(S.get, { id, scopeId: value.scopeId });
      if (record && (record.sourceInstance !== value.sourceInstance || record.source !== source || record.sourceTable !== profile.sourceTable)) C.fail('IMPORT_HISTORY_CONTEXT_INVALID');
      return record;
    }
    async function read(tx, id, value) { const record = await header(tx, id, value); return record ? (await loadVersion(tx, protection, record)).target : null; }
    async function dependencies(tx, data, value) {
      context(value);
      const sourceRow = H.historySource(source, profile.sourceTable, data);
      if (!H.tableFor(source, profile.sourceTable).keys && (sourceRow._source_snapshot_sha256 !== value.fileSha256 || sourceRow._source_row < 1)) C.fail('IMPORT_HISTORY_SNAPSHOT_MISMATCH');
      const masterSourceInstance = C.id(await resolveMasterSourceInstance(Object.freeze({ scopeId: value.scopeId, sourceInstance: value.sourceInstance, source })));
      const parentRequest = H.historyParentRequest(source, profile.sourceTable, data), references = [];
      let parent = null, issue = '';
      if (parentRequest) {
        if (parentRequest.key.some(key => key === null || key === '')) issue = 'HISTORY_PARENT_KEY_MISSING';
        else {
          const record = await tx.queryOne(S.find, { scopeId: value.scopeId, identityHash: H.historyIdentity(protection, value, source, parentRequest.name, parentRequest.key) });
          if (!record) issue = 'HISTORY_PARENT_REQUIRED';
          else {
            if (record.sourceInstance !== value.sourceInstance || record.source !== source || record.sourceTable !== parentRequest.name) C.fail('IMPORT_HISTORY_INTEGRITY');
            const loaded = await loadVersion(tx, protection, record);
            if (loaded.version.masterSourceInstance !== masterSourceInstance) C.fail('IMPORT_HISTORY_SOURCE_PAIR_CHANGED', 409);
            parent = { id: record.id, revision: record.revision };
            for (const ref of loaded.meta.references.filter(ref => ['customer', 'header_seller'].includes(ref.role))) {
              if (await authorize(Object.freeze({ scopeId: value.scopeId, ownerId: value.ownerId, action: 'history.reference', dataClasses: [ref.dataClass],
                targetKind: ref.targetKind, targetId: ref.targetId })) !== true) C.fail('IMPORT_FORBIDDEN', 403);
              references.push(ref);
            }
          }
        }
      }
      for (const request of H.historyReferenceRequests(source, profile.sourceTable, data)) {
        const reference = await readReference(tx, { ...value, sourceInstance: masterSourceInstance }, request.table, request.key);
        references.push({ ...reference, role: request.role, dataClass: request.dataClass });
      }
      references.sort((a, b) => a.role.localeCompare(b.role));
      if (new Set(references.map(ref => ref.role)).size !== references.length) C.fail('IMPORT_HISTORY_REFERENCE_DUPLICATE');
      await checkScope(value, references);
      return { masterSourceInstance, parent, references, issue, token: protection.digest(['history-dependencies', masterSourceInstance, parent, references, issue]) };
    }
    async function checkScope(value, references) {
      if (await authorize(Object.freeze({ scopeId: value.scopeId, ownerId: value.ownerId, action: 'history.scope', dataClasses: [],
        sourceInstance: value.sourceInstance, source, sourceTable: profile.sourceTable,
        locations: references.filter(ref => ref.targetKind === 'location').map(ref => ({ role: ref.role, status: ref.status, key: ref.key, targetId: ref.targetId })) })) !== true) C.fail('IMPORT_FORBIDDEN', 403);
    }
    async function review(tx, row, value) {
      const checked = await dependencies(tx, row.data, value);
      const record = await tx.queryOne(S.find, { identityHash: identity(value, row.key), scopeId: value.scopeId });
      const current = record ? await loadVersion(tx, protection, record) : null;
      return { issue: checked.issue, token: checked.token, rewrite: !!current && current.meta.dependencyToken !== checked.token };
    }
    async function append(tx, record, data, value, saved = null) {
      const checked = saved || await dependencies(tx, data, value);
      if (checked.issue) C.fail('IMPORT_' + checked.issue, 409);
      const version = { recordId: record.id, revision: record.revision, fileSha256: value.fileSha256, snapshotAt: value.snapshotAt,
        importedBy: value.ownerId, importedAt: value.at, runId: value.runId, masterSourceInstance: checked.masterSourceInstance,
        businessDate: historyBusinessDate(source, profile.sourceTable, data, H), parentId: checked.parent?.id || null, parentRevision: checked.parent?.revision || null };
      const meta = { references: checked.references, dependencyToken: checked.token, dataHash: protection.digest(data), restoredFromRevision: saved ? value.restoreRevision : null };
      await expectOne(tx, S.insertVersion, { ...version, payload: protection.seal(meta, versionContext(record, version)) });
      for (const segment of H.historySegments(source, profile.sourceTable, data)) await expectOne(tx, S.insertSegment, {
        recordId: record.id, revision: record.revision, dataClass: segment.dataClass, payload: protection.seal(segment.data, segmentContext(record, version, segment.dataClass)),
      });
      for (const ref of checked.references) await expectOne(tx, S.insertReference, { recordId: record.id, revision: record.revision,
        role: ref.role, dataClass: ref.dataClass, masterRecordId: ref.recordId, lookupHash: referenceIndex(protection, record.scopeId, ref) });
      for (const recordId of new Set(checked.references.map(ref => ref.recordId).filter(Boolean))) await expectOne(tx, MS.insertHold, { recordId, consumerId: consumerId(record, version) });
      await expectOne(tx, S.advanceEpoch, { scopeId: record.scopeId, token: crypto.randomUUID() });
      return (await loadVersion(tx, protection, record)).target;
    }
    async function canRemove(tx, id, value) {
      const record = await header(tx, id, value); if (!record) return false;
      const current = await loadVersion(tx, protection, record); await checkScope(value, current.meta.references);
      for (const ref of current.meta.references) if (await authorize(Object.freeze({ scopeId: value.scopeId, ownerId: value.ownerId, action: 'history.reference',
        dataClasses: [ref.dataClass], targetKind: ref.targetKind, targetId: ref.targetId })) !== true) C.fail('IMPORT_FORBIDDEN', 403);
      return (await tx.queryOne(S.dependencies, { id })).count === 0;
    }
    async function update(tx, { id, expectedRevision, data }, value, restoring = false) {
      const record = await header(tx, id, value); if (!record || record.revision !== expectedRevision) C.fail('IMPORT_CONCURRENT_CHANGE', 409);
      if (identity(value, H.historyKey(source, profile.sourceTable, data)) !== record.identityHash) C.fail('IMPORT_HISTORY_IDENTITY_IMMUTABLE');
      let saved = null;
      if (restoring) {
        C.integer(value.restoreRevision, 1, expectedRevision);
        if (!await canRemove(tx, id, value)) C.fail('IMPORT_UNDO_DEPENDENCIES', 409);
        const original = await loadVersion(tx, protection, record, value.restoreRevision);
        if (!C.equal(original.target.data, data)) C.fail('IMPORT_HISTORY_INTEGRITY');
        saved = { references: original.meta.references, token: original.meta.dependencyToken, masterSourceInstance: original.version.masterSourceInstance,
          parent: original.version.parentId ? { id: original.version.parentId, revision: original.version.parentRevision } : null };
        await checkScope(value, saved.references);
        for (const ref of saved.references) if (await authorize(Object.freeze({ scopeId: value.scopeId, ownerId: value.ownerId, action: 'history.reference',
          dataClasses: [ref.dataClass], targetKind: ref.targetKind, targetId: ref.targetId })) !== true) C.fail('IMPORT_FORBIDDEN', 403);
      }
      await expectOne(tx, S.advance, { id, scopeId: record.scopeId, expectedRevision });
      return append(tx, { ...record, revision: record.revision + 1 }, data, value, saved);
    }
    return [profile.entity, Object.freeze({
      read, review,
      async findExisting(tx, row, value) { context(value); const record = await tx.queryOne(S.find, { scopeId: value.scopeId, identityHash: identity(value, row.key) }); return record ? [(await loadVersion(tx, protection, record)).target] : []; },
      async create(tx, { id, data }, value) {
        context(value); const record = { id, scopeId: value.scopeId, sourceInstance: value.sourceInstance, source, sourceTable: profile.sourceTable,
          profileHash: profile.fingerprint, identityHash: identity(value, H.historyKey(source, profile.sourceTable, data)), revision: 1 };
        await expectOne(tx, S.insert, record); return append(tx, record, data, value);
      },
      update, restore: (tx, input, value) => update(tx, input, value, true), canRemove,
      async canRestore(tx, current, before, value) {
        if (!await canRemove(tx, current.id, value)) return false;
        const record = await header(tx, current.id, value), original = await loadVersion(tx, protection, record, before.revision);
        return C.equal(before.data, original.target.data);
      },
      async remove(tx, { id, expectedRevision }, value) {
        if (!await canRemove(tx, id, value)) C.fail('IMPORT_UNDO_DEPENDENCIES', 409);
        const record = await header(tx, id, value);
        for (const version of await tx.queryAll(S.versions, { recordId: id })) {
          const loaded = await loadVersion(tx, protection, record, version.revision);
          for (const recordId of new Set(loaded.meta.references.map(ref => ref.recordId).filter(Boolean))) await expectOne(tx, MS.removeHold, { recordId, consumerId: consumerId(record, version) });
        }
        await tx.execute(S.clearReferences, { recordId: id }); await tx.execute(S.clearSegments, { recordId: id });
        await tx.execute(S.clearVersions, { recordId: id }); await expectOne(tx, S.remove, { id, scopeId: value.scopeId, expectedRevision });
        await expectOne(tx, S.advanceEpoch, { scopeId: value.scopeId, token: crypto.randomUUID() }); return true;
      },
    })];
  })));
}
// Protected, bounded backend reads for Block 5. No route/role is registered here.
function createImportHistoryService({ access, protection, getActor, authorize, executor = null, prefetched = null }) {
  assertPersistenceAccess(access);
  if (typeof access.transaction !== 'function' || typeof getActor !== 'function' || typeof authorize !== 'function') C.fail('IMPORT_COMPOSITION_INVALID');
  if (executor) assertPersistenceAccess(executor);
  function actor() { const value = getActor(); C.exact(value, ['scopeId', 'ownerId']); return { scopeId: C.id(value.scopeId), ownerId: C.id(value.ownerId) }; }
  const atomic = work => (executor ? Promise.resolve().then(() => work(executor)) : access.transaction(work, { isolation: 'serializable' })).catch(safeFailure);
  async function allowed(who, action, dataClasses, context = {}) { if (await authorize(Object.freeze({ ...who, action, dataClasses, ...context })) !== true) C.fail('IMPORT_FORBIDDEN', 403); }
  async function load(tx, who, id, revision) {
    C.id(id); if (revision !== undefined) C.integer(revision, 1, Number.MAX_SAFE_INTEGER);
    const record = prefetched?.records.get(id) || await tx.queryOne(S.get, { id, scopeId: who.scopeId }); if (!record || record.scopeId !== who.scopeId) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    await allowed(who, 'history.read', [], { sourceInstance: record.sourceInstance, source: record.source, sourceTable: record.sourceTable, recordId: id });
    const loaded = await loadVersion(tx, protection, record, revision, prefetched);
    // Require document/branch scope as well as field-class rights; an unassigned
    // branch is explicit and must not be treated as unrestricted by the adapter.
    await allowed(who, 'history.scope', [], { sourceInstance: record.sourceInstance, source: record.source, sourceTable: record.sourceTable, recordId: id,
      locations: loaded.meta.references.filter(ref => ref.targetKind === 'location').map(ref => ({ role: ref.role, status: ref.status, key: ref.key, targetId: ref.targetId })) });
    return { record, ...loaded };
  }
  async function view(who, loaded) {
    const { record, target, version, meta } = loaded, fields = {}, omittedClasses = new Set(), references = [], grants = new Map();
    const classAllowed = async dataClass => {
      if (!grants.has(dataClass)) grants.set(dataClass, await authorize(Object.freeze({ ...who, action: 'history.read', dataClasses: [dataClass], recordId: record.id,
        sourceInstance: record.sourceInstance, source: record.source, sourceTable: record.sourceTable })) === true);
      return grants.get(dataClass);
    };
    const row = H.historySource(record.source, record.sourceTable, target.data);
    for (const column of H.tableFor(record.source, record.sourceTable).columns) {
      if (await classAllowed(column.dataClass)) fields[column.name] = row[column.name]; else omittedClasses.add(column.dataClass);
    }
    for (const ref of meta.references) {
      if (await classAllowed(ref.dataClass) && await authorize(Object.freeze({ ...who, action: 'history.reference', dataClasses: [ref.dataClass], targetKind: ref.targetKind, targetId: ref.targetId })) === true) references.push(ref);
      else omittedClasses.add(ref.dataClass);
    }
    return { id: record.id, revision: target.revision, source: record.source, table: record.sourceTable, group: H.tableFor(record.source, record.sourceTable).group,
      fields, references, omittedClasses: [...omittedClasses].sort(), partial: omittedClasses.size > 0,
      provenance: { sourceInstance: record.sourceInstance, fileSha256: version.fileSha256, snapshotAt: version.snapshotAt,
        importedAt: version.importedAt, runId: version.runId, businessDate: version.businessDate, parentId: version.parentId, parentRevision: version.parentRevision,
        restoredFromRevision: meta.restoredFromRevision }, metricState: 'rules_and_receipt_reconciliation_required' };
  }
  return Object.freeze({
    async detail(id, { revision } = {}) { const who = actor(); return atomic(async tx => view(who, await load(tx, who, id, revision))); },
    async list({ source, table, sourceInstance, after = '', limit = 50, snapshot = null }) {
      H.tableFor(source, table); C.id(sourceInstance); if (after) C.id(after); C.integer(limit, 1, 100); if (snapshot) C.sha(snapshot);
      // Snapshot tables have no cross-file event identity. Never merge snapshots automatically.
      if (!H.tableFor(source, table).keys && !snapshot) C.fail('IMPORT_HISTORY_SNAPSHOT_REQUIRED');
      const who = actor(); await allowed(who, 'history.list', [], { source, sourceTable: table, sourceInstance });
      return atomic(async tx => {
        const records = await tx.queryAll(S.list, { scopeId: who.scopeId, sourceInstance, source, sourceTable: table, after, limit: limit + 1, snapshot });
        const selected = records.slice(0, limit), items = [];
        // Fail closed if a requested page crosses unauthorized document scope.
        for (const record of selected) items.push(await view(who, await load(tx, who, record.id)));
        return { items, next: records.length > limit ? selected.at(-1).id : null, scope: 'page_only_no_totals', snapshot };
      });
    },
    async receipt(id, policy = null, coverage = null) {
      const who = actor(); await allowed(who, 'history.reconcile', ['customer_restricted']);
      return atomic(async tx => {
        const head = await load(tx, who, id);
        if (head.record.source !== 'cash' || head.record.sourceTable !== 'Umsatz_KASSE') C.fail('IMPORT_HISTORY_NOT_A_RECEIPT');
        const children = await tx.queryAll(S.children, { parentId: id, scopeId: who.scopeId, after: '', limit: 1001 });
        // A large/incomplete page can never be reported as a reconciled receipt.
        if (children.length > 1000) return { id, revision: head.record.revision, canAggregate: false, issues: ['RECEIPT_LINE_LIMIT'], totals: null };
        const lines = [], versions = [head];
        for (const child of children) {
          const loaded = await load(tx, who, child.id);
          if (loaded.record.sourceTable !== 'Umsatz_Kasse_Details') C.fail('IMPORT_HISTORY_INTEGRITY');
          versions.push(loaded);
          lines.push({ source: H.historySource('cash', child.sourceTable, loaded.target.data), parentRevision: loaded.version.parentRevision });
        }
        const checkedRuns = new Map();
        for (const loaded of versions) {
          const { version, meta } = loaded;
          let run = checkedRuns.get(version.runId);
          if (!run) {
            run = await tx.queryOne(DS.getRun, { id: version.runId, scopeId: who.scopeId, ownerId: version.importedBy });
            if (!run) C.fail('IMPORT_HISTORY_RUN_MISSING');
            const expectedId = protection.digest(['run', C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, run.profileHash, run.manifest, run.attemptId]);
            if (expectedId !== run.id || run.manifest.sourceInstance !== loaded.record.sourceInstance || run.profileHash !== loaded.record.profileHash) C.fail('IMPORT_HISTORY_INTEGRITY');
            checkedRuns.set(version.runId, run);
          }
          if (!['applied', 'purged'].includes(run.status) && !(run.status === 'reverted' && meta.restoredFromRevision !== null))
            return { id, revision: head.record.revision, canAggregate: false, issues: ['SOURCE_IMPORT_NOT_COMPLETE'], totals: null };
        }
        return { id, revision: head.record.revision, ...reconcileTradeFotoReceipt({ head: H.historySource('cash', head.record.sourceTable, head.target.data),
          lines, headRevision: head.record.revision, snapshotDate: head.version.snapshotAt.slice(0, 10), policy, coverage,
          scopeId: who.scopeId, sourceInstance: head.record.sourceInstance }) };
      });
    },
  });
}
module.exports = { createImportHistoryWriters, createImportHistoryService };
