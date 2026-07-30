"use strict";

const { createHash } = require("node:crypto");
const {
  assertPersistenceStatement,
} = require("../contract");

const DIALECT_CONTRACT_VERSION = 2;
const SQL_OWNERSHIP_CLASSIFICATIONS = Object.freeze([
  "sqlite-baseline",
  "dialect-variant",
]);
const PLANNED_DIALECT_STATUS = "contract-only";

const DIALECT_MANIFESTS = new WeakSet();
const DIALECT_ID_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const OWNER_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9.-]{2,95}$/;

function invalidDialectContract(message) {
  return new TypeError(message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw invalidDialectContract(`${label} muss ein einfaches Objekt sein.`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidDialectContract(`${label} enthält unbekannte Felder.`);
  }
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedDialectId(value) {
  if (typeof value !== "string" || !DIALECT_ID_PATTERN.test(value)) {
    throw invalidDialectContract("Die Dialekt-ID ist ungültig.");
  }
  return value;
}

function normalizedStatement(value) {
  try {
    return assertPersistenceStatement(value);
  } catch {
    throw invalidDialectContract("Ein gültiger, unveränderlicher Statementvertrag ist erforderlich.");
  }
}

function normalizedFeatures(value, classification) {
  if (!Array.isArray(value)) {
    throw invalidDialectContract("Dialektmerkmale müssen als Liste angegeben werden.");
  }
  const features = value.map((feature) => {
    if (typeof feature !== "string" || !FEATURE_ID_PATTERN.test(feature)) {
      throw invalidDialectContract("Ein Dialektmerkmal ist ungültig.");
    }
    return feature;
  });
  if (new Set(features).size !== features.length
    || JSON.stringify(features) !== JSON.stringify([...features].sort())) {
    throw invalidDialectContract("Dialektmerkmale müssen eindeutig und sortiert sein.");
  }
  if ((classification === "sqlite-baseline" && features.length !== 0)
    || (classification === "dialect-variant" && features.length === 0)) {
    throw invalidDialectContract("Klassifikation und Dialektmerkmale widersprechen einander.");
  }
  return Object.freeze(features);
}

function fieldContractSnapshot(fields) {
  return Object.fromEntries(
    Object.keys(fields).sort().map((name) => {
      const definition = fields[name];
      return [name, {
        kind: definition.kind,
        nullable: definition.nullable,
        optional: definition.optional,
      }];
    }),
  );
}

function statementContractSnapshot(statement) {
  return {
    id: statement.id,
    operation: statement.operation,
    parameters: fieldContractSnapshot(statement.parameters),
    columns: fieldContractSnapshot(statement.columns),
  };
}

function assertDialectManifest(manifest) {
  if (!DIALECT_MANIFESTS.has(manifest)) {
    throw invalidDialectContract("Ein mit defineDialectManifest erzeugtes Manifest ist erforderlich.");
  }
  return manifest;
}

function defineDialectManifest(options = {}) {
  exactKeys(options, ["dialectId", "executable", "entries"], "Dialektmanifest");
  const dialectId = normalizedDialectId(options.dialectId);
  if (options.executable !== true || !Array.isArray(options.entries) || options.entries.length === 0) {
    throw invalidDialectContract("Ein ausführbares Dialektmanifest benötigt Einträge.");
  }

  const statementIds = new Set();
  const statements = new Set();
  const entries = options.entries.map((entry, index) => {
    exactKeys(
      entry,
      ["statement", "owner", "classification", "features", "sql", "returning"],
      `Dialekteintrag ${index}`,
    );
    const statement = normalizedStatement(entry.statement);
    const owner = entry.owner;
    const expectedOwner = statement.id.split(".")[0];
    if (typeof owner !== "string" || !OWNER_PATTERN.test(owner) || owner !== expectedOwner) {
      throw invalidDialectContract(`Der SQL-Eigentümer von ${statement.id} ist ungültig.`);
    }
    if (!SQL_OWNERSHIP_CLASSIFICATIONS.includes(entry.classification)) {
      throw invalidDialectContract(`Die SQL-Klassifikation von ${statement.id} ist ungültig.`);
    }
    const features = normalizedFeatures(entry.features, entry.classification);
    if (typeof entry.sql !== "string" || !entry.sql.trim() || typeof entry.returning !== "boolean") {
      throw invalidDialectContract(`Die ausführbare SQL-Variante von ${statement.id} ist ungültig.`);
    }
    const hasColumns = Object.keys(statement.columns).length > 0;
    if ((statement.operation !== "execute" && entry.returning)
      || (statement.operation === "execute" && entry.returning !== hasColumns)
      || statements.has(statement)
      || statementIds.has(statement.id)) {
      throw invalidDialectContract(`Der Dialekteintrag ${statement.id} ist widersprüchlich oder doppelt.`);
    }
    statements.add(statement);
    statementIds.add(statement.id);
    return Object.freeze({
      statement,
      owner,
      classification: entry.classification,
      features,
      sql: entry.sql,
      returning: entry.returning,
    });
  });

  const manifestFingerprint = fingerprint({
    contractVersion: DIALECT_CONTRACT_VERSION,
    dialectId,
    entries: entries.map((entry) => ({
      statement: statementContractSnapshot(entry.statement),
      owner: entry.owner,
      classification: entry.classification,
      features: entry.features,
      sql: entry.sql,
      returning: entry.returning,
    })),
  });
  const manifest = Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    dialectId,
    executable: true,
    entries: Object.freeze(entries),
    fingerprint: manifestFingerprint,
  });
  DIALECT_MANIFESTS.add(manifest);
  return manifest;
}

function definePlannedDialectFixture(options = {}) {
  exactKeys(
    options,
    ["dialectId", "sourceManifest", "entries"],
    "Geplante Dialekt-Fixture",
  );
  const dialectId = normalizedDialectId(options.dialectId);
  const sourceManifest = assertDialectManifest(options.sourceManifest);
  if (dialectId === sourceManifest.dialectId
    || !Array.isArray(options.entries)
    || options.entries.length !== sourceManifest.entries.length) {
    throw invalidDialectContract("Die geplante Dialekt-Fixture deckt das Quellmanifest nicht ab.");
  }

  const entries = options.entries.map((entry, index) => {
    exactKeys(
      entry,
      ["statementId", "owner", "classification", "requiredFeatures", "status"],
      `Geplanter Dialekteintrag ${index}`,
    );
    const source = sourceManifest.entries[index];
    if (entry.statementId !== source.statement.id
      || entry.owner !== source.owner
      || entry.classification !== source.classification
      || entry.status !== PLANNED_DIALECT_STATUS
      || !Array.isArray(entry.requiredFeatures)
      || JSON.stringify(entry.requiredFeatures) !== JSON.stringify(source.features)) {
      throw invalidDialectContract(`Die geplante Variante von ${source.statement.id} ist unvollständig.`);
    }
    return Object.freeze({
      statementId: entry.statementId,
      owner: entry.owner,
      classification: entry.classification,
      requiredFeatures: Object.freeze([...entry.requiredFeatures]),
      status: PLANNED_DIALECT_STATUS,
    });
  });

  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    dialectId,
    sourceDialectId: sourceManifest.dialectId,
    sourceFingerprint: sourceManifest.fingerprint,
    status: PLANNED_DIALECT_STATUS,
    executable: false,
    entries: Object.freeze(entries),
    fingerprint: fingerprint({
      contractVersion: DIALECT_CONTRACT_VERSION,
      dialectId,
      sourceFingerprint: sourceManifest.fingerprint,
      entries,
    }),
  });
}

module.exports = {
  DIALECT_CONTRACT_VERSION,
  PLANNED_DIALECT_STATUS,
  SQL_OWNERSHIP_CLASSIFICATIONS,
  assertDialectManifest,
  defineDialectManifest,
  definePlannedDialectFixture,
};
