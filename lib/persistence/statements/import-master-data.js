"use strict";
const { definePersistenceStatement } = require("../contract");
const nullable = kind => ({ kind, nullable: true });
const define = (id, operation, parameters, columns) => definePersistenceStatement({ id: "import-master." + id, operation, parameters, ...(columns ? { columns } : {}) });
const one = (id, parameters, columns) => define(id, "queryOne", parameters, columns);
const all = (id, parameters, columns) => define(id, "queryAll", parameters, columns);
const write = (id, parameters) => define(id, "execute", parameters);
const RECORD = { id: "text", scopeId: "text", sourceInstance: "text", sourceTable: "text", profileHash: "text", identityHash: "text",
  revision: "safe_integer", updatedBy: "text", updatedAt: "utc_timestamp" };
const SEGMENT = { recordId: "text", kind: "text", dataClass: "text", payload: "text" };
const RELATION = { recordId: "text", slot: "safe_integer", parentTable: "text", identityHash: nullable("text"), state: "text", evidence: "text" };
const BINDING = { recordId: "text", scopeId: "text", sourceInstance: "text", sourceTable: "text", targetKind: "text", targetId: "text", revision: "safe_integer",
  sourceRevision: "safe_integer", historical: "boolean", payload: "text", lastEventId: "text" };
const EVENT = { id: "text", scopeId: "text", recordId: "text", actorId: "text", action: "text", at: "utc_timestamp", payload: "text", revertedAt: nullable("utc_timestamp") };
const CRM_DATA = { customerNumber: nullable("text"), customerType: "text", companyName: "text", firstName: "text", lastName: "text",
  street: "text", addressSupplement: "text", postalCode: "text", city: "text", country: "text", phone: "text", email: "text", website: "text", vatId: "text", birthDate: nullable("date") };
const CRM = { id: "text", revision: "safe_integer", ...CRM_DATA };
const ID_SCOPE = { id: "text", scopeId: "text" };
const IMPORT_MASTER_STATEMENTS = Object.freeze({
  listMappings: all("mapping.list", { scopeId: "text", sourceInstance: "text", sourceTable: "text", after: "text", status: "text", limit: "safe_integer" }, RECORD),
  employeeTargets: all("mapping.employees", { query: "text", after: "text", limit: "safe_integer" }, { id: "text", label: "text", active: "boolean" }),
  locationTargets: all("mapping.locations", { query: "text", after: "text", limit: "safe_integer" }, { id: "text", label: "text", active: "boolean" }),
  get: one("get", ID_SCOPE, RECORD),
  find: one("find", { identityHash: "text", scopeId: "text" }, RECORD),
  insert: write("insert", RECORD),
  update: write("update", { ...ID_SCOPE, expectedRevision: "safe_integer", profileHash: "text", updatedBy: "text", updatedAt: "utc_timestamp" }),
  remove: write("remove", { ...ID_SCOPE, expectedRevision: "safe_integer" }),
  segments: all("segments", { recordId: "text" }, SEGMENT),
  insertSegment: write("segment.insert", SEGMENT),
  clearSegments: write("segment.clear", { recordId: "text" }),
  relations: all("relations", { recordId: "text", scopeId: "text" }, { ...RELATION, targetId: nullable("text") }),
  insertRelation: write("relation.insert", RELATION),
  clearRelations: write("relation.clear", { recordId: "text" }),
  dependencies: one("dependencies", { id: "text", identityHash: "text" }, { count: "safe_integer" }),
  getBinding: one("binding.get", { recordId: "text" }, BINDING),
  insertBinding: write("binding.insert", BINDING),
  updateBinding: write("binding.update", { recordId: "text", expectedRevision: "safe_integer", sourceRevision: "safe_integer", payload: "text", lastEventId: "text" }),
  removeBinding: write("binding.remove", { recordId: "text", expectedRevision: "safe_integer" }),
  insertEvent: write("event.insert", EVENT),
  getEvent: one("event.get", ID_SCOPE, EVENT),
  revertEvent: write("event.revert", { ...ID_SCOPE, at: "utc_timestamp" }),
  crmGet: one("crm.get", { id: "text" }, CRM),
  crmFind: one("crm.find", { number: "text" }, CRM),
  crmInsert: write("crm.insert", { id: "text", ...CRM_DATA, actor: "text", timestamp: "utc_timestamp" }),
  crmUpdate: write("crm.update", { id: "text", expectedRevision: "safe_integer", ...CRM_DATA, actor: "text", timestamp: "utc_timestamp" }),
  crmRemove: write("crm.remove", { id: "text", expectedRevision: "safe_integer" }),
  crmDependents: one("crm.dependents", { id: "text", recordId: "text" }, { count: "safe_integer" }),
  articleBySource: one("article.by-source", { sourceSystem: "text", sourceArticleKey: "text" }, { id: "text", revision: "safe_integer", articleNumber: "text", active: "boolean" }),
  employee: one("employee.get", { id: "text" }, { id: "text", active: "boolean" }),
  location: one("location.get", { id: "text" }, { id: "text", active: "boolean" }),
  insertHold: write("hold.insert", { recordId: "text", consumerId: "text" }),
  removeHold: write("hold.remove", { recordId: "text", consumerId: "text" }),
  holdCount: one("hold.count", { recordId: "text" }, { count: "safe_integer" }),
});
module.exports = { IMPORT_MASTER_STATEMENTS, IMPORT_MASTER_COLUMNS: { RECORD, SEGMENT, RELATION, BINDING, EVENT, CRM, CRM_DATA } };
