"use strict";

const crypto = require("node:crypto");
const { cleanCellText, headerFingerprint } = require("./tabular-data");
const { CONTRACT_IDS } = require("./integration-contracts");

const PERSONNEL_IMPORT_FIELDS = Object.freeze([
  { id: "personnelNumber", label: "Personalnummer", required: true, group: "Identifikation" },
  { id: "fullName", label: "Vollst\u00e4ndiger Name", required: true, group: "Identifikation" },
  { id: "nickname", label: "Anzeigename im Dienstplan", group: "Identifikation" },
  { id: "contractedHours", label: "Wochen-Sollzeit", group: "Besch\u00e4ftigung" },
  { id: "positionId", label: "Positions-ID", group: "Besch\u00e4ftigung" },
  { id: "positionName", label: "Position (Name)", group: "Besch\u00e4ftigung" },
  { id: "homeLocationId", label: "Standort-ID", group: "Zuordnung" },
  { id: "homeLocationName", label: "Standort (Name)", group: "Zuordnung" },
  { id: "costCenterId", label: "Kostenstellen-ID", group: "Zuordnung" },
  { id: "preferredDepartmentId", label: "Abteilungs-ID", group: "Zuordnung" },
  { id: "preferredDepartmentName", label: "Abteilung (Name)", group: "Zuordnung" },
  { id: "color", label: "Dienstplanfarbe", group: "Darstellung" },
  { id: "preferredDayOff", label: "Bevorzugter freier Tag", group: "Arbeitsregeln" },
  { id: "fixedWorkdays", label: "Fixe Arbeitstage", group: "Arbeitsregeln" },
  { id: "active", label: "Aktiv", group: "Status" },
]);

const fieldIds = new Set(PERSONNEL_IMPORT_FIELDS.map((field) => field.id));
const headerAliases = Object.freeze({
  personnelNumber: ["personalnummer", "personalnr", "persnr", "mitarbeiternummer", "employeeid", "employeenumber", "id"],
  fullName: ["vollstaendigername", "vollstandigername", "name", "mitarbeiter", "employee", "fullname"],
  nickname: ["spitzname", "anzeigename", "dienstplanname", "vorname", "nickname", "firstname"],
  contractedHours: ["sollzeit", "wochenstunden", "vertragsstunden", "stunden", "contractedhours", "weeklyhours"],
  positionId: ["positionsid", "positionid", "rolleid"],
  positionName: ["position", "funktion", "jobtitle"],
  homeLocationId: ["standortid", "filialnummer", "filialnr", "locationid", "branchid"],
  homeLocationName: ["standort", "filiale", "location", "branch"],
  costCenterId: ["kostenstellenid", "kostenstelleid", "costcenterid"],
  preferredDepartmentId: ["abteilungsid", "departmentid"],
  preferredDepartmentName: ["abteilung", "bereich", "department"],
  color: ["farbe", "dienstplanfarbe", "color", "colour"],
  preferredDayOff: ["freiertag", "wunschfreiertag", "preferreddayoff"],
  fixedWorkdays: ["fixearbeitstage", "arbeitstage", "fixedworkdays"],
  active: ["aktiv", "status", "active"],
});

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function suggestPersonnelMapping(headerCells) {
  const normalized = (headerCells || []).map((cell) => normalizeHeader(cell?.text ?? cell));
  const mapping = {};
  for (const [field, aliases] of Object.entries(headerAliases)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index >= 0) mapping[field] = { columnIndex: index };
  }
  return mapping;
}

function normalizeMapping(mapping, columnCount) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("IMPORT_MAPPING_INVALID");
  const normalized = {};
  const usedColumns = new Set();
  for (const [field, source] of Object.entries(mapping)) {
    if (!fieldIds.has(field) || !source || typeof source !== "object") throw new Error("IMPORT_MAPPING_INVALID");
    const columnIndex = Number(source.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount || usedColumns.has(columnIndex)) {
      throw new Error("IMPORT_MAPPING_INVALID");
    }
    usedColumns.add(columnIndex);
    normalized[field] = { columnIndex };
  }
  if (!normalized.personnelNumber || !normalized.fullName) throw new Error("IMPORT_MAPPING_REQUIRED_FIELDS");
  return normalized;
}

function normalizeProfileConfiguration(value = {}) {
  const format = ["csv", "xlsx"].includes(String(value.format || "")) ? String(value.format) : "csv";
  const headerRow = Number(value.headerRow || 1);
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 20) throw new Error("IMPORT_HEADER_ROW_INVALID");
  const sourceType = value.sourceType === "sql" ? "sql" : "file";
  const connectionId = sourceType === "sql" ? String(value.connectionId || "").trim() : "";
  if (sourceType === "sql" && !/^[A-Za-z0-9._:-]{1,120}$/.test(connectionId)) {
    throw new Error("IMPORT_PROFILE_SQL_CONNECTION_REQUIRED");
  }
  return {
    version: 2,
    sourceType,
    connectionId,
    contractId: sourceType === "sql" ? CONTRACT_IDS.personnelSqlView : "",
    format,
    sheetName: cleanCellText(value.sheetName || "").slice(0, 80),
    headerRow,
    encoding: ["auto", "utf8", "windows1252"].includes(value.encoding) ? value.encoding : "auto",
    delimiter: ["auto", ";", ",", "tab"].includes(value.delimiter) ? value.delimiter : "auto",
    mapping: value.mapping && typeof value.mapping === "object" ? value.mapping : {},
    defaults: value.defaults && typeof value.defaults === "object" ? {
      contractedHours: value.defaults.contractedHours ?? 38.5,
      color: value.defaults.color || "",
      positionId: value.defaults.positionId || "verkaufsmitarbeiter",
      homeLocationId: value.defaults.homeLocationId || "",
      costCenterId: value.defaults.costCenterId || "",
      preferredDepartmentId: value.defaults.preferredDepartmentId || "",
      active: value.defaults.active !== false,
    } : { contractedHours: 38.5, color: "", positionId: "verkaufsmitarbeiter", homeLocationId: "", costCenterId: "", preferredDepartmentId: "", active: true },
    headerFingerprint: /^[a-f0-9]{64}$/.test(String(value.headerFingerprint || "")) ? value.headerFingerprint : "",
    duplicateStrategy: ["skip", "update"].includes(value.duplicateStrategy) ? value.duplicateStrategy : "skip",
  };
}

function normalizeBoolean(value, fallback = true) {
  const normalized = normalizeHeader(value);
  if (["1", "ja", "yes", "true", "aktiv", "active"].includes(normalized)) return true;
  if (["0", "nein", "no", "false", "inaktiv", "inactive"].includes(normalized)) return false;
  return fallback;
}

function normalizeHours(value) {
  if (typeof value === "number") return value;
  const normalized = String(value || "").trim().replace(/\s*h(?:ours?)?$/i, "").replace(",", ".");
  return normalized === "" ? null : Number(normalized);
}

const dayAliases = Object.freeze({
  montag: "monday", mo: "monday", monday: "monday",
  dienstag: "tuesday", di: "tuesday", tuesday: "tuesday",
  mittwoch: "wednesday", mi: "wednesday", wednesday: "wednesday",
  donnerstag: "thursday", do: "thursday", thursday: "thursday",
  freitag: "friday", fr: "friday", friday: "friday",
  samstag: "saturday", sa: "saturday", saturday: "saturday",
});

function normalizeDay(value, allowSaturday = false) {
  const result = dayAliases[normalizeHeader(value)] || "";
  return result === "saturday" && !allowSaturday ? "" : result;
}

function normalizeFixedWorkdays(value) {
  return [...new Set(String(value || "").split(/[;,|/\s]+/).map((entry) => normalizeDay(entry, true)).filter(Boolean))];
}

function deterministicColor(personnelNumber) {
  const palette = ["#146c5a", "#2855a6", "#8e3c75", "#b0542c", "#5c4b9f", "#087f8c", "#8a6a00", "#a23b3b"];
  const byte = crypto.createHash("sha256").update(String(personnelNumber || "")).digest()[0];
  return palette[byte % palette.length];
}

function nicknameFromFullName(fullName) {
  return cleanCellText(fullName).split(/\s+/).filter(Boolean)[0] || "";
}

function mappedPersonnelRow(row, mapping, defaults = {}) {
  const values = {};
  const sourceMeta = {};
  for (const [field, source] of Object.entries(mapping)) {
    const cell = row[source.columnIndex] || { text: "", formula: false, error: false };
    values[field] = cleanCellText(cell.text);
    sourceMeta[field] = { formula: Boolean(cell.formula), error: Boolean(cell.error) };
  }
  const personnelNumber = cleanCellText(values.personnelNumber);
  const fullName = cleanCellText(values.fullName);
  return {
    personnelNumber,
    fullName,
    nickname: cleanCellText(values.nickname) || nicknameFromFullName(fullName),
    contractedHours: normalizeHours(values.contractedHours ?? defaults.contractedHours ?? 38.5),
    positionId: cleanCellText(values.positionId || (values.positionName ? "" : (defaults.positionId || "verkaufsmitarbeiter"))),
    positionName: cleanCellText(values.positionName),
    homeLocationId: cleanCellText(values.homeLocationId || (!values.homeLocationName ? defaults.homeLocationId : "")),
    homeLocationName: cleanCellText(values.homeLocationName),
    costCenterId: cleanCellText(values.costCenterId || defaults.costCenterId),
    preferredDepartmentId: cleanCellText(values.preferredDepartmentId || (!values.preferredDepartmentName ? defaults.preferredDepartmentId : "")),
    preferredDepartmentName: cleanCellText(values.preferredDepartmentName),
    color: /^#[0-9a-f]{6}$/i.test(values.color || defaults.color || "") ? String(values.color || defaults.color).toLowerCase() : deterministicColor(personnelNumber),
    preferredDayOff: normalizeDay(values.preferredDayOff, false),
    fixedWorkdays: normalizeFixedWorkdays(values.fixedWorkdays),
    active: normalizeBoolean(values.active, defaults.active !== false),
    sourceMeta,
    derivedNickname: !cleanCellText(values.nickname),
  };
}

function publicPersonnelImportFields() {
  return PERSONNEL_IMPORT_FIELDS.map((field) => ({ ...field }));
}

module.exports = {
  PERSONNEL_IMPORT_FIELDS,
  publicPersonnelImportFields,
  normalizeHeader,
  suggestPersonnelMapping,
  normalizeMapping,
  normalizeProfileConfiguration,
  mappedPersonnelRow,
  headerFingerprint,
};
