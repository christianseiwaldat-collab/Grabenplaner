"use strict";
const { S } = require("../statements/xoffi-snapshots");
const select = `SELECT r.employee_number AS employeeNumber, i.id AS importId, i.week_start AS weekStart,
  s.snapshot_json AS snapshot FROM xoffi_time_snapshots s
  JOIN xoffi_time_employee_rows r ON r.id=s.employee_row_id
  JOIN xoffi_time_imports i ON i.id=r.import_id`;
const CATALOG = [
  { statement: S.insert, sql: "INSERT INTO xoffi_time_snapshots(employee_row_id,snapshot_json) VALUES($employeeRowId,$snapshotJson)" },
  { statement: S.get, sql: `${select} WHERE i.id=$importId AND r.employee_number=$employeeNumber AND i.status='active'` },
  { statement: S.list, sql: `${select} WHERE i.location_id=$locationId AND i.week_start <= $weekStart
    AND i.status='active' AND ($departmentId=0 OR i.department_id IS NULL OR i.department_id=$departmentId)
    AND NOT EXISTS (SELECT 1 FROM xoffi_time_imports newer JOIN xoffi_time_employee_rows nr ON nr.import_id=newer.id
      JOIN xoffi_time_snapshots ns ON ns.employee_row_id=nr.id
      WHERE nr.employee_number=r.employee_number AND newer.location_id=i.location_id AND newer.status='active'
        AND newer.week_start <= $weekStart AND newer.week_start > i.week_start
        AND ($departmentId=0 OR newer.department_id IS NULL OR newer.department_id=$departmentId))
    ORDER BY r.employee_number, CASE WHEN i.department_id IS NULL THEN 1 ELSE 0 END, i.imported_at DESC` },
];
module.exports = { CATALOG: CATALOG.map((entry) => Object.freeze({ ...entry, returning: false })) };
