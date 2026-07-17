"use strict";

const crypto = require("node:crypto");

const CONTRACT_IDS = Object.freeze({
  personnelSqlView: "grabenplaner.personnel-view.v1",
  payrollHttpsJson: "grabenplaner.payroll.v1",
});

const personnelFields = Object.freeze([
  ["personnelNumber", "Personalnummer", true],
  ["fullName", "Vollständiger Name", true],
  ["nickname", "Anzeigename im Dienstplan", false],
  ["contractedHours", "Wochen-Sollzeit", false],
  ["positionId", "Positions-ID", false],
  ["positionName", "Position (Name)", false],
  ["homeLocationId", "Standort-ID", false],
  ["homeLocationName", "Standort (Name)", false],
  ["preferredDepartmentId", "Abteilungs-ID", false],
  ["preferredDepartmentName", "Abteilung (Name)", false],
  ["color", "Dienstplanfarbe", false],
  ["preferredDayOff", "Bevorzugter freier Tag", false],
  ["fixedWorkdays", "Fixe Arbeitstage", false],
  ["active", "Aktiv", false],
]);

const contracts = Object.freeze({
  [CONTRACT_IDS.personnelSqlView]: Object.freeze({
    id: CONTRACT_IDS.personnelSqlView,
    version: "1.0.0",
    title: "Personalstammdaten aus freigegebener SQL-View",
    purpose: "personnel",
    direction: "inbound",
    transport: "mssql_view",
    operation: "read_only",
    description: "Manuell ausgelöste, schreibgeschützte Übernahme notwendiger Personalstammdaten mit Vorschau und ausdrücklicher Bestätigung.",
    sourceRequirements: {
      objectType: "view",
      databasePermission: "SELECT",
      arbitraryQueries: false,
      directWrites: false,
      humanConfirmationRequired: true,
    },
    fields: personnelFields.map(([id, label, required]) => ({ id, label, required, type: "text" })),
    excludedData: [
      "Passwörter und Sitzungen",
      "Rollen und Rechte",
      "Bankverbindungen",
      "Sozialversicherungsnummern",
      "Wohnadressen und Telefonnummern",
      "AUM- und Personalakt-Inhalte",
    ],
    limits: { maximumRows: 5000, maximumColumns: 100, maximumSnapshotBytes: 5 * 1024 * 1024 },
  }),
  [CONTRACT_IDS.payrollHttpsJson]: Object.freeze({
    id: CONTRACT_IDS.payrollHttpsJson,
    version: "1.0.0",
    title: "Geprüfte Lohnwerte über HTTPS-JSON",
    purpose: "payroll",
    direction: "outbound",
    transport: "https_json",
    operation: "documented_api",
    description: "Idempotente Übergabe final geprüfter und minimierter Lohnwerte an einen dokumentierten HTTPS-Endpunkt.",
    deliveryRequirements: {
      method: "POST",
      tlsMinimum: "1.2",
      idempotencyHeader: "Idempotency-Key",
      redirects: false,
      humanPreflightRequired: true,
      finalReviewedValuesOnly: true,
    },
    jsonSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["schema", "deliveryId", "generatedAt", "source", "columns", "rows", "dataSha256"],
      properties: {
        schema: { const: CONTRACT_IDS.payrollHttpsJson },
        deliveryId: { type: "string", minLength: 1, maxLength: 80 },
        generatedAt: { type: "string", format: "date-time" },
        source: {
          type: "object",
          additionalProperties: false,
          required: ["dateFrom", "dateTo", "locationId", "departmentId", "sourceMode", "layout"],
          properties: {
            dateFrom: { type: "string", format: "date" },
            dateTo: { type: "string", format: "date" },
            locationId: { type: "string", minLength: 1, maxLength: 80 },
            departmentId: { type: ["string", "null"], maxLength: 80 },
            sourceMode: { const: "actual_reviewed" },
            layout: { enum: ["daily_journal", "movement_lines"] },
          },
        },
        columns: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "type"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]{0,59}$" },
              label: { type: "string", minLength: 1, maxLength: 120 },
              type: { enum: ["identifier", "text", "number"] },
            },
          },
        },
        rows: { type: "array", maxItems: 50000, items: { type: "object" } },
        dataSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    },
    excludedData: [
      "Namen",
      "Bankverbindungen",
      "Sozialversicherungsnummern",
      "Wohnadressen und Telefonnummern",
      "AUM- und Personalakt-Inhalte",
    ],
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function contractById(id) {
  const contract = contracts[String(id || "")];
  return contract ? clone(contract) : null;
}

function contractSha256(contract) {
  return crypto.createHash("sha256").update(JSON.stringify(contract), "utf8").digest("hex");
}

function contractSummaries() {
  return Object.values(contracts).map((contract) => ({
    id: contract.id,
    version: contract.version,
    title: contract.title,
    purpose: contract.purpose,
    direction: contract.direction,
    transport: contract.transport,
    operation: contract.operation,
    description: contract.description,
    sha256: contractSha256(contract),
  }));
}

module.exports = {
  CONTRACT_IDS,
  contractById,
  contractSha256,
  contractSummaries,
};
