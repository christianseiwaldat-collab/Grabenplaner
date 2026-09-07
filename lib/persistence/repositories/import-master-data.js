"use strict";
const crypto = require("node:crypto");
const C = require("../../data-import-contract");
const M = require("../../tradefoto-master-profiles");
const { normalizeCrmCustomerInput } = require("../../crm-customers");
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require("../../tradefoto-article-source-profile");
const { assertPersistenceAccess } = require("../contract");
const { IMPORT_MASTER_STATEMENTS: S, IMPORT_MASTER_COLUMNS } = require("../statements/import-master-data");
const { CRM_CUSTOMER_STATEMENTS: CRM } = require("../statements/crm-customers");
const { buildTradeFotoMasterView } = require("../../tradefoto-master-views");
const segmentContext = (record, segment) => ["master-segment", record.scopeId, record.sourceInstance, record.sourceTable,
  record.identityHash, record.id, record.profileHash, record.revision, segment.kind, segment.dataClass];
const bindingContext = binding => ["master-binding", binding.scopeId, binding.recordId, binding.targetKind, binding.targetId, binding.revision, binding.sourceRevision, binding.historical, binding.lastEventId];
const eventContext = event => ["master-event", event.scopeId, event.id, event.recordId, event.actorId, event.action, event.at];
async function expectOne(tx, statement, parameters) {
  if ((await tx.execute(statement, parameters)).rowsAffected !== 1) C.fail("IMPORT_CONCURRENT_CHANGE", 409);
}
function safeFailure(error) {
  if (error instanceof C.DataImportError) throw error;
  if (error?.code === "PERSISTENCE_RETRYABLE_TRANSACTION" || error?.code === "PERSISTENCE_UNIQUE_VIOLATION") C.fail("IMPORT_CONCURRENT_CHANGE", 409);
  C.fail("IMPORT_OPERATION_FAILED", 500);
}
function checkHeader(record) {
  const profile = M.profileFor(record.sourceTable);
  if (record.profileHash !== profile.fingerprint) C.fail("IMPORT_MASTER_PROFILE_UNAVAILABLE");
  return profile;
}
async function loadMaster(tx, protection, record) {
  const profile = checkHeader(record), data = {};
  const segments = await tx.queryAll(S.segments, { recordId: record.id });
  for (const segment of segments) {
    const values = protection.open(segment.payload, segmentContext(record, segment));
    C.exact(values, profile.fields.map(field => field.target));
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(data, key)) C.fail("IMPORT_MASTER_INTEGRITY");
      data[key] = value;
    }
  }
  const normalized = C.normalizeDataImportRow(profile, M.masterSource(record.sourceTable, data));
  if (!C.equal(normalized.data, data) || M.masterIdentity(protection, record, record.sourceTable, normalized.key) !== record.identityHash) C.fail("IMPORT_MASTER_INTEGRITY");
  const expected = M.masterSegments(record.sourceTable, data).map(({ kind, dataClass }) => [kind, dataClass]).sort();
  if (!C.equal(expected, segments.map(({ kind, dataClass }) => [kind, dataClass]).sort())) C.fail("IMPORT_MASTER_INTEGRITY");
  return { id: record.id, revision: record.revision, data };
}
async function saveParts(tx, protection, record, data) {
  await tx.execute(S.clearSegments, { recordId: record.id });
  await tx.execute(S.clearRelations, { recordId: record.id });
  for (const segment of M.masterSegments(record.sourceTable, data)) await expectOne(tx, S.insertSegment, {
    recordId: record.id, kind: segment.kind, dataClass: segment.dataClass, payload: protection.seal(segment.data, segmentContext(record, segment)),
  });
  for (const relation of M.masterReferences(protection, record, record.sourceTable, data)) await expectOne(tx, S.insertRelation, { recordId: record.id, ...relation });
}
function createImportMasterWriters({ protection }) {
  return Object.freeze(Object.fromEntries(M.TRADEFOTO_MASTER_PROFILES.map(profile => {
    function context(value) {
      if (!value || value.profileHash !== profile.fingerprint || value.sourceTable !== profile.sourceTable || value.sourceSystem !== profile.sourceSystem) C.fail("IMPORT_MASTER_CONTEXT_INVALID");
      C.id(value.scopeId); C.id(value.ownerId); C.id(value.sourceInstance); C.utc(value.at); return value;
    }
    async function header(tx, id, value) {
      context(value); C.id(id);
      const record = await tx.queryOne(S.get, { id, scopeId: value.scopeId });
      if (record && (record.sourceInstance !== value.sourceInstance || record.sourceTable !== profile.sourceTable)) C.fail("IMPORT_MASTER_CONTEXT_INVALID");
      return record;
    }
    async function read(tx, id, value) {
      const record = await header(tx, id, value); return record ? loadMaster(tx, protection, record) : null;
    }
    async function canRemove(tx, id, value) {
      const record = await header(tx, id, value); if (!record) return false;
      return (await tx.queryOne(S.dependencies, { id, identityHash: record.identityHash })).count === 0;
    }
    async function update(tx, { id, expectedRevision, data }, value) {
      const record = await header(tx, id, value); if (!record || record.revision !== expectedRevision) C.fail("IMPORT_CONCURRENT_CHANGE", 409);
      const identityHash = M.masterIdentity(protection, record, record.sourceTable, M.masterKey(record.sourceTable, data));
      if (identityHash !== record.identityHash) C.fail("IMPORT_MASTER_IDENTITY_IMMUTABLE");
      await expectOne(tx, S.update, { id, scopeId: record.scopeId, expectedRevision, profileHash: profile.fingerprint, updatedBy: value.ownerId, updatedAt: value.at });
      await saveParts(tx, protection, { ...record, revision: expectedRevision + 1, profileHash: profile.fingerprint }, data);
      return read(tx, id, value);
    }
    return [profile.entity, Object.freeze({
      read,
      async findExisting(tx, row, value) {
        context(value);
        const record = await tx.queryOne(S.find, { scopeId: value.scopeId, identityHash: M.masterIdentity(protection, value, profile.sourceTable, row.key) });
        return record ? [await loadMaster(tx, protection, record)] : [];
      },
      async create(tx, { id, data }, value) {
        context(value);
        const record = { id, scopeId: value.scopeId, sourceInstance: value.sourceInstance, sourceTable: profile.sourceTable,
          profileHash: profile.fingerprint, identityHash: M.masterIdentity(protection, value, profile.sourceTable, M.masterKey(profile.sourceTable, data)),
          revision: 1, updatedBy: value.ownerId, updatedAt: value.at };
        await expectOne(tx, S.insert, record); await saveParts(tx, protection, record, data); return read(tx, id, value);
      },
      update, restore: update, canRemove,
      canRestore: (tx, current, _before, value) => canRemove(tx, current.id, value),
      async remove(tx, { id, expectedRevision }, value) {
        if (!await canRemove(tx, id, value)) C.fail("IMPORT_UNDO_DEPENDENCIES", 409);
        await tx.execute(S.clearRelations, { recordId: id }); await tx.execute(S.clearSegments, { recordId: id });
        await expectOne(tx, S.remove, { id, scopeId: value.scopeId, expectedRevision }); return true;
      },
    })];
  })));
}

const CUSTOMER_MAP = Object.freeze({ KUND_NR: "accountNumber", NACHNAME: "lastName", VORNAME: "firstName", "STRaße": "street",
  AdressZusatz: "addressSupplement", PLZ: "postalCode", ORT: "city", Land: "country", TELEFON: "phone", EMail: "email", UStID: "vatId", Geburtstag: "birthDate" });
const CUSTOMER_FIELDS = Object.keys(IMPORT_MASTER_COLUMNS.CRM_DATA);
const CUSTOMER_MANAGED = [...Object.values(CUSTOMER_MAP), "customerType", "companyName"];
const customerData = customer => Object.fromEntries(CUSTOMER_FIELDS.map(key => [key, customer[key]]));
function customerProjection(source, decision) {
  if (source.KUND_NR === "0") C.fail("IMPORT_CUSTOMER_UNASSIGNED_ZERO");
  C.exact(decision, ["customerType", "companyName", "corrections"]);
  if (decision.customerType && !["private", "business", "unknown"].includes(decision.customerType)) C.fail("IMPORT_CUSTOMER_TYPE_REVIEW_REQUIRED");
  const corrections = decision.corrections || {}; C.exact(corrections, Object.values(CUSTOMER_MAP).filter(key => key !== "accountNumber"));
  const input = Object.fromEntries(CUSTOMER_FIELDS.map(key => [key, ""]));
  for (const [field, target] of Object.entries(CUSTOMER_MAP)) input[target] = source[field] ?? (target === "birthDate" ? null : "");
  input.birthDate = input.birthDate ? input.birthDate.slice(0, 10) : null;
  if (!input.phone && source.Handy) input.phone = source.Handy;
  Object.assign(input, corrections, { customerType: decision.customerType || 'unknown', companyName: decision.companyName || "", customFields: [] });
  let normalized;
  try { normalized = normalizeCrmCustomerInput(input); }
  catch (error) { C.fail("IMPORT_" + (/^CRM_[A-Z_]+$/u.test(error.code) ? error.code : "CUSTOMER_VALIDATION_FAILED")); }
  return Object.fromEntries(CUSTOMER_MANAGED.map(key => [key, normalized[key]]));
}
function createImportMasterService({ access, protection, getActor, authorize, sourceInstance = null, clock = () => new Date().toISOString() }) {
  assertPersistenceAccess(access);
  if (typeof access.transaction !== "function" || typeof authorize !== "function" || typeof getActor !== "function") C.fail("IMPORT_COMPOSITION_INVALID");
  if (sourceInstance !== null) C.id(sourceInstance);
  function actor() { const value = getActor(); C.exact(value, ["scopeId", "ownerId"]); return { scopeId: C.id(value.scopeId), ownerId: C.id(value.ownerId) }; }
  const now = () => C.utc(clock());
  async function allowed(who, action, dataClasses, target = {}) {
    if (await authorize(Object.freeze({ ...who, action, dataClasses, ...target })) !== true) C.fail("IMPORT_FORBIDDEN", 403);
  }
  const atomic = work => access.transaction(work, { isolation: "serializable" }).catch(safeFailure);
  async function sourceRecord(tx, who, id) {
    C.id(id); const record = await tx.queryOne(S.get, { id, scopeId: who.scopeId });
    if (!record) C.fail("IMPORT_MASTER_NOT_FOUND", 404);
    if (sourceInstance && record.sourceInstance !== sourceInstance) C.fail("IMPORT_MASTER_NOT_FOUND", 404);
    checkHeader(record); return record;
  }
  async function sourceData(tx, record) { return M.masterSource(record.sourceTable, (await loadMaster(tx, protection, record)).data); }
  function bindingPayload(binding) { return binding ? protection.open(binding.payload, bindingContext(binding)) : null; }
  async function bindingFor(tx, record) {
    const binding = await tx.queryOne(S.getBinding, { recordId: record.id });
    if (binding && (binding.scopeId !== record.scopeId || binding.sourceInstance !== record.sourceInstance || binding.sourceTable !== record.sourceTable)) C.fail("IMPORT_MASTER_INTEGRITY");
    if (binding) bindingPayload(binding); return binding;
  }
  async function event(tx, who, record, action, payload, id = crypto.randomUUID()) {
    const row = { id, scopeId: who.scopeId, recordId: record.id, actorId: who.ownerId, action, at: now(), revertedAt: null };
    await expectOne(tx, S.insertEvent, { ...row, payload: protection.seal(payload, eventContext(row)) });
    // Central audit is value-free. Private details stay in the authenticated payload.
    await expectOne(tx, CRM.insertAudit, { actor: who.ownerId, action, entityType: "import_master", entityId: record.id,
      detail: JSON.stringify({ eventId: id, sourceRevision: record.revision }), timestamp: row.at });
    return id;
  }
  function newBinding(record, { kind, targetId, historical = false, eventId, data }) {
    const binding = { recordId: record.id, scopeId: record.scopeId, sourceInstance: record.sourceInstance, sourceTable: record.sourceTable,
      targetKind: kind, targetId, revision: 1, sourceRevision: record.revision, historical, lastEventId: eventId };
    return { ...binding, payload: protection.seal(data, bindingContext(binding)) };
  }
  async function saveBinding(tx, record, before, kind, targetId, eventId, data, historical = false) {
    if (!before) {
      const binding = newBinding(record, { kind, targetId, eventId, data, historical });
      await expectOne(tx, S.insertBinding, binding); return binding;
    }
    if (before.targetKind !== kind || before.targetId !== targetId) C.fail("IMPORT_MASTER_REBIND_FORBIDDEN", 409);
    const binding = { ...before, revision: before.revision + 1, sourceRevision: record.revision, lastEventId: eventId };
    binding.payload = protection.seal(data, bindingContext(binding));
    await expectOne(tx, S.updateBinding, { recordId: record.id, expectedRevision: before.revision, sourceRevision: record.revision, payload: binding.payload, lastEventId: eventId });
    return binding;
  }
  function customerRequest(input) {
    C.exact(input, ["recordId", "expectedSourceRevision", "decision", "targetId", "expectedTargetRevision"]);
    C.id(input.recordId); C.integer(input.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER);
    if (input.targetId !== undefined && input.targetId !== null) { C.id(input.targetId); C.integer(input.expectedTargetRevision, 1, Number.MAX_SAFE_INTEGER); }
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  }
  async function planCustomer(tx, who, input) {
    input = customerRequest(input);
    await allowed(who, "master.read", ["customer_restricted"]);
    const record = await sourceRecord(tx, who, input.recordId);
    if (record.sourceTable !== "KUNDEN") C.fail("IMPORT_MASTER_KIND_INVALID");
    if (record.revision !== input.expectedSourceRevision) C.fail("IMPORT_SOURCE_CHANGED", 409);
    const beforeBinding = await bindingFor(tx, record), baseline = bindingPayload(beforeBinding);
    if (beforeBinding && beforeBinding.targetKind !== "crm_customer") C.fail("IMPORT_MASTER_KIND_INVALID");
    const decision = input.decision || baseline?.decision || {};
    const proposed = customerProjection(await sourceData(tx, record), decision);
    let before = null, action = "create";
    if (beforeBinding) {
      if (input.targetId && input.targetId !== beforeBinding.targetId) C.fail("IMPORT_MASTER_REBIND_FORBIDDEN", 409);
      before = await tx.queryOne(S.crmGet, { id: beforeBinding.targetId });
      if (!before) C.fail("IMPORT_LINKED_TARGET_MISSING", 409);
      action = "sync";
    } else if (input.targetId) {
      before = await tx.queryOne(S.crmGet, { id: input.targetId });
      if (!before || before.revision !== input.expectedTargetRevision) C.fail("IMPORT_TARGET_CHANGED", 409);
      if ((before.accountNumber || before.customerNumber) !== proposed.accountNumber) C.fail("IMPORT_CUSTOMER_NUMBER_MISMATCH", 409);
      action = "link"; // First binding never overwrites an existing CRM card.
    } else if (await tx.queryOne(S.crmFind, { number: proposed.accountNumber })) C.fail("IMPORT_CUSTOMER_MATCH_CONFIRMATION_REQUIRED", 409);
    await allowed(who, "customer.sync", ["customer_restricted"], { targetKind: "crm_customer", targetId: before?.id || null });
    const after = before ? customerData(before) : { ...Object.fromEntries(CUSTOMER_FIELDS.map(key => [key, ['accountNumber', 'customerNumber', 'birthDate'].includes(key) ? null : ""])), ...proposed };
    if (action === 'link' && !after.accountNumber) after.accountNumber = proposed.accountNumber;
    if (action === "sync") for (const [key, value] of Object.entries(proposed)) {
      // Older confirmed imports stored KUND_NR as customerNumber. The protected
      // baseline proves that identity; unrelated manual numbers are not moved.
      if (key === 'accountNumber' && !after.accountNumber && baseline.proposed.customerNumber === value) { after.accountNumber = value; continue; }
      // A missing source field does not erase an existing contact or conflict
      // with a manual correction. Explicit reviewed corrections can clear it.
      if ((value === '' || value === null || (key === 'customerType' && value === 'unknown')) && !Object.hasOwn(decision.corrections || {}, key)) continue;
      if (C.equal(value, baseline.proposed[key]) || C.equal(value, after[key])) continue;
      if (!C.equal(after[key], baseline.proposed[key])) C.fail("IMPORT_MANUAL_FIELD_CONFLICT", 409);
      after[key] = value;
    }
    const plan = { record, beforeBinding, before, decision, proposed, after, action };
    return { ...plan, planHash: protection.digest(["customer-plan", who, input, plan]) };
  }
  async function planBinding(tx, who, input) {
    C.exact(input, ["recordId", "expectedSourceRevision", "targetId", "historical", "reason"]);
    C.integer(input.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER); C.text(input.reason, 1000);
    if (typeof input.historical !== "boolean") C.fail("IMPORT_MAPPING_DECISION_REQUIRED");
    const record = await sourceRecord(tx, who, input.recordId);
    if (record.revision !== input.expectedSourceRevision) C.fail("IMPORT_SOURCE_CHANGED", 409);
    const kind = { ARTIKEL_STAMM: "sales_article", MITARBEITER: "employee", FILIALEN: "location" }[record.sourceTable];
    if (!kind) C.fail("IMPORT_MASTER_KIND_INVALID");
    const dataClasses = kind === "employee" ? ["personnel_restricted"] : ["internal_business"];
    await allowed(who, "master.read", dataClasses);
    if (await bindingFor(tx, record)) C.fail("IMPORT_MASTER_ALREADY_BOUND", 409);
    const source = await sourceData(tx, record);
    if (kind === "employee" && source["Verkäufer_ID"] === "0") C.fail("IMPORT_EMPLOYEE_UNASSIGNED_ZERO");
    let target;
    if (kind === "sales_article") {
      target = await tx.queryOne(S.articleBySource, { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceArticleKey: source.EAN });
      if (!target) C.fail("IMPORT_ARTICLE_SOURCE_LINK_REQUIRED", 409);
      if (input.targetId && target.id !== input.targetId) C.fail("IMPORT_ARTICLE_SOURCE_LINK_MISMATCH", 409);
      if (!target.active && !input.historical) C.fail("IMPORT_MAPPING_INACTIVE_TARGET", 409);
    } else {
      C.id(input.targetId); target = await tx.queryOne(kind === "employee" ? S.employee : S.location, { id: input.targetId });
      if (!target) C.fail("IMPORT_MAPPING_TARGET_MISSING", 409);
      if (!target.active && !input.historical) C.fail("IMPORT_MAPPING_INACTIVE_TARGET", 409);
    }
    await allowed(who, "master.link", dataClasses, { targetKind: kind, targetId: target.id });
    const plan = { record, kind, target, historical: input.historical, reason: input.reason };
    return { ...plan, planHash: protection.digest(["master-link-plan", who, plan]) };
  }
  const service = {
    // Small, explicit review projections; never expose prices, salary, passwords,
    // bank details or consent flags through the mapping directory.
    async mappings({ table, sourceInstance, key = '', status = 'all', after = '', limit = 40 }) {
      if (!['ARTIKEL_STAMM', 'KUNDEN', 'MITARBEITER', 'FILIALEN'].includes(table)) C.fail('IMPORT_MASTER_KIND_INVALID');
      C.id(sourceInstance); if (key !== '') C.text(key, 256); if (after) C.id(after); C.integer(limit, 1, 100);
      if (!['all', 'linked', 'unlinked'].includes(status) || (key && after)) C.fail('IMPORT_MAPPING_QUERY_INVALID');
      const who = actor(), dataClasses = table === 'KUNDEN' ? ['customer_restricted'] : table === 'MITARBEITER' ? ['personnel_restricted'] : ['internal_business'];
      await allowed(who, 'master.read', dataClasses);
      return atomic(async tx => {
        const found = key ? await tx.queryOne(S.find, { scopeId: who.scopeId, identityHash: M.masterIdentity(protection, { ...who, sourceInstance }, table, [key]) }) : null;
        const records = key ? found ? [found] : [] : await tx.queryAll(S.listMappings, { scopeId: who.scopeId, sourceInstance, sourceTable: table, status, after, limit: limit + 1 });
        const items = [];
        for (const record of records.slice(0, limit)) {
          if (record.sourceInstance !== sourceInstance || record.sourceTable !== table) C.fail('IMPORT_MASTER_INTEGRITY');
          const source = await sourceData(tx, record), binding = await bindingFor(tx, record);
          if (key && ((status === 'linked' && !binding) || (status === 'unlinked' && binding))) continue;
          if (binding) await allowed(who, 'master.resolve', dataClasses, { targetKind: binding.targetKind, targetId: binding.targetId });
          const number = source[{ KUNDEN: 'KUND_NR', ARTIKEL_STAMM: 'EAN', MITARBEITER: 'Verkäufer_ID', FILIALEN: 'FilialID' }[table]];
          const label = table === 'ARTIKEL_STAMM' ? source.Artikelbezeichnung : table === 'FILIALEN' ? source.FName : [source.VORNAME, source.NACHNAME].filter(Boolean).join(' ');
          const event = binding ? await tx.queryOne(S.getEvent, { id: binding.lastEventId, scopeId: who.scopeId }) : null;
          const item = { id: record.id, revision: record.revision, table, number, label: label || '',
            binding: binding ? { targetId: binding.targetId, targetKind: binding.targetKind, revision: binding.revision, historical: binding.historical,
              sourceChanged: binding.sourceRevision !== record.revision } : null,
            undoEventId: event?.actorId === who.ownerId && !event.revertedAt ? event.id : null };
          if (table === 'KUNDEN') {
            item.customer = Object.fromEntries(Object.entries(CUSTOMER_MAP).map(([field, target]) => [target, source[field] ?? null]));
            if (item.customer.birthDate) item.customer.birthDate = item.customer.birthDate.slice(0, 10);
            const candidate = await tx.queryOne(S.crmFind, { number });
            item.candidate = candidate ? { id: candidate.id, revision: candidate.revision, label: candidate.companyName || [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') } : null;
          } else if (table === 'ARTIKEL_STAMM') item.candidate = await tx.queryOne(S.articleBySource, { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceArticleKey: number });
          items.push(item);
        }
        return { items, next: records.length > limit ? records[limit - 1].id : null, sourceInstance, table };
      });
    },
    async mappingTargets({ table, query = '', after = '', limit = 40 }) {
      if (!['MITARBEITER', 'FILIALEN'].includes(table)) C.fail('IMPORT_MASTER_KIND_INVALID');
      if (query !== '') C.text(query, 120); if (after) C.id(after); C.integer(limit, 1, 100);
      const who = actor(); await allowed(who, 'master.resolve', table === 'MITARBEITER' ? ['personnel_restricted'] : ['internal_business']);
      return atomic(async tx => {
        const rows = await tx.queryAll(table === 'MITARBEITER' ? S.employeeTargets : S.locationTargets, { query, after, limit: limit + 1 });
        return { items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
      });
    },
    async inspect(recordId, { include = ["attributes", "contacts", "addresses", "notes", "conditions", "media_references", "loyalty_snapshot", "provenance"] } = {}) {
      if (!Array.isArray(include) || include.some(kind => !["attributes", "contacts", "addresses", "notes", "conditions", "media_references", "loyalty_snapshot", "provenance", "financial", "legacy_personnel", "prices", "costs"].includes(kind))) C.fail("IMPORT_MASTER_SEGMENT_INVALID");
      const who = actor(); return atomic(async tx => {
        const record = await sourceRecord(tx, who, recordId), profile = checkHeader(record);
        const segments = await tx.queryAll(S.segments, { recordId });
        const result = {};
        for (const segment of segments.filter(segment => include.includes(segment.kind))) {
          await allowed(who, "master.read", [segment.dataClass]);
          const values = protection.open(segment.payload, segmentContext(record, segment));
          result[segment.kind] ||= {};
          for (const field of profile.fields.filter(field => Object.hasOwn(values, field.target))) result[segment.kind][field.source] = values[field.target];
        }
        // At least one base permission is mandatory, even for an empty projection.
        await allowed(who, "master.read", [M.tableFor(record.sourceTable).group.startsWith("crm.") ? "customer_restricted" : record.sourceTable === "MITARBEITER" ? "personnel_restricted" : "internal_business"]);
        const relations = await tx.queryAll(S.relations, { recordId, scopeId: who.scopeId });
        return { id: record.id, sourceTable: record.sourceTable, revision: record.revision, segments: result,
          omittedSegments: [...new Set(segments.map(segment => segment.kind))].filter(kind => !include.includes(kind)),
          relations: relations.map(({ slot, parentTable, state, targetId }) => ({ slot, parentTable, status: state === "candidate" ? targetId ? "resolved" : "unresolved" : state, targetId })) };
      });
    },
    async view(recordId, options) {
      return buildTradeFotoMasterView(await service.inspect(recordId, options));
    },
    async previewCustomer(input) {
      const who = actor(); return atomic(async tx => {
        const plan = await planCustomer(tx, who, input);
        return { planHash: plan.planHash, action: plan.action, proposed: plan.proposed, targetId: plan.before?.id || null,
          changedFields: CUSTOMER_FIELDS.filter(key => !plan.before || !C.equal(plan.before[key], plan.after[key])) };
      });
    },
    async syncCustomer(input, planHash) {
      C.sha(planHash); const who = actor(); return atomic(async tx => {
        const plan = await planCustomer(tx, who, input);
        if (plan.planHash !== planHash) C.fail("IMPORT_PREVIEW_CHANGED", 409);
        const id = plan.before?.id || crypto.randomUUID(), eventId = crypto.randomUUID();
        const changed = !plan.before || !C.equal(customerData(plan.before), plan.after);
        if (!plan.before) await expectOne(tx, S.crmInsert, { id, ...plan.after, actor: who.ownerId, timestamp: now() });
        else if (changed) await expectOne(tx, S.crmUpdate, { id, expectedRevision: plan.before.revision, ...plan.after, actor: who.ownerId, timestamp: now() });
        const after = await tx.queryOne(S.crmGet, { id });
        const binding = await saveBinding(tx, plan.record, plan.beforeBinding, "crm_customer", id, eventId,
          { proposed: plan.proposed, decision: plan.decision, targetRevision: after.revision });
        await event(tx, who, plan.record, "import.customer." + plan.action,
          { beforeBinding: plan.beforeBinding, before: plan.before, after, binding }, eventId);
        return { eventId, targetId: id, revision: after.revision, bindingRevision: binding.revision, action: plan.action, changed };
      });
    },
    async previewBinding(input) {
      const who = actor(); return atomic(async tx => {
        const plan = await planBinding(tx, who, input); return { planHash: plan.planHash, targetKind: plan.kind, targetId: plan.target.id, historical: plan.historical };
      });
    },
    async bind(input, planHash) {
      C.sha(planHash); const who = actor(); return atomic(async tx => {
        const plan = await planBinding(tx, who, input);
        if (plan.planHash !== planHash) C.fail("IMPORT_PREVIEW_CHANGED", 409);
        const eventId = crypto.randomUUID();
        const binding = await saveBinding(tx, plan.record, null, plan.kind, plan.target.id, eventId,
          { target: plan.target, reason: plan.reason }, plan.historical);
        await event(tx, who, plan.record, "import.master.link", { beforeBinding: null, before: null, after: null, binding }, eventId);
        return { eventId, targetId: plan.target.id, targetKind: plan.kind, historical: plan.historical };
      });
    },
    async undo(eventId) {
      C.id(eventId); const who = actor(); return atomic(async tx => {
        const stored = await tx.queryOne(S.getEvent, { id: eventId, scopeId: who.scopeId });
        if (!stored || stored.revertedAt || stored.actorId !== who.ownerId) C.fail("IMPORT_UNDO_EVENT_UNAVAILABLE", 409);
        const record = await sourceRecord(tx, who, stored.recordId), binding = await bindingFor(tx, record);
        if (!binding || binding.lastEventId !== eventId) C.fail("IMPORT_UNDO_LATER_IMPORT", 409);
        const dataClasses = binding.targetKind === "crm_customer" ? ["customer_restricted"] : binding.targetKind === "employee" ? ["personnel_restricted"] : ["internal_business"];
        await allowed(who, "master.undo", dataClasses, { targetKind: binding.targetKind, targetId: binding.targetId });
        const data = protection.open(stored.payload, eventContext(stored));
        if (data.binding.recordId !== record.id || data.binding.targetId !== binding.targetId) C.fail("IMPORT_MASTER_INTEGRITY");
        if ((await tx.queryOne(S.holdCount, { recordId: record.id })).count) C.fail("IMPORT_UNDO_DEPENDENCIES", 409);
        let restored = null;
        if (binding.targetKind === "crm_customer") {
          const current = await tx.queryOne(S.crmGet, { id: binding.targetId });
          if (!current || current.revision !== bindingPayload(binding).targetRevision || !C.equal(customerData(current), customerData(data.after))) C.fail("IMPORT_UNDO_MANUAL_CHANGE", 409);
          if (!data.before) {
            if ((await tx.queryOne(S.crmDependents, { id: current.id, recordId: record.id })).count) C.fail("IMPORT_UNDO_DEPENDENCIES", 409);
            await expectOne(tx, S.crmRemove, { id: current.id, expectedRevision: current.revision });
          } else if (!C.equal(customerData(current), customerData(data.before))) {
            await expectOne(tx, S.crmUpdate, { id: current.id, expectedRevision: current.revision, ...customerData(data.before), actor: who.ownerId, timestamp: now() });
            restored = await tx.queryOne(S.crmGet, { id: current.id });
          } else restored = current;
        }
        await expectOne(tx, S.removeBinding, { recordId: record.id, expectedRevision: binding.revision });
        if (data.beforeBinding) {
          const previousData = bindingPayload(data.beforeBinding), previous = { ...data.beforeBinding, revision: binding.revision + 1 };
          if (restored) previousData.targetRevision = restored.revision;
          previous.payload = protection.seal(previousData, bindingContext(previous));
          await expectOne(tx, S.insertBinding, previous);
        }
        await expectOne(tx, S.revertEvent, { id: eventId, scopeId: who.scopeId, at: now() });
        await event(tx, who, record, "import.master.undo", { undoneEventId: eventId });
        return { reverted: true, eventId };
      });
    },
    async resolve(name, key, sourceInstance) {
      M.tableFor(name); C.id(sourceInstance); const who = actor();
      const dataClasses = name === "KUNDEN" ? ["customer_restricted"] : name === "MITARBEITER" ? ["personnel_restricted"] : ["internal_business"];
      await allowed(who, "master.resolve", dataClasses);
      if (!Array.isArray(key) || key.some(value => typeof value !== "string")) C.fail("IMPORT_KEY_INVALID");
      if (["KUNDEN", "MITARBEITER"].includes(name) && C.equal(key, ["0"])) return { status: "unassigned", targetId: null };
      return atomic(async tx => {
        const record = await tx.queryOne(S.find, { scopeId: who.scopeId, identityHash: M.masterIdentity(protection, { ...who, sourceInstance }, name, key) });
        if (!record) return { status: "missing_source", targetId: null };
        await loadMaster(tx, protection, record);
        const binding = await bindingFor(tx, record);
        if (!binding) return { status: "unlinked", targetId: null, recordId: record.id };
        await allowed(who, "master.resolve", dataClasses, { targetKind: binding.targetKind, targetId: binding.targetId });
        let status = binding.historical ? "historical_mapping" : "linked";
        if (["employee", "location"].includes(binding.targetKind)) {
          const target = await tx.queryOne(binding.targetKind === "employee" ? S.employee : S.location, { id: binding.targetId });
          if (!target) status = "target_missing";
          else if (!target.active && !binding.historical) status = "target_inactive";
        } else if (binding.targetKind === "crm_customer" && !await tx.queryOne(S.crmGet, { id: binding.targetId })) status = "target_missing";
        else if (binding.targetKind === "sales_article") {
          const source = await sourceData(tx, record);
          const target = await tx.queryOne(S.articleBySource, { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceArticleKey: source.EAN });
          if (!target || target.id !== binding.targetId) status = "target_missing";
          else if (!target.active && !binding.historical) status = "target_inactive";
        }
        return { status, targetId: binding.targetId, targetKind: binding.targetKind, recordId: record.id, sourceChanged: binding.sourceRevision !== record.revision };
      });
    },
  };
  return Object.freeze(service);
}
// Trusted composition helper: callers supply the SAME transaction used for their
// document write and its source holds. This never creates or guesses GP masters.
function createImportMasterReferenceReader({ protection, authorize }) {
  if (typeof authorize !== "function") C.fail("IMPORT_COMPOSITION_INVALID");
  const kinds = { KUNDEN: "crm_customer", MITARBEITER: "employee", FILIALEN: "location", ARTIKEL_STAMM: "sales_article" };
  return async function readReference(tx, context, name, key) {
    const kind = kinds[name]; if (!kind) C.fail("IMPORT_MASTER_KIND_INVALID");
    const dataClasses = name === "KUNDEN" ? ["customer_restricted"] : name === "MITARBEITER" ? ["personnel_restricted"] : ["internal_business"];
    const request = { scopeId: C.id(context.scopeId), ownerId: C.id(context.ownerId), action: "history.reference", dataClasses, targetKind: kind };
    if (await authorize(Object.freeze(request)) !== true) C.fail("IMPORT_FORBIDDEN", 403);
    C.id(context.sourceInstance);
    const result = { table: name, key, targetKind: kind, status: "unassigned", recordId: null, sourceRevision: null,
      bindingRevision: null, targetId: null, targetRevision: null, sourceChanged: false };
    if (key === null) return result;
    if (!Array.isArray(key) || key.length !== 1) C.fail("IMPORT_KEY_INVALID");
    C.text(key[0], 256);
    if (["KUNDEN", "MITARBEITER"].includes(name) && key[0] === "0") return result;
    const record = await tx.queryOne(S.find, { scopeId: context.scopeId, identityHash: M.masterIdentity(protection, context, name, key) });
    if (!record) return { ...result, status: "missing_source" };
    if (record.sourceInstance !== context.sourceInstance || record.sourceTable !== name) C.fail("IMPORT_MASTER_INTEGRITY");
    const master = await loadMaster(tx, protection, record);
    Object.assign(result, { recordId: record.id, sourceRevision: record.revision, status: "unlinked" });
    const binding = await tx.queryOne(S.getBinding, { recordId: record.id });
    if (!binding) return result;
    if (binding.scopeId !== record.scopeId || binding.sourceInstance !== record.sourceInstance || binding.sourceTable !== name || binding.targetKind !== kind) C.fail("IMPORT_MASTER_INTEGRITY");
    protection.open(binding.payload, bindingContext(binding));
    if (await authorize(Object.freeze({ ...request, targetId: binding.targetId })) !== true) C.fail("IMPORT_FORBIDDEN", 403);
    const target = kind === "sales_article"
      ? await tx.queryOne(S.articleBySource, { sourceSystem: TRADEFOTO_ARTICLE_SOURCE_SYSTEM, sourceArticleKey: M.masterSource(name, master.data).EAN })
      : await tx.queryOne(kind === "crm_customer" ? S.crmGet : kind === "employee" ? S.employee : S.location, { id: binding.targetId });
    return { ...result, bindingRevision: binding.revision, sourceChanged: binding.sourceRevision !== record.revision,
      targetId: binding.targetId, targetRevision: target?.revision ?? null,
      status: !target || target.id !== binding.targetId ? "target_missing" : target.active === false && !binding.historical ? "target_inactive" : binding.historical ? "historical_mapping" : "linked" };
  };
}
module.exports = { createImportMasterWriters, createImportMasterService, createImportMasterReferenceReader, CUSTOMER_MAP };
