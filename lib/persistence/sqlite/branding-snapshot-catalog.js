"use strict";

const {
  BRANDING_SNAPSHOT_STATEMENTS,
} = require("../statements/branding-snapshot");

const SQLITE_BRANDING_SNAPSHOT_CATALOG = Object.freeze([
  Object.freeze({
    statement: BRANDING_SNAPSHOT_STATEMENTS.listSettings,
    sql: "SELECT key, value FROM settings ORDER BY key",
    returning: false,
  }),
  Object.freeze({
    statement: BRANDING_SNAPSHOT_STATEMENTS.listPdfSettings,
    sql: `
      SELECT
        scope_type AS scopeType,
        location_id AS locationId,
        department_key AS departmentKey,
        key,
        value
      FROM pdf_settings
      ORDER BY scope_type, location_id, department_key, key
    `,
    returning: false,
  }),
  Object.freeze({
    statement: BRANDING_SNAPSHOT_STATEMENTS.listLocationBranding,
    sql: `
      SELECT
        location_id AS locationId,
        kit_id AS kitId,
        company_name AS companyName,
        logo_url AS logoUrl,
        icon_url AS iconUrl,
        logo_alt AS logoAlt,
        admin_email AS adminEmail,
        updated_by AS updatedBy
      FROM location_branding
      ORDER BY location_id
    `,
    returning: false,
  }),
]);

module.exports = {
  SQLITE_BRANDING_SNAPSHOT_CATALOG,
};
