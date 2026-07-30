"use strict";

const { definePersistenceStatement } = require("../contract");

const BRANDING_SNAPSHOT_STATEMENTS = Object.freeze({
  listSettings: definePersistenceStatement({
    id: "branding-snapshot.list-settings",
    operation: "queryAll",
    columns: {
      key: "text",
      value: "text",
    },
  }),
  listPdfSettings: definePersistenceStatement({
    id: "branding-snapshot.list-pdf-settings",
    operation: "queryAll",
    columns: {
      scopeType: "text",
      locationId: "text",
      departmentKey: "text",
      key: "text",
      value: "text",
    },
  }),
  listLocationBranding: definePersistenceStatement({
    id: "branding-snapshot.list-location-branding",
    operation: "queryAll",
    columns: {
      locationId: "text",
      kitId: "text",
      companyName: "text",
      logoUrl: "text",
      iconUrl: "text",
      logoAlt: "text",
      adminEmail: "text",
      updatedBy: "text",
    },
  }),
});

module.exports = {
  BRANDING_SNAPSHOT_STATEMENTS,
};
