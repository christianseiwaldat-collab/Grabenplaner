"use strict";

const crypto = require("node:crypto");
const VERSION = 1;
const LIMITS = Object.freeze({ rows: 2_000_000, batch: 200, fields: 256, textBytes: 32_768, rowBytes: 262_144 });
const PROFILES = new WeakSet();
const DEEPLY_FROZEN = new WeakSet(), CANONICAL_CACHE = new WeakMap(), NORMALIZED_CACHE = new WeakMap();
const ROW_PLANS = new WeakMap(), CANONICAL_HEIGHT = new WeakMap();
class DataImportError extends Error {
  constructor(code, status = 422) { super(code); this.name = "DataImportError"; this.code = code; this.status = status; }
}
function fail(code, status) { throw new DataImportError(code, status); }
function plain(value) { return value && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Array.isArray(value); }
function exact(value, keys) {
  exactKeys(value, new Set(keys));
}
function exactKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.has(key) || ["__proto__", "constructor", "prototype"].includes(key))) fail("IMPORT_SHAPE_INVALID");
}
function text(value, max = 120) {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("IMPORT_TEXT_INVALID");
  return value;
}
function id(value) { text(value); if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) fail("IMPORT_ID_INVALID"); return value; }
function integer(value, min = 0, max = LIMITS.rows) { if (!Number.isSafeInteger(value) || value < min || value > max) fail("IMPORT_INTEGER_INVALID"); return value; }
function sha(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("IMPORT_HASH_INVALID"); return value; }
function secretField(value) { return /passw|kennwort|secret|token|api.?key|smtp_pass|connectionstring|^connect$|^pwd$/iu.test(value); }
function canonical(value, depth = 0) {
  // Only our immutable, scalar-normalized rows qualify. The known tree height
  // prevents embedding a cached value from bypassing the overall nesting bound.
  if (value && typeof value === 'object' && DEEPLY_FROZEN.has(value) && depth + CANONICAL_HEIGHT.get(value) <= 12) {
    if (CANONICAL_CACHE.has(value)) return CANONICAL_CACHE.get(value);
    const encoded = canonicalValue(value, depth); CANONICAL_CACHE.set(value, encoded); return encoded;
  }
  return canonicalValue(value, depth);
}
function canonicalValue(value, depth) {
  if (depth > 12) fail("IMPORT_VALUE_TOO_DEEP");
  if (value === null || typeof value === "boolean" || typeof value === "string" || Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
  if (!plain(value)) fail("IMPORT_VALUE_INVALID");
  const keys = Object.keys(value).sort();
  if (keys.some(key => ["__proto__", "prototype", "constructor"].includes(key))) fail("IMPORT_VALUE_INVALID");
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonical(value[key], depth + 1)).join(",") + "}";
}
function fingerprint(value) { return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }
function equal(a, b) { return canonical(a) === canonical(b); }
function utc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("IMPORT_TIMESTAMP_INVALID");
  return value;
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function normalizeValue(value, field) {
  if (value === null && field.nullable) return null;
  switch (field.type) {
    case "text":
      if (typeof value !== "string" || Buffer.byteLength(value) > LIMITS.textBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail("IMPORT_FIELD_INVALID");
      return value;
    case "source_text":
      // Archived source memos may contain legacy control characters or long
      // HTML/plain text. Preserve them inside the protected source, never clean
      // or execute them here. Operational text validation remains unchanged.
      if (typeof value !== "string" || Buffer.byteLength(value) > LIMITS.rowBytes / 2) fail("IMPORT_SOURCE_TEXT_INVALID");
      return value;
    case "identifier": return text(value, 256); // Deliberately no Number coercion or trimming of keys.
    case "guid":
      if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}|\{[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\})$/u.test(value)) fail("IMPORT_GUID_INVALID");
      return value.replace(/[{}]/gu, "").toLowerCase();
    case "integer": return integer(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    case "boolean": if (typeof value !== "boolean") fail("IMPORT_FIELD_INVALID"); return value;
    case "source_decimal": {
      // Lossless reader evidence (including IEEE-754 round-trip digits), NOT a
      // monetary decision. No rounding or fixed-scale padding at this boundary.
      if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,308})(?:\.\d{1,324})?$/u.test(value)) fail("IMPORT_SOURCE_DECIMAL_INVALID");
      const [whole, fraction = ""] = value.split("."), trimmed = fraction.replace(/0+$/u, "");
      const result = whole + (trimmed ? "." + trimmed : ""); return result === "-0" ? "0" : result;
    }
    case "decimal": {
      if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,12})?$/u.test(value)) fail("IMPORT_DECIMAL_INVALID");
      const [whole, fraction = ""] = value.split(".");
      if (fraction.length > field.scale) fail("IMPORT_DECIMAL_PRECISION");
      const result = whole + (field.scale ? "." + fraction.padEnd(field.scale, "0") : "");
      return /^-0(?:\.0+)?$/u.test(result) ? result.slice(1) : result;
    }
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value + "T00:00:00.000Z")) || new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) !== value) fail("IMPORT_DATE_INVALID");
      return value;
    case "time": if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value)) fail("IMPORT_TIME_INVALID"); return value;
    case "civil_datetime":
      // Access business timestamps are local civil values, not UTC instants.
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/u.test(value)) fail("IMPORT_CIVIL_DATETIME_INVALID");
      utc(value + "Z");
      return value;
    default: fail("IMPORT_FIELD_TYPE_INVALID");
  }
}
function defineDataImportProfile(input) {
  exact(input, ["id", "version", "entity", "sourceSystem", "schemaSha256", "sourceTable", "keyFields", "fields", "excludedFields", "dataClasses"]);
  const profile = { id: id(input.id), version: integer(input.version, 1, 100000), entity: id(input.entity), sourceSystem: id(input.sourceSystem),
    schemaSha256: sha(input.schemaSha256), sourceTable: text(input.sourceTable), keyFields: input.keyFields, fields: input.fields, excludedFields: input.excludedFields || [], dataClasses: input.dataClasses };
  if (!Array.isArray(profile.fields) || !profile.fields.length || profile.fields.length > LIMITS.fields) fail("IMPORT_FIELDS_INVALID");
  const sources = new Set(), targets = new Set();
  profile.fields = profile.fields.map(field => {
    exact(field, ["source", "target", "type", "nullable", "scale"]);
    const source = text(field.source), target = field.target === null ? null : id(field.target);
    if ([source, target].some(name => ["__proto__", "constructor", "prototype"].includes(name))) fail("IMPORT_FIELD_INVALID");
    if (secretField(source) || (target && secretField(target))) fail("IMPORT_CREDENTIAL_FIELD_EXCLUDED");
    if (sources.has(source) || (target && targets.has(target))) fail("IMPORT_FIELD_DUPLICATE");
    sources.add(source); if (target) targets.add(target);
    if (!["identifier", "guid", "text", "source_text", "integer", "boolean", "decimal", "source_decimal", "date", "time", "civil_datetime"].includes(field.type) || typeof field.nullable !== "boolean") fail("IMPORT_FIELD_TYPE_INVALID");
    if (field.type !== "decimal" && field.scale !== undefined) fail("IMPORT_FIELD_TYPE_INVALID");
    return { source, target, type: field.type, nullable: field.nullable, ...(field.type === "decimal" ? { scale: integer(field.scale, 0, 12) } : {}) };
  });
  if (!Array.isArray(profile.keyFields) || !profile.keyFields.length || new Set(profile.keyFields).size !== profile.keyFields.length || profile.keyFields.some(key => !sources.has(key))) fail("IMPORT_KEY_INVALID");
  if (!Array.isArray(profile.excludedFields) || profile.excludedFields.length > LIMITS.fields || profile.excludedFields.some(key => typeof key !== "string" || !secretField(key) || sources.has(key))) fail("IMPORT_EXCLUSIONS_INVALID");
  if (!Array.isArray(profile.dataClasses) || !profile.dataClasses.length || profile.dataClasses.length > 20) fail("IMPORT_DATA_CLASS_INVALID");
  profile.dataClasses = [...new Set(profile.dataClasses.map(id))].sort();
  profile.keyFields = [...profile.keyFields]; profile.excludedFields = [...profile.excludedFields].sort();
  profile.fingerprint = fingerprint(profile);
  freeze(profile); PROFILES.add(profile);
  const sourceNames=profile.fields.map(field=>field.source).sort(),targetFields=profile.fields.filter(field=>field.target).sort((a,b)=>a.target<b.target?-1:a.target>b.target?1:0);
  ROW_PLANS.set(profile,{allowed:new Set([...sourceNames,...profile.excludedFields]),source:sourceNames.map(name=>({name,prefix:JSON.stringify(name)+':'})),data:targetFields.map(field=>({name:field.source,prefix:JSON.stringify(field.target)+':'}))});
  return profile;
}
function assertProfile(profile) { if (!PROFILES.has(profile)) fail("IMPORT_PROFILE_UNTRUSTED"); return profile; }
function normalizeDataImportRow(profile, row, immutable = false) {
  assertProfile(profile);
  if(typeof immutable!=='boolean')fail('IMPORT_COMPOSITION_INVALID');
  const cached=row&&typeof row==='object'?NORMALIZED_CACHE.get(row):null;
  if(cached?.profile===profile)return cached.result;
  const plan=ROW_PLANS.get(profile);exactKeys(row, plan.allowed);
  const source = {}, data = {};
  for (const field of profile.fields) {
    if (!Object.hasOwn(row, field.source)) fail("IMPORT_FIELD_MISSING");
    source[field.source] = normalizeValue(row[field.source], field);
    if (field.target) data[field.target] = source[field.source];
  }
  const key = profile.keyFields.map(field => source[field]);
  if (key.some(value => value === null || (typeof value === "string" && !value.trim()))) fail("IMPORT_KEY_MISSING");
  const result = { key, source, data };
  // Profile fields have already validated every scalar. Encode each once and
  // reuse the fixed lexical key order, preserving the original canonical bytes.
  const values=new Map(profile.fields.map(field=>[field.source,JSON.stringify(source[field.source])]));
  const encodeObject=fields=>'{'+fields.map(field=>field.prefix+values.get(field.name)).join(',')+'}';
  const sourceJson=encodeObject(plan.source),dataJson=encodeObject(plan.data),keyJson='['+profile.keyFields.map(name=>values.get(name)).join(',')+']';
  const resultJson='{"data":'+dataJson+',"key":'+keyJson+',"source":'+sourceJson+'}';
  if (Buffer.byteLength(resultJson) > LIMITS.rowBytes) fail("IMPORT_ROW_TOO_LARGE", 413);
  // These objects were constructed above from validated scalar values, without
  // accessors or caller-owned nested references. General freeze() is not a brand.
  if(immutable){freeze(result);for(const [item,encoded,height] of [[result,resultJson,2],[key,keyJson,1],[source,sourceJson,1],[data,dataJson,1]]){DEEPLY_FROZEN.add(item);CANONICAL_CACHE.set(item,encoded);CANONICAL_HEIGHT.set(item,height);}NORMALIZED_CACHE.set(source,{profile,result});}
  return result;
}
function normalizeDataImportManifest(input, profile) {
  assertProfile(profile);
  exact(input, ["sourceInstance", "fileSha256", "schemaSha256", "expectedRows", "declaredRows", "snapshotAt", "gates"]);
  const manifest = { sourceInstance: id(input.sourceInstance), fileSha256: sha(input.fileSha256), schemaSha256: sha(input.schemaSha256),
    expectedRows: integer(input.expectedRows), declaredRows: integer(input.declaredRows), snapshotAt: utc(input.snapshotAt), gates: [] };
  if (!Array.isArray(input.gates) || input.gates.length > 50) fail("IMPORT_GATES_INVALID");
  manifest.gates = [...new Set(input.gates.map(gate => {
    if (typeof gate !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(gate)) fail("IMPORT_GATES_INVALID");
    return gate;
  }))];
  if (manifest.schemaSha256 !== profile.schemaSha256) manifest.gates.push("SOURCE_SCHEMA_MISMATCH");
  if (manifest.expectedRows !== manifest.declaredRows) manifest.gates.push("SOURCE_ROW_COUNT_MISMATCH");
  manifest.gates = [...new Set(manifest.gates)].sort();
  return freeze(manifest);
}
module.exports = { VERSION, LIMITS, DataImportError, fail, plain, exact, text, id, integer, sha, utc, canonical, fingerprint, equal, secretField, freeze,
  defineDataImportProfile, assertProfile, normalizeDataImportRow, normalizeDataImportManifest };
