"use strict";

const { definePersistenceStatement } = require("../contract");

const REQUEST_COLUMNS = Object.freeze({
  id: "text",
  createdByEmployeeNumber: "text",
  createdAt: "text",
  receiptSha256: "text",
});

const REVISION_COLUMNS = Object.freeze({
  requestId: "text",
  revisionNumber: "safe_integer",
  status: "text",
  sourceLocationId: "text",
  destinationLocationId: "text",
  destinationDepartmentId: "safe_integer",
  periodStartDate: "date",
  periodEndDate: "date",
  timeKind: "text",
  startTime: { kind: "text", nullable: true },
  endTime: { kind: "text", nullable: true },
  preferredEmployeeNumber: { kind: "text", nullable: true },
  confirmedEmployeeNumber: { kind: "text", nullable: true },
  requestReason: "text",
  decisionReason: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  changedByEmployeeNumber: "text",
  changedAt: "text",
});

const EVENT_COLUMNS = Object.freeze({
  id: "text",
  requestId: "text",
  sequenceNumber: "safe_integer",
  requestRevisionNumber: "safe_integer",
  eventType: "text",
  fromStatus: { kind: "text", nullable: true },
  toStatus: "text",
  eventPayload: "json",
  eventPayloadSha256: "text",
  previousReceiptSha256: "text",
  receiptSha256: "text",
  actorEmployeeNumber: "text",
  occurredAt: "text",
});

const BOUND_ASSIGNMENT_PARAMETERS = Object.freeze({
  id: "text",
  employeeNumber: "text",
  homeLocationId: "text",
  destinationLocationId: "text",
  destinationDepartmentId: "safe_integer",
  dateFrom: "date",
  dateTo: "date",
  allDay: "boolean",
  startTime: { kind: "time", nullable: true },
  endTime: { kind: "time", nullable: true },
  note: "text",
  actor: "text",
  timestamp: "utc_timestamp",
});

const STAFF_ASSIGNMENT_REQUEST_STATEMENTS = Object.freeze({
  listRequests: definePersistenceStatement({
    id: "staff-assignment-requests.request.list",
    operation: "queryAll",
    columns: REQUEST_COLUMNS,
  }),
  getRequest: definePersistenceStatement({
    id: "staff-assignment-requests.request.get",
    operation: "queryOne",
    parameters: { requestId: "text" },
    columns: REQUEST_COLUMNS,
  }),
  insertRequest: definePersistenceStatement({
    id: "staff-assignment-requests.request.insert",
    operation: "execute",
    parameters: REQUEST_COLUMNS,
  }),
  listRevisions: definePersistenceStatement({
    id: "staff-assignment-requests.revision.list",
    operation: "queryAll",
    parameters: { requestId: "text" },
    columns: REVISION_COLUMNS,
  }),
  getLatestRevision: definePersistenceStatement({
    id: "staff-assignment-requests.revision.get-latest",
    operation: "queryOne",
    parameters: { requestId: "text" },
    columns: REVISION_COLUMNS,
  }),
  insertRevision: definePersistenceStatement({
    id: "staff-assignment-requests.revision.insert",
    operation: "execute",
    parameters: REVISION_COLUMNS,
  }),
  listEvents: definePersistenceStatement({
    id: "staff-assignment-requests.event.list",
    operation: "queryAll",
    parameters: { requestId: "text" },
    columns: EVENT_COLUMNS,
  }),
  getLatestEvent: definePersistenceStatement({
    id: "staff-assignment-requests.event.get-latest",
    operation: "queryOne",
    parameters: { requestId: "text" },
    columns: EVENT_COLUMNS,
  }),
  insertEvent: definePersistenceStatement({
    id: "staff-assignment-requests.event.insert",
    operation: "execute",
    parameters: EVENT_COLUMNS,
  }),
  insertBoundAssignment: definePersistenceStatement({
    id: "staff-assignment-requests.fulfillment.insert-bound-assignment",
    operation: "execute",
    parameters: BOUND_ASSIGNMENT_PARAMETERS,
  }),
});

module.exports = {
  STAFF_ASSIGNMENT_REQUEST_STATEMENTS,
};
