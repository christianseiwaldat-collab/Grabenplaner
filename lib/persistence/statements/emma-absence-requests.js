"use strict";
const { definePersistenceStatement } = require("../contract");
module.exports = Object.freeze({
  pendingVacationForRange: definePersistenceStatement({ id: "emma-absence-requests.pending-vacation-for-range", operation: "queryAll",
    parameters: { dateFrom: "text", dateTo: "text" }, columns: { data: "json" } }),
});
