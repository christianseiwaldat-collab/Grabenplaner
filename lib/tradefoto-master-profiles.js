"use strict";
const C = require("./data-import-contract");
const metadata = C.freeze(require("./tradefoto-master-metadata.json"));
const byName = new Map(metadata.tables.map(table => [table.name, table]));
const columnsByTable = new Map(metadata.tables.map(table => [table.name, new Map(table.columns.map(column => [column.name, column]))]));
const relationsByTable = new Map(metadata.tables.map(table => [table.name, metadata.relations.filter(relation => relation.from === table.name)]));
const profiles = new Map();
const metaFields = [
  { source: "_source_snapshot_sha256", target: "snapshot", type: "identifier", nullable: false },
  { source: "_source_row", target: "ordinal", type: "integer", nullable: false },
];
const relationIdentifiers = new Set(metadata.relations.flatMap(relation => [
  ...relation.fields.map(field => relation.from + "/" + field), ...relation.keys.map(field => relation.to + "/" + field),
]));
function tableFor(name) { const table = byName.get(name); if (!table) C.fail("IMPORT_MASTER_TABLE_UNKNOWN"); return table; }
for (const table of metadata.tables) {
  const fields = table.columns.flatMap((column, index) => {
    if (column.excluded) return [];
    let type;
    if ((table.keys || []).includes(column.name) || relationIdentifiers.has(table.name + "/" + column.name)) type = "identifier";
    else if (column.type === "memo") type = "source_text";
    else if (["text", "guid"].includes(column.type)) type = "text";
    else if (["long", "integer", "byte"].includes(column.type)) type = "integer";
    else if (column.type === "currency") type = "decimal";
    else if (["double", "float"].includes(column.type)) type = "source_decimal";
    else if (column.type === "datetime") type = "civil_datetime";
    else if (column.type === "boolean") type = "boolean";
    else C.fail("IMPORT_MASTER_TYPE_UNREVIEWED");
    return [{ source: column.name, target: "f" + index, type, nullable: true, ...(type === "decimal" ? { scale: 12 } : {}) }];
  });
  const entity = "trade-master." + C.fingerprint(table.name).slice(0, 20);
  profiles.set(table.name, C.defineDataImportProfile({ id: entity, version: 1, entity,
    sourceSystem: metadata.sourceSystem, sourceTable: table.name, schemaSha256: metadata.schemaSha256,
    keyFields: table.keys || metaFields.map(field => field.source), fields: [...fields, ...(table.keys ? [] : metaFields)],
    excludedFields: table.columns.filter(column => column.excluded).map(column => column.name),
    dataClasses: [...new Set(table.columns.filter(column => !column.excluded).map(column => column.dataClass))],
  }));
}
function profileFor(name) { tableFor(name); return profiles.get(name); }
function plainDecimal(value) {
  const string = String(value);
  if (!/[eE]/u.test(string)) return string;
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(string);
  if (!match) return string; // Invalid known values remain in encrypted staging for review.
  const [, sign, whole, fraction = "", exponent] = match;
  const position = whole.length + Number(exponent), digits = whole + fraction;
  if (Math.abs(position) > 400) C.fail("IMPORT_DECIMAL_INVALID");
  return sign + (position <= 0 ? "0." + "0".repeat(-position) + digits
    : position >= digits.length ? digits + "0".repeat(position - digits.length) : digits.slice(0, position) + "." + digits.slice(position));
}
// Reader boundary only: Access Date components are carried verbatim, never shifted
// through the host timezone. Binary artifacts, local paths and URLs are not opened.
function prepareTradeFotoMasterRow(name, raw, { fileSha256, rowNumber } = {}) {
  const table = tableFor(name), profile = profileFor(name);
  C.exact(raw, table.columns.map(column => column.name));
  const row = {};
  for (const field of profile.fields.filter(field => !field.source.startsWith("_source_"))) {
    if (!Object.hasOwn(raw, field.source)) C.fail("IMPORT_FIELD_MISSING");
    let value = raw[field.source];
    if (value !== null) {
      if (field.type === "identifier" && typeof value === "number") {
        if (!Number.isSafeInteger(value)) C.fail("IMPORT_IDENTIFIER_PRECISION");
        value = String(value);
      } else if (["decimal", "source_decimal"].includes(field.type) && typeof value === "number") {
        if (!Number.isFinite(value)) C.fail("IMPORT_DECIMAL_INVALID");
        value = plainDecimal(value); // No implicit monetary rounding.
      } else if (field.type === "civil_datetime" && value instanceof Date) {
        if (!Number.isFinite(value.getTime())) C.fail("IMPORT_CIVIL_DATETIME_INVALID");
        value = value.toISOString().slice(0, -1);
      }
    }
    row[field.source] = value;
  }
  if (!table.keys) { row._source_snapshot_sha256 = C.sha(fileSha256); row._source_row = C.integer(rowNumber, 1); }
  return row; // Credential values are neither copied nor hashed.
}
function masterSource(name, data) {
  const profile = profileFor(name);
  C.exact(data, profile.fields.map(field => field.target));
  return Object.fromEntries(profile.fields.map(field => [field.source, data[field.target]]));
}
function masterKey(name, data) {
  return C.normalizeDataImportRow(profileFor(name), masterSource(name, data)).key;
}
function masterIdentity(protection, { scopeId, sourceInstance }, name, key) {
  C.id(scopeId); C.id(sourceInstance); tableFor(name);
  return protection.digest(["master-source", scopeId, metadata.sourceSystem, sourceInstance, name, key]);
}
function segmentFor(table, column) {
  if (column.dataClass === "restricted_finance") return "financial";
  if (column.dataClass === "catalog_prices") return "prices";
  if (column.dataClass === "catalog_costs") return "costs";
  const field = column.name;
  if (/Bemerk|INFO|Meldungstext|^Text$/iu.test(field)) return "notes";
  if (table.group.includes("addresses") || table.name === "LIEFERANTEN_Adressen") return "addresses";
  if (table.group.includes("conditions") || table.group.includes("pricing")) return "conditions";
  if (table.group.includes("media") || /^(ABild|Bild|Pfad)$/u.test(field)) return "media_references";
  if (/Telefon|Telefax|Handy|EMail|Homepage|LeitwegID/iu.test(field)) return "contacts";
  if (/Punkte|Wincard|Kartenkunde/iu.test(field)) return "loyalty_snapshot";
  if (table.name === "MITARBEITER" && !["Verkäufer_ID", "NACHNAME", "VORNAME", "FilialNr"].includes(field)) return "legacy_personnel";
  return "attributes";
}
function masterSegments(name, data) {
  const table = tableFor(name), groups = new Map();
  for (const field of profileFor(name).fields) {
    const column = columnsByTable.get(name).get(field.source);
    const dataClass = column?.dataClass || "internal_business", kind = column ? segmentFor(table, column) : "provenance";
    const key = kind + ":" + dataClass;
    if (!groups.has(key)) groups.set(key, { kind, dataClass, data: {} });
    groups.get(key).data[field.target] = data[field.target];
  }
  return [...groups.values()];
}
function masterReferences(protection, context, name, data) {
  const source = masterSource(name, data);
  return relationsByTable.get(name).map((relation, index) => {
    const parent = tableFor(relation.to), key = relation.fields.map(field => source[field]);
    const unassigned = key.some(value => value === null || value === "")
      || (["KUNDEN", "MITARBEITER"].includes(parent.name) && key.length === 1 && key[0] === "0");
    const resolvable = !relation.reviewOnly && parent.keys && C.equal(parent.keys, relation.keys);
    return { slot: index, parentTable: parent.name, identityHash: !unassigned && resolvable ? masterIdentity(protection, context, parent.name, key) : null,
      state: unassigned ? "unassigned" : resolvable ? "candidate" : "key_review", evidence: relation.evidence };
  });
}
module.exports = { TRADEFOTO_MASTER_METADATA: metadata, TRADEFOTO_MASTER_PROFILES: Object.freeze([...profiles.values()]),
  tableFor, profileFor, prepareTradeFotoMasterRow, masterSource, masterKey, masterIdentity, masterSegments, masterReferences };
