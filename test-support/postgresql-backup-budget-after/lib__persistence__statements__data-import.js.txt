"use strict";
const { definePersistenceStatement } = require("../contract");
const nullable = kind => ({ kind, nullable: true });
const RUN = Object.freeze({ id: "text", scopeId: "text", ownerId: "text", attemptId: "text", profileHash: "text", profile: "json", manifest: "json", status: "text", revision: "safe_integer", receivedCount: "safe_integer", createdAt: "utc_timestamp", updatedAt: "utc_timestamp", expiresAt: "utc_timestamp" });
const ROW = Object.freeze({ runId: "text", rowNumber: "safe_integer", identityHash: nullable("text"), contentHash: "text", state: "text", issue: "text", payload: "text" });
const LINK = Object.freeze({ id: "text", scopeId: "text", entity: "text", targetId: "text", revision: "safe_integer", lastRunId: "text", payload: "text" });
const CHANGE = Object.freeze({ runId: "text", rowNumber: "safe_integer", identityHash: "text", payload: "text", revertedAt: nullable("utc_timestamp") });
const EVENT = Object.freeze({ id: "text", runId: "text", revision: "safe_integer", actorId: "text", action: "text", at: "utc_timestamp" });
const PAYLOAD_BLOCK = Object.freeze({ id: "text", scopeId: "text", ownerId: "text", profileHash: "text", sourceSystem: "text",
  sourceInstance: "text", sourceTable: "text", entity: "text", blockType: "text", payload: "text", keyId: "text", nonce: "text", createdAt: "utc_timestamp" });
const PAYLOAD_REF = Object.freeze({ runId: "text", rowNumber: "safe_integer", slot: "text", blockId: "text" });
const PAYLOAD_REF_RESULT = Object.freeze({ slot: "text", blockId: "text" });
const def = (id, operation, parameters, columns = {}) => definePersistenceStatement({ id: `data-import.${id}`, operation, parameters, columns });
const S = Object.freeze({
  ...require('./data-import-recheck').RECHECK,
  getRun: def("runs.get", "queryOne", { id: "text", scopeId: "text", ownerId: "text" }, RUN),
  listRuns: def("runs.list", "queryAll", { scopeId: "text", ownerId: "text", beforeAt: "utc_timestamp", beforeId: "text", limit: "safe_integer" }, RUN),
  insertRun: def("runs.insert", "execute", RUN),
  updateRun: def("runs.update", "execute", { id: "text", revision: "safe_integer", status: "text", receivedCount: "safe_integer", updatedAt: "utc_timestamp" }),
  insertRow: def("rows.insert", "execute", ROW),
  getRow: def("rows.get", "queryOne", { runId: "text", rowNumber: "safe_integer" }, ROW),
  findIdentity: def("rows.find-identity", "queryOne", { runId: "text", identityHash: "text" }, ROW),
  conflictIdentity: def("rows.conflict-identity", "execute", { runId: "text", identityHash: "text" }),
  listRows: def("rows.list", "queryAll", { runId: "text", after: "safe_integer", limit: "safe_integer" }, ROW),
  pendingReview: def("rows.pending-review", "queryAll", { runId: "text", limit: "safe_integer" }, ROW),
  resetReview: def("rows.reset-review", "execute", { runId: "text" }),
  pendingApply: def("rows.pending-apply", "queryAll", { runId: "text", limit: "safe_integer" }, ROW),
  updateRow: def("rows.update", "execute", { runId: "text", rowNumber: "safe_integer", state: "text", issue: "text", payload: "text" }),
  counts: def("rows.counts", "queryAll", { runId: "text" }, { state: "text", count: "safe_integer" }),
  getLink: def("links.get", "queryOne", { id: "text" }, LINK),
  insertLink: def("links.insert", "execute", LINK),
  updateLink: def("links.update", "execute", { id: "text", revision: "safe_integer", targetId: "text", lastRunId: "text", payload: "text" }),
  deleteLink: def("links.delete", "execute", { id: "text", revision: "safe_integer" }),
  insertChange: def("changes.insert", "execute", CHANGE),
  pendingUndo: def("changes.pending-undo", "queryAll", { runId: "text", limit: "safe_integer" }, CHANGE),
  undoPage: def("changes.undo-page", "queryAll", { runId: "text", beforeRow: "safe_integer", limit: "safe_integer" }, CHANGE),
  revertChange: def("changes.revert", "execute", { runId: "text", rowNumber: "safe_integer", revertedAt: "utc_timestamp" }),
  insertEvent: def("events.insert", "execute", EVENT),
  listEvents: def("events.list", "queryAll", { runId: "text", after: "safe_integer", limit: "safe_integer" }, EVENT),
  purgeRows: def("rows.purge-payloads", "execute", { runId: "text" }),
  purgeChanges: def("changes.purge-payloads", "execute", { runId: "text" }),
  getPayloadBlock: def("payload-blocks.get", "queryOne", { id: "text" }, PAYLOAD_BLOCK),
  insertPayloadBlock: def("payload-blocks.insert", "execute", PAYLOAD_BLOCK),
  getRowPayloadRefs: def("row-payload-refs.get", "queryAll", { runId: "text", rowNumber: "safe_integer" }, PAYLOAD_REF_RESULT),
  getChangePayloadRefs: def("change-payload-refs.get", "queryAll", { runId: "text", rowNumber: "safe_integer" }, PAYLOAD_REF_RESULT),
  deleteRowPayloadRefs: def("row-payload-refs.delete", "execute", { runId: "text", rowNumber: "safe_integer" }),
  deleteChangePayloadRefs: def("change-payload-refs.delete", "execute", { runId: "text", rowNumber: "safe_integer" }),
  insertRowPayloadRef: def("row-payload-refs.insert", "execute", PAYLOAD_REF),
  insertChangePayloadRef: def("change-payload-refs.insert", "execute", PAYLOAD_REF),
});
module.exports = { DATA_IMPORT_STATEMENTS: S, DATA_IMPORT_COLUMNS: { RUN, ROW, LINK, CHANGE, EVENT, PAYLOAD_BLOCK, PAYLOAD_REF, PAYLOAD_REF_RESULT } };
