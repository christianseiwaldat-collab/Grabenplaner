"use strict";
const { TABLE_SQL, TRIGGERS } = require("../../schema-definitions/xoffi-snapshots");

function ensureSchema(database) {
  database.exec(TABLE_SQL);
  for (const item of TRIGGERS) database.exec(item.sql);
}
module.exports = { TABLE_SQL, TRIGGERS, ensureSchema };
