"use strict";
const { SATURDAY_CREDIT_STATEMENTS: S, SATURDAY_CREDIT_COLUMNS: C } = require('../statements/saturday-credit');
const snake = key => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const select = Object.keys(C).map(k => `${snake(k)} AS "${k}"`).join(', ');
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_SATURDAY_CREDIT_CATALOG = Object.freeze([
  entry(S.get, `SELECT ${select} FROM saturday_credit_records WHERE id=$id`),
  entry(S.insert, `INSERT INTO saturday_credit_records (${Object.keys(C).map(snake).join(', ')}) VALUES (${Object.keys(C).map(k => '$' + k).join(', ')}) ON CONFLICT (id) DO NOTHING`),
  entry(S.history, `SELECT ${select} FROM saturday_credit_records WHERE kind='assignment' AND employee_number=$employeeNumber ORDER BY created_at DESC,id DESC LIMIT 200`),
  entry(S.assignment, `SELECT ${select} FROM saturday_credit_records WHERE kind='assignment' AND employee_number=$employeeNumber AND effective_date<=$effectiveDate ORDER BY effective_date DESC,created_at DESC,id DESC LIMIT 1`),
  entry(S.importedDay, `SELECT i.id AS "importId", i.location_id AS "locationId", COALESCE(i.department_id,0) AS "departmentId",
    d.actual_minutes AS "actualMinutes", d.intervals_json AS "intervals"
    FROM xoffi_time_imports i JOIN xoffi_time_employee_rows r ON r.import_id=i.id JOIN xoffi_time_days d ON d.employee_row_id=r.id
    WHERE i.status='active' AND i.use_as_actual=1 AND r.employee_number=$employeeNumber AND d.work_date=$workDate ORDER BY i.location_id,i.id`),
]);
module.exports = { SQLITE_SATURDAY_CREDIT_CATALOG };
