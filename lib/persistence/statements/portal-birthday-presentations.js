"use strict";

const { definePersistenceStatement } = require("../contract");

const POLICY_COLUMNS = Object.freeze({
  enabled: "boolean",
  revision: "safe_integer",
  updatedAt: "utc_timestamp",
});

const ASSIGNMENT_COLUMNS = Object.freeze({
  employeeNumber: "text",
  presentationId: "text",
  revision: "safe_integer",
  createdAt: "utc_timestamp",
  updatedAt: "utc_timestamp",
});

const CLAIM_COLUMNS = Object.freeze({
  employeeNumber: "text",
  eventYear: "safe_integer",
  presentationId: "text",
  policyRevision: "safe_integer",
  assignmentRevision: "safe_integer",
  receiptSha256: "text",
  revision: "safe_integer",
});

const CLAIM_EXPORT_COLUMNS = Object.freeze({
  eventYear: "safe_integer",
  presentationId: "text",
});

const PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS = Object.freeze({
  getPolicy: definePersistenceStatement({
    id: "portal-birthday-presentations.policy.get",
    operation: "queryOne",
    columns: POLICY_COLUMNS,
  }),
  updatePolicy: definePersistenceStatement({
    id: "portal-birthday-presentations.policy.update",
    operation: "execute",
    parameters: Object.freeze({
      enabled: "boolean",
      expectedRevision: "safe_integer",
      updatedAt: "utc_timestamp",
    }),
    columns: POLICY_COLUMNS,
  }),
  listAssignments: definePersistenceStatement({
    id: "portal-birthday-presentations.assignment.list",
    operation: "queryAll",
    columns: ASSIGNMENT_COLUMNS,
  }),
  getAssignment: definePersistenceStatement({
    id: "portal-birthday-presentations.assignment.get",
    operation: "queryOne",
    parameters: Object.freeze({ employeeNumber: "text" }),
    columns: ASSIGNMENT_COLUMNS,
  }),
  insertAssignment: definePersistenceStatement({
    id: "portal-birthday-presentations.assignment.insert",
    operation: "execute",
    parameters: Object.freeze({
      employeeNumber: "text",
      presentationId: "text",
      updatedAt: "utc_timestamp",
    }),
    columns: ASSIGNMENT_COLUMNS,
  }),
  updateAssignment: definePersistenceStatement({
    id: "portal-birthday-presentations.assignment.update",
    operation: "execute",
    parameters: Object.freeze({
      employeeNumber: "text",
      presentationId: "text",
      expectedRevision: "safe_integer",
      updatedAt: "utc_timestamp",
    }),
    columns: ASSIGNMENT_COLUMNS,
  }),
  claimEvent: definePersistenceStatement({
    id: "portal-birthday-presentations.claim.create",
    operation: "execute",
    parameters: Object.freeze({
      employeeNumber: "text",
      eventYear: "safe_integer",
      presentationId: "text",
      policyRevision: "safe_integer",
      assignmentRevision: "safe_integer",
      receiptSha256: "text",
    }),
    columns: CLAIM_COLUMNS,
  }),
  listClaimsForEmployee: definePersistenceStatement({
    id: "portal-birthday-presentations.claim.list-for-employee",
    operation: "queryAll",
    parameters: Object.freeze({ employeeNumber: "text" }),
    columns: CLAIM_EXPORT_COLUMNS,
  }),
});

module.exports = {
  PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS,
};
