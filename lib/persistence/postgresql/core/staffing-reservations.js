"use strict";

const {
  STAFFING_RESERVATION_CONFLICT,
} = require("../../catalogs/staff-assignment-request-catalog");

const parameterOrder = Object.freeze([
  "employeeNumber", "locationId", "dateFrom", "dateTo", "retainedFrom", "retainedTo",
]);
const sql = STAFFING_RESERVATION_CONFLICT.sql
  .replace(/\bFROM (staff_assignment_request_revisions|employees)\b/g, "FROM gp.$1")
  .replace(/\$([A-Za-z]+)/g, (_, name) => `$${parameterOrder.indexOf(name) + 1}`);

module.exports = {
  CATALOG: Object.freeze([Object.freeze({ ...STAFFING_RESERVATION_CONFLICT, sql, parameterOrder })]),
};
