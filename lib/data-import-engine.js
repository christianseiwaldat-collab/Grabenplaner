"use strict";

const crypto = require("node:crypto");
const C = require("./data-import-contract");
const T = require("./data-import-source-tolerance");
const { createDataImportPayloadStore } = require("./data-import-payload-store");
const { assertDataImportRepository } = require("./persistence/repositories/data-import");

const ROW_CONTEXT = (run, number) => ["row", run.scopeId, run.id, number];
const LINK_CONTEXT = hash => ["link", hash];
const CHANGE_CONTEXT = (run, number) => ["change", run.scopeId, run.id, number];
const slot = (object, key) => Object.hasOwn(object, key) ? [true, object[key]] : [false, null];
const requiredWriterMethods = ["read", "findExisting", "create", "update", "restore", "canRestore", "canRemove", "remove"];

// No writers, routes or key provisioning are registered inside this engine.
// The composition root must supply trusted profiles, authorization and transaction-bound writers.
function createDataImportEngine({ repository, protection, profiles, writers = {}, sourceTolerances = [], sharedPayloads = false, operationBatchSize = C.LIMITS.batch, operationBudgetMs = Infinity, getActor, authorize, clock = () => new Date().toISOString() }) {
  assertDataImportRepository(repository);
  C.integer(operationBatchSize, 1, C.LIMITS.batch);
  if (operationBudgetMs !== Infinity && (!Number.isFinite(operationBudgetMs) || operationBudgetMs < 1)) C.fail('IMPORT_COMPOSITION_INVALID');
  if (!protection || ["seal", "open", "digest"].some(name => typeof protection[name] !== "function") || typeof getActor !== "function" || typeof authorize !== "function") C.fail("IMPORT_COMPOSITION_INVALID");
  if (typeof sharedPayloads !== "boolean") C.fail("IMPORT_COMPOSITION_INVALID");
  // Both formats remain readable. New shared writes require explicit composition
  // approval; schema installation alone never converts existing evidence.
  const payloadStore = createDataImportPayloadStore({ protection });
  if (!Array.isArray(profiles) || new Set(profiles.map(profile => C.canonical([profile.sourceSystem, profile.id, profile.version]))).size !== profiles.length) C.fail("IMPORT_PROFILE_REGISTRY_INVALID");
  const registry = new Map(profiles.map(profile => [C.assertProfile(profile).fingerprint, profile]));
  const tolerances = T.sourceToleranceRegistry(sourceTolerances);
  const gatesFor = run => T.effectiveSourceGates(run.manifest, knownProfile(run.profileHash), tolerances);
  const writerRegistry = new Map(Object.entries(writers));
  for (const [entity, writer] of writerRegistry) {
    C.id(entity);
    if (requiredWriterMethods.some(name => typeof writer[name] !== "function")) C.fail("IMPORT_WRITER_INVALID");
    if (writer.review !== undefined && typeof writer.review !== "function") C.fail("IMPORT_WRITER_INVALID");
    if (writer.prepareRead !== undefined && typeof writer.prepareRead !== "function") C.fail("IMPORT_WRITER_INVALID");
    if (writer.createBatch !== undefined && typeof writer.createBatch !== "function") C.fail("IMPORT_WRITER_INVALID");
  }
  const now = () => C.utc(clock());
  const writerContext = (run, profile) => Object.freeze({ scopeId: run.scopeId, ownerId: run.ownerId,
    sourceInstance: run.manifest.sourceInstance, sourceSystem: profile.sourceSystem,
    fileSha256: run.manifest.fileSha256, snapshotAt: run.manifest.snapshotAt,
    sourceTable: profile.sourceTable, profileHash: profile.fingerprint, runId: run.id, at: now() });
  const identity = (run, profile, record) => protection.digest(["identity", run.scopeId, profile.sourceSystem, run.manifest.sourceInstance, profile.sourceTable, profile.entity, profile.keyFields, record.key]);
  function sanitizedFailure(error) {
    return require('./data-import-errors').importFailure(error);
  }
  function actor() { const value = getActor(); C.exact(value, ["scopeId", "ownerId"]); return { scopeId: C.id(value.scopeId), ownerId: C.id(value.ownerId) }; }
  async function allowed(who, action, profile) {
    if (await authorize(Object.freeze({ ...who, action, dataClasses: profile.dataClasses })) !== true) C.fail("IMPORT_FORBIDDEN", 403);
  }
  function knownProfile(hash) { const profile = registry.get(hash); if (!profile) C.fail("IMPORT_PROFILE_UNAVAILABLE", 409); return profile; }
  function verifyRun(run, profile) {
    if (!C.equal(run.profile, profile)) C.fail("IMPORT_PROFILE_INTEGRITY");
    const expectedId = protection.digest(["run", C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId]);
    if (run.id !== expectedId) C.fail("IMPORT_RUN_INTEGRITY");
  }
  function revision(run, expected) { C.integer(expected, 1, Number.MAX_SAFE_INTEGER); if (run.revision !== expected) C.fail("IMPORT_REVISION_CONFLICT", 409); }
  function state(run, states) { if (!states.includes(run.status)) C.fail("IMPORT_STATE_CONFLICT", 409); }
  function live(run) { if (run.expiresAt <= now()) C.fail("IMPORT_RUN_EXPIRED", 409); }
  async function changeRun(tx, run, status, action, receivedCount = run.receivedCount) {
    const at = now();
    await tx.expectOne("updateRun", { id: run.id, revision: run.revision, status, receivedCount, updatedAt: at });
    await tx.expectOne("insertEvent", { id: crypto.randomUUID(), runId: run.id, revision: run.revision + 1, actorId: run.ownerId, action, at });
    return { ...run, revision: run.revision + 1, status, receivedCount, updatedAt: at };
  }
  async function checkpoint(run) {
    const profile = knownProfile(run.profileHash);
    const gates = gatesFor(run);
    const canApply = run.status === "ready" && run.expiresAt > now() && !gates.length && writerRegistry.has(profile.entity)
      && await authorize(Object.freeze({ scopeId: run.scopeId, ownerId: run.ownerId, action: "apply", dataClasses: profile.dataClasses })) === true;
    return { id: run.id, revision: run.revision, status: run.status, expectedRows: run.manifest.expectedRows, receivedRows: run.receivedCount,
      gates, expiresAt: run.expiresAt,
      ...(run.manifest.acceptedDeviations ? { declaredRows: run.manifest.declaredRows, originalGates: [...run.manifest.originalGates],
        acceptedDeviations: run.manifest.acceptedDeviations } : {}),
      canApply };
  }
  async function summary(tx, run, knownCounts) {
    const counts = knownCounts || Object.fromEntries((await tx.counts({ runId: run.id })).map(row => [row.state, row.count]));
    return { ...await checkpoint(run), counts };
  }
  async function inRun(runId, action, work) {
    const who = actor(); C.sha(runId);
    return repository.atomic(async (tx, executor) => {
      const run = await tx.getRun({ id: runId, ...who });
      if (!run) C.fail("IMPORT_RUN_NOT_FOUND", 404);
      const profile = knownProfile(run.profileHash);
      verifyRun(run, profile);
      await allowed(who, "read", profile);
      if (action !== "read") await allowed(who, action, profile);
      return work(tx, executor, run, profile);
    },{readOnly:['read','read_sensitive','catalog.read'].includes(action)}).catch(sanitizedFailure);
  }
  async function decodeRow(tx, run, row) {
    const decoded = await payloadStore.decode(tx, { run, profile: knownProfile(run.profileHash), row, kind: "row" });
    const original = decoded.record ? { record: decoded.record } : { invalidSource: decoded.invalidSource };
    if (protection.digest(original) !== row.contentHash || (decoded.record && identity(run, knownProfile(run.profileHash), decoded.record) !== row.identityHash)) C.fail("IMPORT_ROW_INTEGRITY");
    return decoded;
  }
  async function encodePayload(tx, run, row, kind, value) {
    if (sharedPayloads) return payloadStore.encode(tx, { run, profile: knownProfile(run.profileHash), row, kind, value, at: now() });
    return { payload: protection.seal(value, kind === "row" ? ROW_CONTEXT(run, row.rowNumber) : CHANGE_CONTEXT(run, row.rowNumber)), refs: [] };
  }
  async function encodeRows(tx, run, rows, values, kind = 'row') {
    if (sharedPayloads) return payloadStore.encodeBatch(tx, rows.map((row, i) => ({run, profile:knownProfile(run.profileHash), row, kind, value:values[i], at:now()})));
    return rows.map((row, i) => ({payload:protection.seal(values[i], kind === 'row' ? ROW_CONTEXT(run, row.rowNumber) : CHANGE_CONTEXT(run, row.rowNumber)), refs:[]}));
  }
  async function saveRow(tx, run, row, stateValue, issue, payload) {
    const encoded = await encodePayload(tx, run, row, "row", payload);
    await tx.expectOne("updateRow", { runId: run.id, rowNumber: row.rowNumber, state: stateValue, issue,
      payload: encoded.payload });
    await payloadStore.publishRefs(tx, { run, row, kind: "row", refs: encoded.refs });
  }
  function validateTarget(target) {
    if (target === null) return null;
    C.exact(target, ["id", "revision", "data"]); C.id(target.id); C.integer(target.revision, 1, Number.MAX_SAFE_INTEGER);
    if (!C.plain(target.data) || Buffer.byteLength(C.canonical(target.data)) > C.LIMITS.rowBytes * 2) C.fail("IMPORT_TARGET_INVALID");
    return target;
  }
  async function writerReview(executor, writer, record, context) {
    if (!writer.review) return null;
    const result = await writer.review(executor, record, context);
    C.exact(result, ["issue", "token", "rewrite"]);
    if (typeof result.issue !== "string" || (result.issue && !/^[A-Z][A-Z0-9_]{2,79}$/u.test(result.issue)) || typeof result.rewrite !== "boolean") C.fail("IMPORT_WRITER_CONTRACT");
    C.sha(result.token); return result;
  }
  async function makePlan(tx, executor, run, profile, row, decoded = null) {
    decoded ||= await decodeRow(tx, run, row);
    const writer = writerRegistry.get(profile.entity);
    if (!writer) return { ...decoded, action: "conflict", issue: "TARGET_ADAPTER_PENDING" };
    const validation = await writerReview(executor, writer, decoded.record, writerContext(run, profile));
    if (validation?.issue) return { ...decoded, validation, action: "conflict", issue: validation.issue };
    const beforeLink = await tx.getLink({ id: row.identityHash });
    if (!beforeLink) {
      const matches = await writer.findExisting(executor, decoded.record, writerContext(run, profile));
      if (!Array.isArray(matches)) C.fail("IMPORT_WRITER_CONTRACT");
      return { ...decoded, validation, beforeLink: null, beforeTarget: null, patch: decoded.record.data,
        action: matches.length ? "conflict" : "create", issue: matches.length ? "UNLINKED_TARGET_EXISTS" : "" };
    }
    if (beforeLink.scopeId !== run.scopeId || beforeLink.entity !== profile.entity) C.fail("IMPORT_LINK_INTEGRITY");
    const previous = protection.open(beforeLink.payload, LINK_CONTEXT(beforeLink.id));
    const target = validateTarget(await writer.read(executor, beforeLink.targetId, writerContext(run, profile)));
    if (!target) return { ...decoded, action: "conflict", issue: "LINKED_TARGET_MISSING" };
    const patch = {};
    for (const [key, value] of Object.entries(decoded.record.data)) {
      const baseline = slot(previous.record.data, key), incoming = [true, value], current = slot(target.data, key);
      if (C.equal(baseline, incoming) || C.equal(current, incoming)) continue;
      if (!C.equal(baseline, current)) return { ...decoded, action: "conflict", issue: "MANUAL_FIELD_CONFLICT" };
      patch[key] = value;
    }
    return { ...decoded, validation, beforeLink, beforeTarget: target, patch, issue: "",
      action: Object.keys(patch).length || validation?.rewrite ? "update" : previous.contentHash === row.contentHash ? "unchanged" : "refresh" };
  }
  async function checkedCurrentLink(tx, plan, identityHash) {
    const current = await tx.getLink({ id: identityHash });
    if (!C.equal(current, plan.beforeLink)) C.fail("IMPORT_SOURCE_LINK_CHANGED", 409);
    return current;
  }
  async function checkedCurrentTarget(executor, writer, plan, context) {
    if (!plan.beforeTarget) {
      const matches = await writer.findExisting(executor, plan.record, context);
      if (!Array.isArray(matches) || matches.length) C.fail("IMPORT_TARGET_CHANGED", 409);
      return null;
    }
    const current = validateTarget(await writer.read(executor, plan.beforeTarget.id, context));
    if (!C.equal(current, plan.beforeTarget)) C.fail("IMPORT_TARGET_CHANGED", 409);
    return current;
  }
  function validateWrite(result, expectedId, oldRevision, expectedData) {
    const target = validateTarget(result);
    if (!target || target.id !== expectedId || target.revision <= oldRevision || !C.equal(target.data, expectedData)) C.fail("IMPORT_WRITER_CONTRACT");
    return target;
  }
  async function applyCreates(tx, executor, run, profile, writer, rows, plans) {
    const context = writerContext(run, profile), inputs = [];
    // Validate the entire packet against this transaction's current state before
    // writing any target. Unique constraints remain the final concurrency guard.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], plan = plans[i];
      if (row.state !== 'create' || plan.action !== row.state || plan.beforeLink || plan.beforeTarget) C.fail('IMPORT_PLAN_INTEGRITY');
      await checkedCurrentLink(tx, plan, row.identityHash);
      if (!C.equal(await writerReview(executor, writer, plan.record, context), plan.validation ?? null)) C.fail('IMPORT_DEPENDENCIES_CHANGED', 409);
      await checkedCurrentTarget(executor, writer, plan, context);
      inputs.push({id:crypto.randomUUID(),data:plan.record.data});
    }
    const results = await writer.createBatch(executor, inputs, context);
    if (!Array.isArray(results) || results.length !== rows.length) C.fail('IMPORT_WRITER_CONTRACT');
    const after = results.map((result,i) => validateWrite(result,inputs[i].id,0,inputs[i].data));
    const links = rows.map((row,i) => ({id:row.identityHash,scopeId:run.scopeId,entity:profile.entity,targetId:after[i].id,revision:1,lastRunId:run.id,
      payload:protection.seal({record:plans[i].record,contentHash:row.contentHash,targetRevision:after[i].revision},LINK_CONTEXT(row.identityHash))}));
    if ((await tx.insertLinks(links)).rowsAffected !== rows.length) C.fail('IMPORT_CONCURRENT_CHANGE',409);
    const changes = await encodeRows(tx,run,rows,after.map(target => ({action:'create',beforeTarget:null,afterTarget:target,beforeLink:null})),'change');
    if ((await tx.insertChanges(rows.map((row,i) => ({runId:run.id,rowNumber:row.rowNumber,identityHash:row.identityHash,payload:changes[i].payload,revertedAt:null})))).rowsAffected !== rows.length) C.fail('IMPORT_CONCURRENT_CHANGE',409);
    await tx.insertChangeRefs(run.id,rows.map((row,i) => ({rowNumber:row.rowNumber,refs:changes[i].refs})));
    // Application changes the state, not the authenticated review plan. Keep
    // that exact ciphertext and its existing references after validating it;
    // re-encrypting the same plan would add no evidence or concurrency check.
    if ((await tx.markCreatesApplied(run.id,rows.map(row => row.rowNumber))).rowsAffected !== rows.length) C.fail('IMPORT_CONCURRENT_CHANGE',409);
  }
  async function undoCheck(tx, executor, run, profile, change) {
    const originalRow = await tx.getRow({ runId: run.id, rowNumber: change.rowNumber });
    if (!originalRow || originalRow.identityHash !== change.identityHash) C.fail("IMPORT_ROW_INTEGRITY");
    const undo = await payloadStore.decode(tx, { run, profile, row: { ...originalRow, payload: change.payload }, kind: "change" });
    const link = await tx.getLink({ id: change.identityHash });
    if (!link || link.lastRunId !== run.id || link.scopeId !== run.scopeId || link.entity !== profile.entity || link.targetId !== undo.afterTarget.id) C.fail("IMPORT_UNDO_LATER_IMPORT", 409);
    const writer = writerRegistry.get(profile.entity); if (!writer) C.fail("IMPORT_TARGET_ADAPTER_PENDING", 409);
    const baseline = protection.open(link.payload, LINK_CONTEXT(link.id));
    const context = writerContext(run, profile);
    const current = validateTarget(await writer.read(executor, link.targetId, context));
    if (!current || current.revision !== baseline.targetRevision || !C.equal(current.data, undo.afterTarget.data)) C.fail("IMPORT_UNDO_MANUAL_CHANGE", 409);
    if (undo.action === "create" && await writer.canRemove(executor, current.id, context) !== true) C.fail("IMPORT_UNDO_DEPENDENCIES", 409);
    if (undo.action === "update" && await writer.canRestore(executor, current, undo.beforeTarget, context) !== true) C.fail("IMPORT_UNDO_DEPENDENCIES", 409);
    return { undo, link, current };
  }
  const engine = {
    async list({ beforeAt = "9999-12-31T23:59:59.999Z", beforeId = "f".repeat(64), limit = 20 } = {}) {
      const who = actor(); C.utc(beforeAt); C.sha(beforeId); C.integer(limit, 1, 100);
      return repository.atomic(async tx => {
        const runs = await tx.listRuns({ ...who, beforeAt, beforeId, limit });
        const items = [];
        for (const run of runs) {
          const profile = knownProfile(run.profileHash);
          verifyRun(run, profile);
          if (await authorize(Object.freeze({ ...who, action: "read", dataClasses: profile.dataClasses })) === true) items.push(await summary(tx, run));
        }
        const last = runs.at(-1);
        return { items, next: last ? { beforeAt: last.createdAt, beforeId: last.id } : null };
      });
    },
    async start({ profileHash, manifest: suppliedManifest, attemptId = "default", existingRunId }) {
      const who = actor(), profile = knownProfile(C.sha(profileHash)); C.id(attemptId);
      await allowed(who, "read", profile); await allowed(who, "stage", profile);
      const original = C.normalizeDataImportManifest(suppliedManifest, profile), at = now();
      // A restart must preserve the original decision, even across a registry change.
      if (existingRunId !== undefined) return inRun(existingRunId, "stage", async (tx, _executor, run) => {
        if (run.profileHash !== profile.fingerprint || run.attemptId !== attemptId || !C.equal(T.originalManifest(run.manifest), original)) C.fail("IMPORT_RUN_INTEGRITY");
        return summary(tx, run);
      });
      const manifest = T.acceptSourceTolerances(original, profile, tolerances);
      const runId = protection.digest(["run", C.VERSION, who, profile.fingerprint, manifest, attemptId]);
      return repository.atomic(async tx => {
        const candidate = { id: runId, ...who, attemptId, profileHash: profile.fingerprint, profile, manifest, status: "staging", revision: 1,
          receivedCount: 0, createdAt: at, updatedAt: at, expiresAt: new Date(Date.parse(at) + 30 * 86400000).toISOString() };
        const inserted = await tx.insertRun(candidate);
        if (inserted.rowsAffected === 1) await tx.expectOne("insertEvent", { id: crypto.randomUUID(), runId, revision: 1, actorId: who.ownerId, action: "import.start", at });
        let run = await tx.getRun({ id: runId, ...who });
        if (!run || !C.equal(run.manifest, manifest) || run.profileHash !== profile.fingerprint) C.fail("IMPORT_RUN_INTEGRITY");
        if (inserted.rowsAffected === 1 && manifest.acceptedDeviations) run = await changeRun(tx, run, "staging", "import.source-tolerance.accepted");
        return summary(tx, run);
      }).catch(sanitizedFailure);
    },
    async stage(runId, { expectedRevision, startRow, rows }) {
      return inRun(runId, "stage", async (tx, _executor, run, profile) => {
        live(run); C.integer(startRow, 1); if (!Array.isArray(rows) || !rows.length || rows.length > C.LIMITS.batch) C.fail("IMPORT_BATCH_INVALID", 413);
        const prepared = rows.map((raw, offset) => {
          // Unknown columns are schema drift: reject the entire batch without losing earlier batches.
          C.exact(raw, [...profile.fields.map(field => field.source), ...profile.excludedFields]);
          const original = Object.fromEntries(profile.fields.filter(field => Object.hasOwn(raw, field.source)).map(field => [field.source, raw[field.source]]));
          for (const value of Object.values(original)) if (!(value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value))) C.fail("IMPORT_SOURCE_VALUE_UNSUPPORTED");
          if (Buffer.byteLength(C.canonical(original)) > C.LIMITS.rowBytes) C.fail("IMPORT_ROW_TOO_LARGE", 413);
          let payload, issue = "", identityHash = null;
          try {
            const record = C.normalizeDataImportRow(profile, raw); payload = { record };
            identityHash = identity(run, profile, record);
          } catch (error) {
            if (!(error instanceof C.DataImportError)) throw error;
            issue = error.code; payload = { invalidSource: original };
          }
          return { rowNumber: C.integer(startRow + offset, 1), identityHash, contentHash: protection.digest(payload), issue, payload };
        });
        if (startRow + rows.length - 1 <= run.receivedCount) {
          const saved = tx.insertRows ? new Map((await tx.listRows({runId, after:startRow - 1, limit:rows.length})).map(row => [row.rowNumber,row])) : null;
          for (const row of prepared) {
            const existing = saved ? saved.get(row.rowNumber) : await tx.getRow({ runId, rowNumber: row.rowNumber });
            if (!existing || existing.contentHash !== row.contentHash || existing.identityHash !== row.identityHash) C.fail("IMPORT_REPLAY_CONFLICT", 409);
          }
          return summary(tx, run); // Lost-response retry, even when its revision is now stale.
        }
        revision(run, expectedRevision); state(run, ["staging"]);
        if (startRow !== run.receivedCount + 1 || startRow + rows.length - 1 > run.manifest.expectedRows) C.fail("IMPORT_BATCH_SEQUENCE", 409);
        if (tx.insertRows) {
          const previous = new Map((await tx.findIdentities(runId, [...new Set(prepared.map(row => row.identityHash).filter(Boolean))])).map(row => [row.identityHash,{...row}]));
          const conflicts = new Set(), stored = [];
          for (const row of prepared) {
            let rowState = row.issue ? 'invalid' : 'staged';
            if (row.identityHash) {
              const before = previous.get(row.identityHash);
              if (before) {
                if (before.contentHash === row.contentHash && before.state !== 'conflict') rowState = 'duplicate';
                else { rowState = 'conflict'; row.issue = 'SOURCE_KEY_CONFLICT'; conflicts.add(row.identityHash); before.state = 'conflict'; }
              }
              if (!before) previous.set(row.identityHash, {contentHash:row.contentHash,state:rowState});
            }
            stored.push({runId,rowNumber:row.rowNumber,identityHash:row.identityHash,contentHash:row.contentHash,state:rowState,issue:row.issue});
          }
          const encoded = await encodeRows(tx, run, prepared, prepared.map(row => row.payload));
          stored.forEach((row, i) => {row.payload = encoded[i].payload;});
          if ((await tx.insertRows(stored)).rowsAffected !== stored.length) C.fail('IMPORT_CONCURRENT_CHANGE', 409);
          for (const identityHash of conflicts) await tx.conflictIdentity({runId,identityHash});
          await tx.replaceRowRefs(runId, stored.map((row, i) => ({rowNumber:row.rowNumber,refs:encoded[i].refs})));
          return summary(tx, await changeRun(tx, run, 'staging', 'import.stage', run.receivedCount + rows.length));
        }
        for (const row of prepared) {
          let rowState = row.issue ? "invalid" : "staged";
          if (row.identityHash) {
            const previous = await tx.findIdentity({ runId, identityHash: row.identityHash });
            if (previous) {
              if (previous.contentHash === row.contentHash && previous.state !== "conflict") rowState = "duplicate";
              else { rowState = "conflict"; row.issue = "SOURCE_KEY_CONFLICT"; await tx.conflictIdentity({ runId, identityHash: row.identityHash }); }
            }
          }
          const encoded = await encodePayload(tx, run, row, "row", row.payload);
          await tx.expectOne("insertRow", { runId, rowNumber: row.rowNumber, identityHash: row.identityHash, contentHash: row.contentHash,
            state: rowState, issue: row.issue, payload: encoded.payload });
          await payloadStore.publishRefs(tx, { run, row, kind: "row", refs: encoded.refs });
        }
        return summary(tx, await changeRun(tx, run, "staging", "import.stage", run.receivedCount + rows.length));
      });
    },
    async seal(runId, expectedRevision) {
      return inRun(runId, "stage", async (tx, _executor, run) => {
        live(run); revision(run, expectedRevision); state(run, ["staging"]);
        if (run.receivedCount !== run.manifest.expectedRows) C.fail("IMPORT_SOURCE_INCOMPLETE", 409);
        return summary(tx, await changeRun(tx, run, "reviewing", "import.seal"));
      });
    },
    async review(runId, expectedRevision) {
      return inRun(runId, "review", async (tx, executor, run, profile) => {
        live(run); revision(run, expectedRevision); state(run, ["reviewing"]);
        const started = performance.now();
        const rows = await tx.pendingReview({ runId, limit: operationBatchSize }), plans = [], reviewed = [];
        await tx.prepareRead?.(runId, rows);
        const writer = writerRegistry.get(profile.entity), decoded = [];
        if (tx.prepareRead && writer?.prepareRead && rows.length) {
          for (const row of rows) decoded.push(await decodeRow(tx, run, row));
          await writer.prepareRead(executor, decoded.map(value => value.record), writerContext(run,profile));
        }
        let index = 0;
        for (const row of rows) {
          const plan = await makePlan(tx, executor, run, profile, row, decoded[index++] || null);
          if (tx.updateRows) { reviewed.push(row); plans.push(plan); }
          else await saveRow(tx, run, row, plan.action, plan.issue, plan);
          if (performance.now() - started >= operationBudgetMs) break;
        }
        if (reviewed.length) {
          const encoded = await encodeRows(tx, run, reviewed, plans);
          const saved = reviewed.map((row, i) => ({runId,rowNumber:row.rowNumber,state:plans[i].action,issue:plans[i].issue,payload:encoded[i].payload}));
          if ((await tx.updateRows(saved)).rowsAffected !== saved.length) C.fail('IMPORT_CONCURRENT_CHANGE', 409);
          await tx.replaceRowRefs(runId, reviewed.map((row, i) => ({rowNumber:row.rowNumber,refs:encoded[i].refs})));
        }
        const counts = Object.fromEntries((await tx.counts({ runId })).map(row => [row.state, row.count]));
        const status = counts.staged ? "reviewing" : (counts.conflict || counts.invalid || gatesFor(run).length || !writerRegistry.has(profile.entity)) ? "needs_review" : "ready";
        return summary(tx, await changeRun(tx, run, status, "import.review"), counts);
      });
    },
    async recheck(runId, expectedRevision) {
      return inRun(runId, "review", async (tx, _executor, run) => {
        live(run); revision(run, expectedRevision); state(run, ["ready", "needs_review"]);
        // A parent table may have been applied since the first preview. Rebuild
        // every plan; never bypass dependency tokens or clear source errors.
        const pending=await tx.pendingRecheck({runId});
        if(pending)await tx.resetReviewBatch({runId,state:pending.state,limit:operationBatchSize});
        const remaining=await tx.pendingRecheck({runId});
        // No plan can be applied while staged rows remain. Only start rebuilding
        // plans after every old plan has left the bounded reset queue.
        return summary(tx, await changeRun(tx, run, remaining?run.status:"reviewing", "import.recheck"));
      });
    },
    async checkpoint(runId) { return inRun(runId, "read", (_tx, _executor, run) => checkpoint(run)); },
    // Internal projection for the unified Trade import; never an HTTP raw-data
    // endpoint. Credentials, customer data and unrelated fields cannot enter it.
    async articleCatalogRows(runId,{after=0}={}) {
      C.integer(after,0,C.LIMITS.rows);
      return inRun(runId,'catalog.read',async(tx,_executor,run,profile)=>{
        if(profile.sourceSystem!=='tradefoto.master-data'||!['ARTIKEL_STAMM','ARTIKEL_ZWEITEAN'].includes(profile.sourceTable))C.fail('IMPORT_PROFILE_UNAVAILABLE');
        const P=require('./tradefoto-article-source-profile'),fields=profile.sourceTable==='ARTIKEL_STAMM'?[...P.TRADEFOTO_ARTICLE_ROW_FIELDS,'Änderungsdatum']:P.TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS;
        const rows=await tx.listRows({runId,after,limit:C.LIMITS.batch});await tx.prepareRead?.(runId,rows);
        const values=[];
        for(const row of rows){const data=await decodeRow(tx,run,row),source=data.record?.source||data.invalidSource;values.push(Object.fromEntries(fields.map(field=>[field,source[field]])));}
        return {rows:values,after:rows.at(-1)?.rowNumber??after,complete:(rows.at(-1)?.rowNumber??after)>=run.receivedCount};
      });
    },
    // Aggregate only; no source/person data leaves this internal operation.
    async contentDate(runId, {after = 0, uploadedAt} = {}) {
      C.integer(after,0,C.LIMITS.rows); C.utc(uploadedAt);
      const dates=require('./data-import-content-date');
      return inRun(runId,'read',async(tx,_executor,run,profile)=>{
        const rows=await tx.listRows({runId,after,limit:C.LIMITS.batch});
        await tx.prepareRead?.(runId,rows);
        const result=dates.empty();
        for(const row of rows) {
          const decoded=await decodeRow(tx,run,row);
          dates.accumulate(result,profile,[decoded.record?.source || decoded.invalidSource],uploadedAt);
        }
        return {...result,after:rows.at(-1)?.rowNumber??after,complete:(rows.at(-1)?.rowNumber??after)>=run.receivedCount};
      });
    },
    async preview(runId, { after = 0, limit = 50 } = {}) {
      C.integer(after); C.integer(limit, 1, 100);
      return inRun(runId, "read", async (tx, _executor, run) => ({ ...await summary(tx, run),
        rows: (await tx.listRows({ runId, after, limit })).map(row => ({ rowNumber: row.rowNumber, state: row.state, issue: row.issue })) }));
    },
    async detail(runId, rowNumber) {
      C.integer(rowNumber, 1);
      return inRun(runId, "read_sensitive", async (tx, _executor, run) => {
        live(run); state(run, ["staging", "reviewing", "needs_review", "ready", "applying", "applied", "reverting", "reverted"]);
        const row = await tx.getRow({ runId, rowNumber }); if (!row) C.fail("IMPORT_ROW_NOT_FOUND", 404);
        const decoded = await decodeRow(tx, run, row);
        return { rowNumber, state: row.state, issue: row.issue, source: decoded.record?.source || decoded.invalidSource, proposed: decoded.record?.data || null };
      });
    },
    async apply(runId, expectedRevision) {
      return inRun(runId, "apply", async (tx, executor, run, profile) => {
        live(run); revision(run, expectedRevision); state(run, ["ready", "applying"]);
        if (gatesFor(run).length) C.fail("IMPORT_DECISION_GATE", 409);
        const counts = Object.fromEntries((await tx.counts({ runId })).map(row => [row.state, row.count]));
        if (run.receivedCount !== run.manifest.expectedRows || Object.values(counts).reduce((sum, count) => sum + count, 0) !== run.receivedCount
          || ["staged", "invalid", "conflict", "reverted"].some(status => counts[status])) C.fail("IMPORT_PREVIEW_INCOMPLETE", 409);
        const writer = writerRegistry.get(profile.entity); if (!writer) C.fail("IMPORT_TARGET_ADAPTER_PENDING", 409);
        const started = performance.now();
        // Bound target-write packets separately: a wide article has many more
        // fields and protected parts than a source row in the staging path.
        const rows = await tx.pendingApply({ runId, limit: tx.insertLinks && writer.createBatch ? Math.min(operationBatchSize,50) : operationBatchSize });
        await tx.prepareRead?.(runId, rows);
        const decoded = [];
        if (tx.prepareRead && writer.prepareRead && rows.length) {
          for (const row of rows) decoded.push(await decodeRow(tx, run, row));
          await writer.prepareRead(executor, decoded.map(value => value.record), writerContext(run,profile));
        }
        const batchCreate = rows.length && tx.insertLinks && writer.createBatch && decoded.length === rows.length && rows.every(row => row.state === 'create');
        if (batchCreate) {
          await applyCreates(tx,executor,run,profile,writer,rows,decoded);
          counts.create -= rows.length; if (!counts.create) delete counts.create;
          counts.applied = (counts.applied || 0) + rows.length;
        }
        let index = 0;
        for (const row of batchCreate ? [] : rows) {
          const plan = decoded[index++] || await decodeRow(tx, run, row);
          if (plan.action !== row.state) C.fail("IMPORT_PLAN_INTEGRITY");
          await checkedCurrentLink(tx, plan, row.identityHash);
          const context = writerContext(run, profile);
          if (!C.equal(await writerReview(executor, writer, plan.record, context), plan.validation ?? null)) C.fail("IMPORT_DEPENDENCIES_CHANGED", 409);
          const before = await checkedCurrentTarget(executor, writer, plan, context);
          let after = before;
          if (row.state === "create") {
            const targetId = crypto.randomUUID();
            after = validateWrite(await writer.create(executor, { id: targetId, data: plan.record.data }, context), targetId, 0, plan.record.data);
          } else if (row.state === "update") {
            const data = { ...before.data, ...plan.patch };
            after = validateWrite(await writer.update(executor, { id: before.id, expectedRevision: before.revision, data }, context), before.id, before.revision, data);
          }
          const linkPayload = protection.seal({ record: plan.record, contentHash: row.contentHash, targetRevision: after.revision }, LINK_CONTEXT(row.identityHash));
          if (plan.beforeLink) await tx.expectOne("updateLink", { id: row.identityHash, revision: plan.beforeLink.revision, targetId: after.id, lastRunId: runId, payload: linkPayload });
          else await tx.expectOne("insertLink", { id: row.identityHash, scopeId: run.scopeId, entity: profile.entity, targetId: after.id, revision: 1, lastRunId: runId, payload: linkPayload });
          const encoded = await encodePayload(tx, run, row, "change", { action: row.state, beforeTarget: before, afterTarget: after, beforeLink: plan.beforeLink });
          await tx.expectOne("insertChange", { runId, rowNumber: row.rowNumber, identityHash: row.identityHash,
            payload: encoded.payload, revertedAt: null });
          await payloadStore.publishRefs(tx, { run, row, kind: "change", refs: encoded.refs });
          await saveRow(tx, run, row, "applied", "", plan);
          counts[row.state]--; if (!counts[row.state]) delete counts[row.state]; counts.applied = (counts.applied || 0) + 1;
          if (performance.now() - started >= operationBudgetMs) break;
        }
        const pending = await tx.pendingApply({ runId, limit: 1 });
        return summary(tx, await changeRun(tx, run, pending.length ? "applying" : "applied", "import.apply"), counts);
      });
    },
    async undo(runId, expectedRevision) {
      return inRun(runId, "undo", async (tx, executor, run, profile) => {
        live(run); revision(run, expectedRevision); state(run, ["applying", "applied", "reverting"]);
        const writer = writerRegistry.get(profile.entity); if (!writer) C.fail("IMPORT_TARGET_ADAPTER_PENDING", 409);
        const started = performance.now();
        for (const change of await tx.pendingUndo({ runId, limit: operationBatchSize })) {
          const { undo, link, current } = await undoCheck(tx, executor, run, profile, change);
          const context = Object.freeze({ ...writerContext(run, profile), restoreRevision: undo.beforeTarget?.revision || null });
          let restored = current;
          if (undo.action === "create") {
            if (await writer.remove(executor, { id: current.id, expectedRevision: current.revision }, context) !== true || await writer.read(executor, current.id, context) !== null) C.fail("IMPORT_WRITER_CONTRACT");
          } else if (undo.action === "update") restored = validateWrite(await writer.restore(executor, { id: current.id, expectedRevision: current.revision, data: undo.beforeTarget.data }, context), current.id, current.revision, undo.beforeTarget.data);
          if (!undo.beforeLink) await tx.expectOne("deleteLink", { id: link.id, revision: link.revision });
          else {
            const previous = protection.open(undo.beforeLink.payload, LINK_CONTEXT(link.id)); previous.targetRevision = restored.revision;
            await tx.expectOne("updateLink", { id: link.id, revision: link.revision, targetId: undo.beforeLink.targetId, lastRunId: undo.beforeLink.lastRunId, payload: protection.seal(previous, LINK_CONTEXT(link.id)) });
          }
          await tx.expectOne("revertChange", { runId, rowNumber: change.rowNumber, revertedAt: now() });
          const row = await tx.getRow({ runId, rowNumber: change.rowNumber });
          await saveRow(tx, run, row, "reverted", "", await decodeRow(tx, run, row));
          if (performance.now() - started >= operationBudgetMs) break;
        }
        const pending = await tx.pendingUndo({ runId, limit: 1 });
        return summary(tx, await changeRun(tx, run, pending.length ? "reverting" : "reverted", "import.undo"));
      });
    },
    async undoPreview(runId, { beforeRow = C.LIMITS.rows + 1, limit = 100 } = {}) {
      C.integer(beforeRow, 1, C.LIMITS.rows + 1); C.integer(limit, 1, 100);
      return inRun(runId, "undo", async (tx, executor, run, profile) => {
        live(run); state(run, ["applying", "applied", "reverting"]);
        const rows = [];
        for (const change of await tx.undoPage({ runId, beforeRow, limit })) {
          let issue = "";
          try { await undoCheck(tx, executor, run, profile, change); }
          catch (error) { if (!(error instanceof C.DataImportError) || !/^IMPORT_[A-Z0-9_]{1,80}$/u.test(error.code)) throw error; issue = error.code; }
          rows.push({ rowNumber: change.rowNumber, canUndo: !issue, issue });
        }
        return { id: runId, revision: run.revision, rows, nextBeforeRow: rows.at(-1)?.rowNumber || null, scope: "this_page_only_rechecked_during_undo" };
      });
    },
    async cancel(runId, expectedRevision) {
      return inRun(runId, "stage", async (tx, _executor, run) => {
        revision(run, expectedRevision); state(run, ["staging", "reviewing", "needs_review", "ready"]);
        return summary(tx, await changeRun(tx, run, "cancelled", "import.cancel"));
      });
    },
    async purge(runId, expectedRevision) {
      return inRun(runId, "purge", async (_tx, _executor, run) => {
        revision(run, expectedRevision);
        // Expiry is not deletion authority. Preserve original rows, changes,
        // shared blocks and their audit/undo evidence for every retained run.
        C.fail("IMPORT_PURGE_DISABLED", 409);
      });
    },
    async events(runId, { after = 0, limit = 50 } = {}) {
      C.integer(after, 0, Number.MAX_SAFE_INTEGER); C.integer(limit, 1, 100);
      return inRun(runId, "read", tx => tx.listEvents({ runId, after, limit }));
    },
  };
  return Object.freeze(Object.fromEntries(Object.entries(engine).map(([name, operation]) => [name,
    (...args) => Promise.resolve().then(() => operation(...args)).catch(sanitizedFailure),
  ])));
}
module.exports = { createDataImportEngine };
