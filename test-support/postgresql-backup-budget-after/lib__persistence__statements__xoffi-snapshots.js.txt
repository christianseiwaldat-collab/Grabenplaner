"use strict";
const { definePersistenceStatement: define } = require("../contract");
const columns = { employeeNumber: "text", importId: "text", weekStart: "text", snapshot: "json" };
const S = {
  insert: define({ id: "xoffi-snapshots.insert", operation: "execute", parameters: { employeeRowId: "safe_integer", snapshotJson: "text" } }),
  get: define({ id: "xoffi-snapshots.get", operation: "queryOne", parameters: { importId: "text", employeeNumber: "text" }, columns }),
  list: define({ id: "xoffi-snapshots.list", operation: "queryAll", parameters: { locationId: "text", departmentId: "safe_integer", weekStart: "text" }, columns }),
};
module.exports = { S };
