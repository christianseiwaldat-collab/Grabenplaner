"use strict";

const crypto = require("node:crypto");
const C = require("./data-import-contract");
const { assertDataImportRepository } = require("./persistence/repositories/data-import");

const ROW_CONTEXT = (run, number) => ["row", run.scopeId, run.id, number];
const LINK_CONTEXT = hash => ["link", hash];
const CHANGE_CONTEXT = (run, number) => ["change", run.scopeId, run.id, number];
const slot = (object, key) => Object.hasOwn(object, key) ? [true, object[key]] : [false, null];
const requiredWriterMethods = ["read", "findExisting", "create", "update", "restore", "canRestore", "canRemove", "remove"];

// No writers, routes, production schema migration or key provisioning are registered here.
// The composition root must supply trusted profiles, authorization and transaction-bound writers.
function createDataImportEngine({ repository, protection, profiles, writers = {}, getActor, authorize, clock = () => new Date().toISOString() }) {
  assertDataImportRepository(repository);
  if (!protection || ["seal", "open", "digest"].some(name => typeof protection[name] !== "function") || typeof getActor !== "function" || typeof authorize !== "function") C.fail("IMPORT_COMPOSITION_INVALID");
  if (!Array.isArray(profiles) || new Set(profiles.map(profile => C.canonical([profile.sourceSystem, profile.id, profile.version]))).size !== profiles.length) C.fail("IMPORT_PROFILE_REGISTRY_INVALID");
  const registry = new Map(profiles.map(profile => [C.assertProfile(profile).fingerprint, profile]));
  const writerRegistry = new Map(Object.entries(writers));
  for (const [entity, writer] of writerRegistry) {
    C.id(entity);
    if (requiredWriterMethods.some(name => typeof writer[name] !== "function")) C.fail("IMPORT_WRITER_INVALID");
    if (writer.review !== undefined && typeof writer.review !== "function") C.fail("IMPORT_WRITER_INVALID");
  }
  const now = () => C.utc(clock());
  const writerContext = (run, profile) => Object.freeze({ scopeId: run.scopeId, ownerId: run.ownerId,
    sourceInstance: run.manifest.sourceInstance, sourceSystem: profile.sourceSystem,
    fileSha256: run.manifest.fileSha256, snapshotAt: run.manifest.snapshotAt,
    sourceTable: profile.sourceTable, profileHash: profile.fingerprint, runId: run.id, at: now() });
  const identity = (run, profile, record) => protection.digest(["identity", run.scopeId, profile.sourceSystem, run.manifest.sourceInstance, profile.sourceTable, profile.entity, profile.keyFields, record.key]);
  function sanitizedFailure(error) {
    if (error instanceof C.DataImportError && /^IMPORT_[A-Z0-9_]{1,80}$/u.test(error.code)) throw error;
    if (error?.code === "PERSISTENCE_RETRYABLE_TRANSACTION") C.fail("IMPORT_CONCURRENT_CHANGE", 409);
    C.fail("IMPORT_OPERATION_FAILED", 500);
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
  async function summary(tx, run) {
    const counts = Object.fromEntries((await tx.counts({ runId: run.id })).map(row => [row.state, row.count]));
    const profile = knownProfile(run.profileHash);
    const canApply = run.status === "ready" && run.expiresAt > now() && !run.manifest.gates.length && writerRegistry.has(profile.entity)
      && await authorize(Object.freeze({ scopeId: run.scopeId, ownerId: run.ownerId, action: "apply", dataClasses: profile.dataClasses })) === true;
    return { id: run.id, revision: run.revision, status: run.status, expectedRows: run.manifest.expectedRows, receivedRows: run.receivedCount,
      gates: [...run.manifest.gates], counts, expiresAt: run.expiresAt,
      canApply };
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
    }).catch(sanitizedFailure);
  }
  function decodeRow(run, row) {
    const decoded = protection.open(row.payload, ROW_CONTEXT(run, row.rowNumber));
    const original = decoded.record ? { record: decoded.record } : { invalidSource: decoded.invalidSource };
    if (protection.digest(original) !== row.contentHash || (decoded.record && identity(run, knownProfile(run.profileHash), decoded.record) !== row.identityHash)) C.fail("IMPORT_ROW_INTEGRITY");
    return decoded;
  }
  async function saveRow(tx, run, row, stateValue, issue, payload) {
    await tx.expectOne("updateRow", { runId: run.id, rowNumber: row.rowNumber, state: stateValue, issue,
      payload: protection.seal(payload, ROW_CONTEXT(run, row.rowNumber)) });
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
  async function makePlan(tx, executor, run, profile, row) {
    const decoded = decodeRow(run, row), writer = writerRegistry.get(profile.entity);
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
  async function undoCheck(tx, executor, run, profile, change) {
    const undo = protection.open(change.payload, CHANGE_CONTEXT(run, change.rowNumber));
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
    async start({ profileHash, manifest: suppliedManifest, attemptId = "default" }) {
      const who = actor(), profile = knownProfile(C.sha(profileHash)); C.id(attemptId);
      await allowed(who, "read", profile); await allowed(who, "stage", profile);
      const manifest = C.normalizeDataImportManifest(suppliedManifest, profile), at = now();
      const runId = protection.digest(["run", C.VERSION, who, profile.fingerprint, manifest, attemptId]);
      return repository.atomic(async tx => {
        const candidate = { id: runId, ...who, attemptId, profileHash: profile.fingerprint, profile, manifest, status: "staging", revision: 1,
          receivedCount: 0, createdAt: at, updatedAt: at, expiresAt: new Date(Date.parse(at) + 30 * 86400000).toISOString() };
        const inserted = await tx.insertRun(candidate);
        if (inserted.rowsAffected === 1) await tx.expectOne("insertEvent", { id: crypto.randomUUID(), runId, revision: 1, actorId: who.ownerId, action: "import.start", at });
        const run = await tx.getRun({ id: runId, ...who });
        if (!run || !C.equal(run.manifest, manifest) || run.profileHash !== profile.fingerprint) C.fail("IMPORT_RUN_INTEGRITY");
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
          for (const row of prepared) {
            const existing = await tx.getRow({ runId, rowNumber: row.rowNumber });
            if (!existing || existing.contentHash !== row.contentHash || existing.identityHash !== row.identityHash) C.fail("IMPORT_REPLAY_CONFLICT", 409);
          }
          return summary(tx, run); // Lost-response retry, even when its revision is now stale.
        }
        revision(run, expectedRevision); state(run, ["staging"]);
        if (startRow !== run.receivedCount + 1 || startRow + rows.length - 1 > run.manifest.expectedRows) C.fail("IMPORT_BATCH_SEQUENCE", 409);
        for (const row of prepared) {
          let rowState = row.issue ? "invalid" : "staged";
          if (row.identityHash) {
            const previous = await tx.findIdentity({ runId, identityHash: row.identityHash });
            if (previous) {
              if (previous.contentHash === row.contentHash && previous.state !== "conflict") rowState = "duplicate";
              else { rowState = "conflict"; row.issue = "SOURCE_KEY_CONFLICT"; await tx.conflictIdentity({ runId, identityHash: row.identityHash }); }
            }
          }
          await tx.expectOne("insertRow", { runId, rowNumber: row.rowNumber, identityHash: row.identityHash, contentHash: row.contentHash,
            state: rowState, issue: row.issue, payload: protection.seal(row.payload, ROW_CONTEXT(run, row.rowNumber)) });
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
        for (const row of await tx.pendingReview({ runId, limit: C.LIMITS.batch })) {
          const plan = await makePlan(tx, executor, run, profile, row);
          await saveRow(tx, run, row, plan.action, plan.issue, plan);
        }
        const counts = Object.fromEntries((await tx.counts({ runId })).map(row => [row.state, row.count]));
        const status = counts.staged ? "reviewing" : (counts.conflict || counts.invalid || run.manifest.gates.length || !writerRegistry.has(profile.entity)) ? "needs_review" : "ready";
        return summary(tx, await changeRun(tx, run, status, "import.review"));
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
        const decoded = decodeRow(run, row);
        return { rowNumber, state: row.state, issue: row.issue, source: decoded.record?.source || decoded.invalidSource, proposed: decoded.record?.data || null };
      });
    },
    async apply(runId, expectedRevision) {
      return inRun(runId, "apply", async (tx, executor, run, profile) => {
        live(run); revision(run, expectedRevision); state(run, ["ready", "applying"]);
        if (run.manifest.gates.length) C.fail("IMPORT_DECISION_GATE", 409);
        const counts = Object.fromEntries((await tx.counts({ runId })).map(row => [row.state, row.count]));
        if (run.receivedCount !== run.manifest.expectedRows || Object.values(counts).reduce((sum, count) => sum + count, 0) !== run.receivedCount
          || ["staged", "invalid", "conflict", "reverted"].some(status => counts[status])) C.fail("IMPORT_PREVIEW_INCOMPLETE", 409);
        const writer = writerRegistry.get(profile.entity); if (!writer) C.fail("IMPORT_TARGET_ADAPTER_PENDING", 409);
        for (const row of await tx.pendingApply({ runId, limit: C.LIMITS.batch })) {
          const plan = decodeRow(run, row);
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
          await tx.expectOne("insertChange", { runId, rowNumber: row.rowNumber, identityHash: row.identityHash,
            payload: protection.seal({ action: row.state, beforeTarget: before, afterTarget: after, beforeLink: plan.beforeLink }, CHANGE_CONTEXT(run, row.rowNumber)), revertedAt: null });
          await saveRow(tx, run, row, "applied", "", plan);
        }
        const pending = await tx.pendingApply({ runId, limit: 1 });
        return summary(tx, await changeRun(tx, run, pending.length ? "applying" : "applied", "import.apply"));
      });
    },
    async undo(runId, expectedRevision) {
      return inRun(runId, "undo", async (tx, executor, run, profile) => {
        live(run); revision(run, expectedRevision); state(run, ["applying", "applied", "reverting"]);
        const writer = writerRegistry.get(profile.entity); if (!writer) C.fail("IMPORT_TARGET_ADAPTER_PENDING", 409);
        for (const change of await tx.pendingUndo({ runId, limit: C.LIMITS.batch })) {
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
          await saveRow(tx, run, row, "reverted", "", decodeRow(run, row));
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
      return inRun(runId, "purge", async (tx, _executor, run) => {
        revision(run, expectedRevision); state(run, ["cancelled", "reverted", "applied"]);
        if (run.status === "applied" && run.expiresAt > now()) C.fail("IMPORT_UNDO_RETENTION_ACTIVE", 409);
        await tx.purgeRows({ runId }); await tx.purgeChanges({ runId });
        return summary(tx, await changeRun(tx, run, "purged", "import.purge"));
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
