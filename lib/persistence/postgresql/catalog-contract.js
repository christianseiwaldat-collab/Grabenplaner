"use strict";

const { createHash } = require("node:crypto");
const {
  assertPersistenceStatement,
} = require("../contract");
const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../dialects/application-manifest");
const {
  POSTGRESQL_DIALECT_COMPILER_VERSION,
} = require("./dialect-compiler");

const POSTGRESQL_CATALOG_CONTRACT_VERSION = 1;
const POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT = 1369;
const POSTGRESQL_APPLICATION_ACCEPTANCE_REQUIRED_RECEIPT_COUNT =
  POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT;
const POSTGRESQL_APPLICATION_ACCEPTANCE_AVAILABLE_RECEIPT_COUNT = 0;
const POSTGRESQL_APPLICATION_ACCEPTANCE = Object.freeze({
  status: "closed",
  requiredReceiptCount:
    POSTGRESQL_APPLICATION_ACCEPTANCE_REQUIRED_RECEIPT_COUNT,
  acceptedReceiptCount:
    POSTGRESQL_APPLICATION_ACCEPTANCE_AVAILABLE_RECEIPT_COUNT,
});
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const FEATURE_PATTERN = /^[a-z][a-z0-9.-]{2,95}$/;
const CATALOG_ENTRIES = new WeakSet();
const CATALOGS = new WeakSet();

const SOURCE_ENTRIES = SQLITE_APPLICATION_DIALECT_MANIFEST.entries;
const PLAN_ENTRIES = POSTGRESQL_APPLICATION_DIALECT_PLAN.entries;
const SOURCE_INDEX_BY_STATEMENT = new WeakMap(
  SOURCE_ENTRIES.map((entry, index) => [entry.statement, index]),
);

function invalidCatalog(message) {
  return new TypeError(message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw invalidCatalog(`${label} must be a plain object.`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidCatalog(`${label} contains unsupported fields.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPair(statement, planEntry) {
  assertPersistenceStatement(statement);
  const index = SOURCE_INDEX_BY_STATEMENT.get(statement);
  if (!Number.isSafeInteger(index)
    || SOURCE_ENTRIES[index]?.statement !== statement
    || PLAN_ENTRIES[index] !== planEntry
    || planEntry.statementId !== statement.id
    || planEntry.owner !== SOURCE_ENTRIES[index].owner
    || planEntry.sourceSqlFingerprint !== sha256(SOURCE_ENTRIES[index].sql)
    || planEntry.returning !== SOURCE_ENTRIES[index].returning) {
    throw invalidCatalog("Catalog entry provenance does not match the canonical application plan.");
  }
  return {
    index,
    sourceEntry: SOURCE_ENTRIES[index],
    planEntry,
  };
}

function normalizedStringList(value, label, {
  pattern,
  allowEmpty = true,
} = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalidCatalog(`${label} must be a list.`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || (pattern && !pattern.test(entry))) {
      throw invalidCatalog(`${label} contains an invalid value.`);
    }
    return entry;
  });
  if (new Set(normalized).size !== normalized.length
    || JSON.stringify(normalized) !== JSON.stringify([...normalized].sort())) {
    throw invalidCatalog(`${label} must be unique and sorted.`);
  }
  return Object.freeze(normalized);
}

function normalizedPath(path) {
  if (!Array.isArray(path)
    || path.some((segment) => (
      !(typeof segment === "string"
        && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        && !["__proto__", "constructor", "prototype"].includes(segment))
      && !(Number.isSafeInteger(segment) && segment >= 0)
    ))) {
    throw invalidCatalog("A PostgreSQL parameter binding contains an invalid path.");
  }
  return Object.freeze([...path]);
}

function normalizedBindings(bindings, statement, parameterOrder) {
  if (!Array.isArray(bindings)) {
    throw invalidCatalog("PostgreSQL parameter bindings must be a list.");
  }
  const normalized = bindings.map((binding) => {
    exactKeys(binding, ["parameter", "source", "path"], "PostgreSQL parameter binding");
    if (typeof binding.parameter !== "string"
      || !Object.hasOwn(statement.parameters, binding.parameter)
      || !["value", "json-extract", "json-type"].includes(binding.source)) {
      throw invalidCatalog("A PostgreSQL parameter binding is invalid.");
    }
    const path = normalizedPath(binding.path);
    if ((binding.source === "value" && path.length > 0)
      || (binding.source !== "value"
        && statement.parameters[binding.parameter].kind !== "json")) {
      throw invalidCatalog("A PostgreSQL parameter binding contradicts its statement contract.");
    }
    return Object.freeze({
      parameter: binding.parameter,
      source: binding.source,
      path,
    });
  });
  const represented = [...new Set(normalized.map((binding) => binding.parameter))].sort();
  if (JSON.stringify(represented) !== JSON.stringify([...parameterOrder])) {
    throw invalidCatalog("PostgreSQL parameter bindings do not cover the statement contract.");
  }
  return Object.freeze(normalized);
}

function bindNamedParameters(statement, sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw invalidCatalog("An explicit PostgreSQL override needs SQL.");
  }
  const parameterOrder = Object.freeze(Object.keys(statement.parameters).sort());
  const parameterPositions = new Map(
    parameterOrder.map((name, index) => [name, index + 1]),
  );
  const used = new Set();
  let compiledSql = "";
  let index = 0;
  let state = "normal";
  let blockDepth = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "line-comment") {
      compiledSql += character;
      index += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (character === "/" && next === "*") {
        compiledSql += "/*";
        blockDepth += 1;
        index += 2;
      } else if (character === "*" && next === "/") {
        compiledSql += "*/";
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        compiledSql += character;
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      compiledSql += character;
      if (character === "'" && next === "'") {
        compiledSql += next;
        index += 2;
      } else {
        index += 1;
        if (character === "'") state = "normal";
      }
      continue;
    }
    if (state === "double-quote") {
      compiledSql += character;
      if (character === "\"" && next === "\"") {
        compiledSql += next;
        index += 2;
      } else {
        index += 1;
        if (character === "\"") state = "normal";
      }
      continue;
    }

    if (character === "-" && next === "-") {
      compiledSql += "--";
      state = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      compiledSql += "/*";
      state = "block-comment";
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'") {
      compiledSql += character;
      state = "single-quote";
      index += 1;
      continue;
    }
    if (character === "\"") {
      compiledSql += character;
      state = "double-quote";
      index += 1;
      continue;
    }
    if (character === "$") {
      if (/[0-9]/.test(next || "") || next === "$") {
        throw invalidCatalog("Explicit PostgreSQL overrides must use named parameters.");
      }
      if (/[A-Za-z]/.test(next || "")) {
        let end = index + 2;
        while (/[A-Za-z0-9_]/.test(sql[end] || "")) end += 1;
        const name = sql.slice(index + 1, end);
        const position = parameterPositions.get(name);
        if (!position) {
          throw invalidCatalog("Explicit PostgreSQL SQL contains an unknown parameter.");
        }
        used.add(name);
        compiledSql += `$${position}`;
        index = end;
        continue;
      }
      throw invalidCatalog("Explicit PostgreSQL SQL contains an unsupported dollar token.");
    }
    if (character === ":" && next === ":") {
      compiledSql += "::";
      index += 2;
      continue;
    }
    if (character === "?"
      || ((character === ":" || character === "@")
        && /[A-Za-z]/.test(next || ""))) {
      throw invalidCatalog("Explicit PostgreSQL overrides must use named dollar parameters.");
    }

    compiledSql += character;
    index += 1;
  }

  if (!["normal", "line-comment"].includes(state)) {
    throw invalidCatalog("Explicit PostgreSQL SQL contains an unterminated token.");
  }
  if (JSON.stringify([...used].sort()) !== JSON.stringify([...parameterOrder])) {
    throw invalidCatalog("Explicit PostgreSQL SQL does not bind every statement parameter.");
  }

  return Object.freeze({
    sql: compiledSql,
    parameterOrder,
    parameterBindings: Object.freeze(parameterOrder.map((parameter) => Object.freeze({
      parameter,
      source: "value",
      path: Object.freeze([]),
    }))),
  });
}

function frozenCatalogEntry({
  statement,
  index,
  owner,
  planStrategy,
  implementationStrategy,
  sql,
  sourceSqlFingerprint,
  compiledSqlFingerprint,
  parameterOrder,
  parameterBindings,
  returning,
  coveredFeatures,
  resolvedFeatures,
}) {
  const entry = Object.freeze({
    statement,
    statementId: statement.id,
    sourceIndex: index,
    owner,
    planStrategy,
    implementationStrategy,
    sql,
    sourceSqlFingerprint,
    compiledSqlFingerprint,
    parameterOrder,
    parameterBindings,
    resultColumnOrder: Object.freeze(Object.keys(statement.columns)),
    returning,
    coveredFeatures,
    resolvedFeatures,
  });
  CATALOG_ENTRIES.add(entry);
  return entry;
}

function definePostgresqlGeneratedCatalogEntry(options = {}) {
  exactKeys(options, ["statement", "planEntry"], "Generated PostgreSQL catalog entry");
  const { statement, planEntry } = options;
  const pair = canonicalPair(statement, planEntry);
  if (planEntry.strategy !== "portable-generated"
    || typeof planEntry.sql !== "string"
    || !FINGERPRINT_PATTERN.test(String(planEntry.compiledSqlFingerprint || ""))
    || sha256(planEntry.sql) !== planEntry.compiledSqlFingerprint) {
    throw invalidCatalog("Only a canonical portable plan entry can become a generated catalog entry.");
  }
  const parameterOrder = normalizedStringList(
    planEntry.parameterOrder,
    "Generated PostgreSQL parameter order",
  );
  const expectedParameters = Object.keys(statement.parameters).sort();
  if (JSON.stringify(parameterOrder) !== JSON.stringify(expectedParameters)) {
    throw invalidCatalog("Generated PostgreSQL parameter order does not match the statement.");
  }
  const parameterBindings = normalizedBindings(
    planEntry.parameterBindings,
    statement,
    parameterOrder,
  );
  return frozenCatalogEntry({
    statement,
    index: pair.index,
    owner: pair.sourceEntry.owner,
    planStrategy: planEntry.strategy,
    implementationStrategy: "portable-generated",
    sql: planEntry.sql,
    sourceSqlFingerprint: planEntry.sourceSqlFingerprint,
    compiledSqlFingerprint: planEntry.compiledSqlFingerprint,
    parameterOrder,
    parameterBindings,
    returning: pair.sourceEntry.returning,
    coveredFeatures: normalizedStringList(
      planEntry.coveredFeatures,
      "Generated PostgreSQL covered features",
      { pattern: FEATURE_PATTERN },
    ),
    resolvedFeatures: Object.freeze([]),
  });
}

function definePostgresqlOverrideCatalogEntry(options = {}) {
  exactKeys(
    options,
    ["statement", "planEntry", "sql", "resolvedFeatures"],
    "Explicit PostgreSQL catalog override",
  );
  const {
    statement,
    planEntry,
    sql,
    resolvedFeatures = [],
  } = options;
  const pair = canonicalPair(statement, planEntry);
  const normalizedResolvedFeatures = normalizedStringList(
    resolvedFeatures,
    "Resolved PostgreSQL override features",
    { pattern: FEATURE_PATTERN },
  );
  if (planEntry.blockingFeatures.some(
    (feature) => !normalizedResolvedFeatures.includes(feature),
  )) {
    throw invalidCatalog("An explicit PostgreSQL override leaves plan blockers unresolved.");
  }
  const binding = bindNamedParameters(statement, sql);
  return frozenCatalogEntry({
    statement,
    index: pair.index,
    owner: pair.sourceEntry.owner,
    planStrategy: planEntry.strategy,
    implementationStrategy: "explicit-override",
    sql: binding.sql,
    sourceSqlFingerprint: planEntry.sourceSqlFingerprint,
    compiledSqlFingerprint: sha256(binding.sql),
    parameterOrder: binding.parameterOrder,
    parameterBindings: binding.parameterBindings,
    returning: pair.sourceEntry.returning,
    coveredFeatures: Object.freeze([]),
    resolvedFeatures: normalizedResolvedFeatures,
  });
}

function statementSnapshot(statement) {
  function fieldsSnapshot(fields, preserveOrder) {
    const names = preserveOrder ? Object.keys(fields) : Object.keys(fields).sort();
    return names.map((name) => {
      const definition = fields[name];
      return Object.freeze({
        name,
        kind: definition.kind,
        nullable: definition.nullable,
        optional: definition.optional,
      });
    });
  }
  return Object.freeze({
    id: statement.id,
    operation: statement.operation,
    parameters: Object.freeze(fieldsSnapshot(statement.parameters, false)),
    columns: Object.freeze(fieldsSnapshot(statement.columns, true)),
  });
}

function entrySnapshot(entry) {
  return Object.freeze({
    statement: statementSnapshot(entry.statement),
    sourceIndex: entry.sourceIndex,
    owner: entry.owner,
    planStrategy: entry.planStrategy,
    implementationStrategy: entry.implementationStrategy,
    sourceSqlFingerprint: entry.sourceSqlFingerprint,
    compiledSqlFingerprint: entry.compiledSqlFingerprint,
    parameterOrder: entry.parameterOrder,
    parameterBindings: entry.parameterBindings,
    resultColumnOrder: entry.resultColumnOrder,
    returning: entry.returning,
    coveredFeatures: entry.coveredFeatures,
    resolvedFeatures: entry.resolvedFeatures,
  });
}

function assertCanonicalProvenance({
  sourceFingerprint,
  planFingerprint,
  compilerVersion,
}) {
  if (sourceFingerprint !== SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint
    || planFingerprint !== POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint
    || compilerVersion !== POSTGRESQL_DIALECT_COMPILER_VERSION
    || compilerVersion !== POSTGRESQL_APPLICATION_DIALECT_PLAN.compilerVersion
    || POSTGRESQL_APPLICATION_DIALECT_PLAN.sourceFingerprint !== sourceFingerprint
    || POSTGRESQL_APPLICATION_DIALECT_PLAN.executable !== false) {
    throw invalidCatalog("PostgreSQL catalog provenance is not canonical.");
  }
}

function closedApplicationAcceptanceError() {
  return invalidCatalog(
    "A complete branded PostgreSQL application catalog is unavailable "
      + `because the acceptance gate is closed at 0/${POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT} live/parity receipts.`,
  );
}

function describePostgresqlDevelopmentSlice(slice) {
  if (!isPlainRecord(slice)
    || !Object.isFrozen(slice)
    || typeof slice.sliceId !== "string"
    || !slice.sliceId
    || slice.status !== "development-contract"
    || slice.executable !== true
    || slice.fullApplicationCatalog !== false
    || slice.applicationExecutable === true
    || slice.productActivation === true
    || slice.sourcePlanFingerprint
      !== POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint
    || !FINGERPRINT_PATTERN.test(String(slice.fingerprint || ""))
    || !Array.isArray(slice.entries)
    || !Object.isFrozen(slice.entries)
    || slice.entries.length === 0
    || slice.entries.length >= POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT
    || !Array.isArray(slice.provenance)
    || !Object.isFrozen(slice.provenance)
    || slice.provenance.length !== slice.entries.length) {
    throw invalidCatalog(
      "A canonical isolated PostgreSQL development slice is required.",
    );
  }

  const statementIds = new Set();
  for (let index = 0; index < slice.entries.length; index += 1) {
    const entry = slice.entries[index];
    const provenance = slice.provenance[index];
    if (!isPlainRecord(entry)
      || !Object.isFrozen(entry)
      || !SOURCE_INDEX_BY_STATEMENT.has(entry.statement)
      || statementIds.has(entry.statement.id)
      || typeof entry.sql !== "string"
      || !entry.sql.trim()
      || !Array.isArray(entry.parameterOrder)
      || !Object.isFrozen(entry.parameterOrder)
      || !Array.isArray(entry.parameterBindings)
      || !Object.isFrozen(entry.parameterBindings)
      || typeof entry.returning !== "boolean"
      || !isPlainRecord(provenance)
      || !Object.isFrozen(provenance)
      || provenance.statementId !== entry.statement.id) {
      throw invalidCatalog(
        "A canonical isolated PostgreSQL development slice is required.",
      );
    }
    statementIds.add(entry.statement.id);
  }

  return Object.freeze({
    sliceId: slice.sliceId,
    status: "partial-development-slice",
    developmentExecutable: true,
    executable: true,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    statementCount: slice.entries.length,
    sourcePlanFingerprint: slice.sourcePlanFingerprint,
    sliceFingerprint: slice.fingerprint,
  });
}

function definePostgresqlApplicationCatalog(options = {}) {
  exactKeys(
    options,
    [
      "compilerVersion",
      "entries",
      "fullApplicationCatalog",
      "planFingerprint",
      "sourceFingerprint",
    ],
    "PostgreSQL application catalog",
  );
  const {
    compilerVersion,
    entries,
    fullApplicationCatalog,
    planFingerprint,
    sourceFingerprint,
  } = options;
  if (typeof fullApplicationCatalog !== "boolean"
    || !Array.isArray(entries)
    || entries.length === 0) {
    throw invalidCatalog("A PostgreSQL application catalog needs entries and an explicit scope.");
  }
  assertCanonicalProvenance({
    sourceFingerprint,
    planFingerprint,
    compilerVersion,
  });

  const normalizedEntries = [];
  const statementIds = new Set();
  let previousIndex = -1;
  for (const entry of entries) {
    if (!CATALOG_ENTRIES.has(entry)
      || statementIds.has(entry.statementId)
      || entry.sourceIndex <= previousIndex
      || SOURCE_ENTRIES[entry.sourceIndex]?.statement !== entry.statement
      || PLAN_ENTRIES[entry.sourceIndex]?.statementId !== entry.statementId) {
      throw invalidCatalog("PostgreSQL application catalog entries are incomplete, duplicated, or unordered.");
    }
    statementIds.add(entry.statementId);
    previousIndex = entry.sourceIndex;
    normalizedEntries.push(entry);
  }

  if (fullApplicationCatalog
    && (normalizedEntries.length !== POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT
      || normalizedEntries.length !== SOURCE_ENTRIES.length
      || normalizedEntries.some((entry, index) => entry.sourceIndex !== index))) {
    throw invalidCatalog(
      `A full PostgreSQL application catalog must cover exactly ${POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT} statements.`,
    );
  }
  if (!fullApplicationCatalog
    && normalizedEntries.length >= POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT) {
    throw invalidCatalog(
      `A partial PostgreSQL development catalog cannot contain all ${POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT} statements.`,
    );
  }
  if (fullApplicationCatalog) throw closedApplicationAcceptanceError();

  const frozenEntries = Object.freeze(normalizedEntries);
  const providerEntries = Object.freeze(frozenEntries.map((entry) => Object.freeze({
    statement: entry.statement,
    sql: entry.sql,
    parameterOrder: entry.parameterOrder,
    parameterBindings: entry.parameterBindings,
    returning: entry.returning,
  })));
  const developmentExecutable = true;
  const snapshot = Object.freeze({
    contractVersion: POSTGRESQL_CATALOG_CONTRACT_VERSION,
    providerId: "postgresql",
    status: "partial-development-slice",
    developmentExecutable,
    executable: developmentExecutable,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    acceptance: POSTGRESQL_APPLICATION_ACCEPTANCE,
    sourceFingerprint,
    planFingerprint,
    compilerVersion,
    entries: Object.freeze(frozenEntries.map(entrySnapshot)),
  });
  const catalog = Object.freeze({
    contractVersion: POSTGRESQL_CATALOG_CONTRACT_VERSION,
    providerId: "postgresql",
    status: "partial-development-slice",
    developmentExecutable,
    executable: developmentExecutable,
    applicationExecutable: false,
    fullApplicationCatalog: false,
    productActivation: false,
    acceptance: POSTGRESQL_APPLICATION_ACCEPTANCE,
    provenance: Object.freeze({
      sourceFingerprint,
      planFingerprint,
      compilerVersion,
    }),
    summary: Object.freeze({
      expectedStatementCount: POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT,
      statementCount: frozenEntries.length,
      generatedCount: frozenEntries.filter(
        (entry) => entry.implementationStrategy === "portable-generated",
      ).length,
      overrideCount: frozenEntries.filter(
        (entry) => entry.implementationStrategy === "explicit-override",
      ).length,
    }),
    entries: frozenEntries,
    providerEntries,
    fingerprint: sha256(JSON.stringify(snapshot)),
  });
  CATALOGS.add(catalog);
  return catalog;
}

function assertPostgresqlApplicationCatalog(catalog) {
  if (!CATALOGS.has(catalog)) {
    throw invalidCatalog("A branded PostgreSQL application catalog is required.");
  }
  return catalog;
}

function assertFullPostgresqlApplicationCatalog(catalog) {
  void catalog;
  throw closedApplicationAcceptanceError();
}

module.exports = {
  POSTGRESQL_APPLICATION_ACCEPTANCE,
  POSTGRESQL_APPLICATION_ACCEPTANCE_AVAILABLE_RECEIPT_COUNT,
  POSTGRESQL_APPLICATION_ACCEPTANCE_REQUIRED_RECEIPT_COUNT,
  POSTGRESQL_CATALOG_CONTRACT_VERSION,
  POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT,
  assertFullPostgresqlApplicationCatalog,
  assertPostgresqlApplicationCatalog,
  definePostgresqlApplicationCatalog,
  definePostgresqlGeneratedCatalogEntry,
  definePostgresqlOverrideCatalogEntry,
  describePostgresqlDevelopmentSlice,
};
