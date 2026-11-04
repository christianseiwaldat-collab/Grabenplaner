"use strict";
const { createHash } = require("node:crypto");
const { PLANNING_SHIFT_PRECONDITION_CATALOG } = require("../../catalogs/application-catalog");
const { compileCoreEntry, sourceContract } = require("./catalog");
const sha = value => createHash("sha256").update(value).digest("hex");
const IDS = Object.freeze(["planning-settings.shift-revision.get", "work-rule-planning.update-shift-if-current"]);
// This new read has its own explicit PostgreSQL projection and binding. The
// historical six-field read and frozen compiler-reference inventory stay intact.
const READ_SQL = `SELECT jsonb_build_object(
  'id', id, 'employee_number', employee_number, 'location_id', location_id,
  'shift_date', shift_date, 'department_id', department_id, 'duty_code', duty_code,
  'start_time', start_time, 'end_time', end_time, 'area', area, 'note', note
) AS "data" FROM shifts WHERE id = ($1::bigint)`;

function compilePlanningShiftPreconditionEntry(entry) {
  if (entry.statement.id === IDS[1]) return compileCoreEntry(entry);
  if (entry.statement.id !== IDS[0]) throw new Error("Planning shift precondition catalog drift");
  const providerEntry = {
    statement: entry.statement, sql: READ_SQL, parameterOrder: ["payload"],
    parameterBindings: [{ parameter: "payload", source: "json-extract", path: ["id"] }], returning: false,
  };
  return { providerEntry, provenance: { statementId: entry.statement.id,
    sourceContract: sourceContract(entry), sqlSha256: sha(READ_SQL) } };
}

const contract = require("../contracts/planning-shift-precondition-catalog-v1.json");
const baseline = require("../contracts/block-4-catalog.json");
const sources = PLANNING_SHIFT_PRECONDITION_CATALOG;
if (contract.version !== 1 || contract.scope !== "planning-shift-precondition-application-extension"
  || contract.baseCatalog !== "block-4-catalog.json" || contract.productActivation !== false
  || contract.baseSchemaPlanSha256 !== baseline.schemaPlanSha256
  || !Array.isArray(contract.entries) || contract.entries.length !== 2 || new Set(contract.entries.map(entry => entry.statementId)).size !== 2
  || contract.entries.some(entry => !IDS.includes(entry.statementId) || entry.added !== true)
  || sources.length !== 2 || new Set(sources.map(entry => entry.statement.id)).size !== 2) {
  throw new Error("Planning shift precondition catalog drift");
}
const CATALOG = Object.freeze(sources.map(entry => {
  const locked = contract.entries.find(item => item.statementId === entry.statement.id);
  const compiled = compilePlanningShiftPreconditionEntry(entry);
  if (!locked || locked.sourceSqlSha256 !== sha(entry.sql)
    || locked.sourceContract !== sourceContract(entry) || locked.sourceContract !== compiled.provenance.sourceContract
    || locked.sqlSha256 !== sha(compiled.providerEntry.sql) || locked.sqlSha256 !== compiled.provenance.sqlSha256
    || locked.parameterBindingsSha256 !== sha(JSON.stringify(compiled.providerEntry.parameterBindings))
    || locked.parameterOrderSha256 !== sha(JSON.stringify(compiled.providerEntry.parameterOrder))) {
    throw new Error("Planning shift precondition catalog drift");
  }
  return Object.freeze(compiled.providerEntry);
}));
module.exports = { CATALOG, compilePlanningShiftPreconditionEntry };
