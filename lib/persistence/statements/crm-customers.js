"use strict";

const { definePersistenceStatement } = require("../contract");

const nullable = (kind) => Object.freeze({ kind, nullable: true });

function queryOne(id, parameters, columns) {
  return definePersistenceStatement({
    id: `crm-customers.${id}`,
    operation: "queryOne",
    parameters,
    columns,
  });
}

function queryAll(id, parameters, columns) {
  return definePersistenceStatement({
    id: `crm-customers.${id}`,
    operation: "queryAll",
    parameters,
    columns,
  });
}

function execute(id, parameters) {
  return definePersistenceStatement({
    id: `crm-customers.${id}`,
    operation: "execute",
    parameters,
  });
}

const CUSTOMER_COLUMNS = Object.freeze({
  id: "text",
  customerNumber: nullable("text"),
  customerType: "text",
  companyName: "text",
  firstName: "text",
  lastName: "text",
  street: "text",
  addressSupplement: "text",
  postalCode: "text",
  city: "text",
  country: "text",
  phone: "text",
  email: "text",
  website: "text",
  vatId: "text",
  birthDate: nullable("date"),
  revision: "safe_integer",
  photoAvailable: "boolean",
  photoUpdatedAt: nullable("utc_timestamp"),
  customFields: "json",
});

const CUSTOMER_SEARCH_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(CUSTOMER_COLUMNS).filter(([key]) => key !== "customFields"),
));

const CUSTOMER_WRITE_PARAMETERS = Object.freeze({
  customerNumber: nullable("text"),
  customerType: "text",
  companyName: "text",
  firstName: "text",
  lastName: "text",
  street: "text",
  addressSupplement: "text",
  postalCode: "text",
  city: "text",
  country: "text",
  phone: "text",
  email: "text",
  website: "text",
  vatId: "text",
  birthDate: nullable("date"),
  actor: "text",
  timestamp: "utc_timestamp",
});

const CRM_CUSTOMER_STATEMENTS = Object.freeze({
  search: queryAll("search", {
    likeQuery: "text",
    customerType: nullable("text"),
    sort: "text",
    direction: "text",
    limit: "safe_integer",
    offset: "safe_integer",
  }, CUSTOMER_SEARCH_COLUMNS),
  countSearch: queryOne("search.count", {
    likeQuery: "text",
    customerType: nullable("text"),
  }, { total: "safe_integer" }),
  get: queryOne("get", { id: "text" }, CUSTOMER_COLUMNS),
  insert: execute("insert", {
    id: "text",
    ...CUSTOMER_WRITE_PARAMETERS,
  }),
  update: execute("update", {
    id: "text",
    expectedRevision: "safe_integer",
    ...CUSTOMER_WRITE_PARAMETERS,
  }),
  deleteCustomFields: execute("custom-fields.delete", { customerId: "text" }),
  insertCustomField: execute("custom-fields.insert", {
    id: "text",
    customerId: "text",
    title: "text",
    value: "text",
    sortOrder: "safe_integer",
    revision: "safe_integer",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  getPhoto: queryOne("photo.get", { customerId: "text" }, {
    customerId: "text",
    storageKey: "text",
    contentSha256: "text",
    byteSize: "safe_integer",
    mediaType: "text",
    originalFilename: "text",
    revision: "safe_integer",
    updatedBy: "text",
    updatedAt: "utc_timestamp",
  }),
  upsertPhoto: execute("photo.upsert", {
    customerId: "text",
    storageKey: "text",
    contentSha256: "text",
    byteSize: "safe_integer",
    mediaType: "text",
    originalFilename: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  deletePhoto: execute("photo.delete", { customerId: "text" }),
  insertAudit: execute("audit.insert", {
    actor: "text",
    action: "text",
    entityType: "text",
    entityId: "text",
    detail: "text",
    timestamp: "utc_timestamp",
  }),
});

module.exports = {
  CRM_CUSTOMER_STATEMENTS,
};
