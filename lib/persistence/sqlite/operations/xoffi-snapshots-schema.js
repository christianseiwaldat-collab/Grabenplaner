"use strict";
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS xoffi_time_snapshots (
  employee_row_id INTEGER PRIMARY KEY REFERENCES xoffi_time_employee_rows(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object')
)`;
const TRIGGERS = ["UPDATE", "DELETE"].map((action) => ({
  name: `trg_xoffi_snapshots_no_${action.toLowerCase()}`,
  sql: `CREATE TRIGGER IF NOT EXISTS trg_xoffi_snapshots_no_${action.toLowerCase()} BEFORE ${action} ON xoffi_time_snapshots
    BEGIN SELECT RAISE(ABORT,'Xoffi source snapshots are immutable'); END`,
}));
function ensureSchema(database) {
  database.exec(TABLE_SQL);
  for (const item of TRIGGERS) database.exec(item.sql);
}
module.exports = { TABLE_SQL, TRIGGERS, ensureSchema };
