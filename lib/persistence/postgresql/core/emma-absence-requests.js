"use strict";
const { pendingVacationForRange } = require("../../statements/emma-absence-requests");
// Read-only projection over existing native request rows. No schema migration,
// write grant, or change to the frozen historical migration catalog.
module.exports = { CATALOG: Object.freeze([{ statement: pendingVacationForRange, parameterOrder: ["dateFrom", "dateTo"], returning: false,
  sql: `SELECT jsonb_build_object('id',r.id,'employee_number',r.employee_number,'date_from',r.date_from,'date_to',r.date_to,
    'nickname',e.nickname,'color',e.color,'contracted_hours',e.contracted_hours) AS data
    FROM gp.vacation_requests r JOIN gp.employees e ON e.personnel_number=r.employee_number
    WHERE r.status IN ('pending','pending_local','preliminary_local','pending_hr')
      AND r.date_from <= $2 AND r.date_to >= $1 ORDER BY r.date_from,r.id` }]) };
