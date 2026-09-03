"use strict";

const { definePersistenceStatement } = require("../contract");

const nullable = (kind) => Object.freeze({ kind, nullable: true });

const PUBLIC_RECEIPT_COLUMNS = Object.freeze({
  id: "text",
  actorKind: "text",
  actorId: "text",
  actionType: "text",
  entityType: "text",
  entityId: "text",
  scope: "text",
  summary: "text",
  compensatorKey: nullable("text"),
  sourceAuditId: nullable("safe_integer"),
  undoExpiresAt: nullable("utc_timestamp"),
  compensatesActionId: nullable("text"),
  createdAt: "utc_timestamp",
});

const INTERNAL_RECEIPT_COLUMNS = Object.freeze({
  ...PUBLIC_RECEIPT_COLUMNS,
  undoPayload: nullable("json"),
  resultRevision: nullable("safe_integer"),
  resultFingerprint: nullable("text"),
});

const PERSONAL_ACTION_LOG_STATEMENTS = Object.freeze({
  insert: definePersistenceStatement({
    id: "personal-action-log.receipt.insert",
    operation: "execute",
    parameters: {
      id: "text",
      actorKind: "text",
      actorId: "text",
      actionType: "text",
      entityType: "text",
      entityId: "text",
      scope: "text",
      summary: "text",
      compensatorKey: nullable("text"),
      undoPayload: nullable("json"),
      resultRevision: nullable("safe_integer"),
      resultFingerprint: nullable("text"),
      sourceAuditId: nullable("safe_integer"),
      undoExpiresAt: nullable("utc_timestamp"),
      compensatesActionId: nullable("text"),
      createdAt: "utc_timestamp",
    },
  }),
  listOwn: definePersistenceStatement({
    id: "personal-action-log.receipt.list-own",
    operation: "queryAll",
    parameters: {
      actorId: "text",
      beforeCreatedAt: nullable("utc_timestamp"),
      beforeId: nullable("text"),
      limit: "safe_integer",
    },
    columns: PUBLIC_RECEIPT_COLUMNS,
  }),
  getOwn: definePersistenceStatement({
    id: "personal-action-log.receipt.get-own",
    operation: "queryOne",
    parameters: {
      actorId: "text",
      id: "text",
    },
    columns: INTERNAL_RECEIPT_COLUMNS,
  }),
  findCompensation: definePersistenceStatement({
    id: "personal-action-log.receipt.find-compensation",
    operation: "queryOne",
    parameters: {
      actorId: "text",
      compensatesActionId: "text",
    },
    columns: PUBLIC_RECEIPT_COLUMNS,
  }),
  listLegacyAuditForActor: definePersistenceStatement({
    id: "personal-action-log.legacy-audit.list-own",
    operation: "queryAll",
    parameters: {
      actorId: "text",
      beforeId: nullable("safe_integer"),
      limit: "safe_integer",
    },
    columns: {
      id: "safe_integer",
      action: "text",
      entityType: "text",
      entityId: "text",
      createdAt: "text",
    },
  }),
});

module.exports = {
  INTERNAL_RECEIPT_COLUMNS,
  PERSONAL_ACTION_LOG_STATEMENTS,
  PUBLIC_RECEIPT_COLUMNS,
};
