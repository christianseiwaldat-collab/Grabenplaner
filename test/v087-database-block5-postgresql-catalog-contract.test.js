"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../lib/persistence/dialects/application-manifest");
const {
  POSTGRESQL_DIALECT_COMPILER_VERSION,
} = require("../lib/persistence/postgresql/dialect-compiler");
const {
  createPostgresqlOrganizationDepartmentsSlice,
} = require("../lib/persistence/postgresql/organization-departments-catalog");
const {
  createPostgresqlPlanningSettingsSlice,
} = require("../lib/persistence/postgresql/planning-settings-catalog");
const {
  createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice,
} = require("../lib/persistence/postgresql/system-center-metrics-catalog");
const {
  createPostgresqlUiPreferencesSlice,
} = require("../lib/persistence/postgresql/ui-preferences-catalog");
const {
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
} = require("../lib/persistence/postgresql/catalog-contract");

const SOURCE_ENTRIES = SQLITE_APPLICATION_DIALECT_MANIFEST.entries;
const PLAN_ENTRIES = POSTGRESQL_APPLICATION_DIALECT_PLAN.entries;
const SOURCE_BY_ID = new Map(
  SOURCE_ENTRIES.map((entry) => [entry.statement.id, entry]),
);
const PLAN_BY_ID = new Map(
  PLAN_ENTRIES.map((entry) => [entry.statementId, entry]),
);

const CANONICAL_PROVENANCE = Object.freeze({
  sourceFingerprint: SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint,
  planFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
  compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION,
});

function isDeepFrozen(value, visited = new Set()) {
  if (value === null
    || (typeof value !== "object" && typeof value !== "function")
    || visited.has(value)) {
    return true;
  }
  if (!Object.isFrozen(value)) return false;
  visited.add(value);
  return Reflect.ownKeys(value)
    .every((key) => isDeepFrozen(value[key], visited));
}

function generatedEntry(statementId) {
  return definePostgresqlGeneratedCatalogEntry({
    statement: SOURCE_BY_ID.get(statementId).statement,
    planEntry: PLAN_BY_ID.get(statementId),
  });
}

function resultExpression(name, definition) {
  const expressionByKind = {
    text: "''::text",
    boolean: "FALSE",
    safe_integer: "0::bigint",
    bigint_string: "0::bigint",
    decimal_string: "0::numeric",
    utc_timestamp: "'2026-07-29T00:00:00.000Z'::timestamptz",
    date: "'2026-07-29'::date",
    time: "'00:00:00'::time",
    json: "'{}'::jsonb",
    bytes: "decode('', 'hex')",
  };
  return `${expressionByKind[definition.kind]} AS "${name.replace(/"/g, "\"\"")}"`;
}

function syntheticOverrideSql(statement) {
  const parameters = Object.keys(statement.parameters).sort();
  const input = parameters.length
    ? `WITH input AS (SELECT ${parameters.map(
      (name) => `$${name} AS "${name}"`,
    ).join(", ")}) `
    : "";
  const resultColumns = Object.entries(statement.columns)
    .map(([name, definition]) => resultExpression(name, definition));

  if (statement.operation !== "execute") {
    return `${input}SELECT ${resultColumns.length ? resultColumns.join(", ") : "1"}${
      parameters.length ? " FROM input" : ""
    }`;
  }

  return `${input}DELETE FROM catalog_contract_fixture${
    parameters.length ? " USING input" : ""
  } WHERE FALSE${
    resultColumns.length ? ` RETURNING ${resultColumns.join(", ")}` : ""
  }`;
}

function catalogEntryAt(index) {
  const source = SOURCE_ENTRIES[index];
  const plan = PLAN_ENTRIES[index];
  if (plan.strategy === "portable-generated") {
    return definePostgresqlGeneratedCatalogEntry({
      statement: source.statement,
      planEntry: plan,
    });
  }
  return definePostgresqlOverrideCatalogEntry({
    statement: source.statement,
    planEntry: plan,
    sql: syntheticOverrideSql(source.statement),
    resolvedFeatures: plan.blockingFeatures,
  });
}

function defineCatalog(entries, fullApplicationCatalog) {
  return definePostgresqlApplicationCatalog({
    ...CANONICAL_PROVENANCE,
    entries,
    fullApplicationCatalog,
  });
}

function uiPreferencesSlice() {
  const ids = [
    "ui-preferences.list-by-employee",
    "ui-preferences.get",
    "ui-preferences.upsert",
    "ui-preferences.delete",
  ];
  return ids.map((id) => {
    const source = SOURCE_BY_ID.get(id);
    const plan = PLAN_BY_ID.get(id);
    if (plan.strategy === "portable-generated") return generatedEntry(id);
    return definePostgresqlOverrideCatalogEntry({
      statement: source.statement,
      planEntry: plan,
      sql: `
        SELECT preference_key AS "preferenceKey", value
        FROM portal_user_preferences
        WHERE employee_number = $employeeNumber
        ORDER BY lower(preference_key), preference_key
      `,
      resolvedFeatures: plan.blockingFeatures,
    });
  });
}

test("DB Block 5: der generierte Dialektplan ist niemals selbst ein ausfuehrbarer Vollkatalog", () => {
  assert.equal(POSTGRESQL_APPLICATION_DIALECT_PLAN.executable, false);
  assert.throws(
    () => assertPostgresqlApplicationCatalog(POSTGRESQL_APPLICATION_DIALECT_PLAN),
    /branded PostgreSQL application catalog/,
  );
  assert.throws(
    () => assertFullPostgresqlApplicationCatalog(POSTGRESQL_APPLICATION_DIALECT_PLAN),
    /acceptance gate is closed at 0\/1371/,
  );
  assert.throws(
    () => defineCatalog(POSTGRESQL_APPLICATION_DIALECT_PLAN.entries, true),
    /incomplete, duplicated, or unordered/,
  );
});

test("DB Block 5: ein Teilkatalog ist nur isoliert entwicklungs-ausfuehrbar", () => {
  const catalog = defineCatalog(uiPreferencesSlice(), false);

  assert.equal(assertPostgresqlApplicationCatalog(catalog), catalog);
  assert.equal(catalog.contractVersion, POSTGRESQL_CATALOG_CONTRACT_VERSION);
  assert.equal(catalog.providerId, "postgresql");
  assert.equal(catalog.status, "partial-development-slice");
  assert.equal(catalog.developmentExecutable, true);
  assert.equal(catalog.executable, true);
  assert.equal(catalog.applicationExecutable, false);
  assert.equal(catalog.fullApplicationCatalog, false);
  assert.equal(catalog.productActivation, false);
  assert.equal(catalog.acceptance, POSTGRESQL_APPLICATION_ACCEPTANCE);
  assert.deepEqual(catalog.acceptance, {
    status: "closed",
    requiredReceiptCount: 1371,
    acceptedReceiptCount: 0,
  });
  assert.equal(catalog.entries.length, 4);
  assert.equal(catalog.providerEntries.length, 4);
  assert.deepEqual(catalog.summary, {
    expectedStatementCount: 1371,
    statementCount: 4,
    generatedCount: 3,
    overrideCount: 1,
  });
  assert.match(catalog.entries[0].sql, /employee_number = \$1/);
  assert.deepEqual(catalog.entries[0].parameterOrder, ["employeeNumber"]);
  assert.equal(catalog.entries[0].sql.includes("$employeeNumber"), false);
  assert.equal(isDeepFrozen(catalog), true);
  assert.throws(
    () => assertFullPostgresqlApplicationCatalog(catalog),
    /acceptance gate is closed at 0\/1371/,
  );
});

test("DB Block 5: reale PostgreSQL-Slices bleiben Teil-Slices ohne Anwendungsfreigabe", () => {
  const slices = [
    {
      slice: createPostgresqlUiPreferencesSlice({
        schemaName: "grabenplaner_contract",
      }),
      sliceId: "ui-preferences",
      statementCount: 4,
    },
    {
      slice: createPostgresqlPlanningSettingsSlice({
        schemaName: "grabenplaner_contract",
      }),
      sliceId: "planning-settings.settings",
      statementCount: 2,
    },
    {
      slice: createPostgresqlOrganizationDepartmentsSlice({
        schemaName: "grabenplaner_contract",
      }),
      sliceId: "organization-personnel.departments",
      statementCount: 2,
    },
    {
      slice: createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
        schemaName: "grabenplaner_contract",
      }),
      sliceId: "system-center-metrics.oldest-interval-keys",
      statementCount: 1,
    },
  ];

  for (const {
    slice,
    sliceId,
    statementCount,
  } of slices) {
    assert.equal(slice.executable, true);
    assert.equal(slice.fullApplicationCatalog, false);

    const description = describePostgresqlDevelopmentSlice(slice);
    assert.deepEqual(description, {
      sliceId,
      status: "partial-development-slice",
      developmentExecutable: true,
      executable: true,
      applicationExecutable: false,
      fullApplicationCatalog: false,
      productActivation: false,
      statementCount,
      sourcePlanFingerprint: POSTGRESQL_APPLICATION_DIALECT_PLAN.fingerprint,
      sliceFingerprint: slice.fingerprint,
    });
    assert.equal(isDeepFrozen(description), true);
    assert.throws(
      () => assertFullPostgresqlApplicationCatalog(slice),
      /acceptance gate is closed at 0\/1371/,
    );
  }
});

test("DB Block 5: Source-, Plan- und Compiler-Provenienz scheitern geschlossen", () => {
  const entries = uiPreferencesSlice();
  const invalidProvenance = [
    {
      ...CANONICAL_PROVENANCE,
      sourceFingerprint: "0".repeat(64),
    },
    {
      ...CANONICAL_PROVENANCE,
      planFingerprint: "1".repeat(64),
    },
    {
      ...CANONICAL_PROVENANCE,
      compilerVersion: POSTGRESQL_DIALECT_COMPILER_VERSION + 1,
    },
  ];

  for (const provenance of invalidProvenance) {
    assert.throws(
      () => definePostgresqlApplicationCatalog({
        ...provenance,
        entries,
        fullApplicationCatalog: false,
      }),
      /provenance is not canonical/,
    );
  }
});

test("DB Block 5: explizite Overrides binden nur benannte Parameter", () => {
  const source = SOURCE_BY_ID.get("ui-preferences.list-by-employee");
  const plan = PLAN_BY_ID.get(source.statement.id);

  assert.throws(
    () => definePostgresqlOverrideCatalogEntry({
      statement: source.statement,
      planEntry: plan,
      sql: "SELECT preference_key AS \"preferenceKey\", value FROM portal_user_preferences WHERE employee_number = $1",
      resolvedFeatures: plan.blockingFeatures,
    }),
    /must use named parameters/,
  );
  assert.throws(
    () => definePostgresqlOverrideCatalogEntry({
      statement: source.statement,
      planEntry: plan,
      sql: "SELECT preference_key AS \"preferenceKey\", value FROM portal_user_preferences",
      resolvedFeatures: plan.blockingFeatures,
    }),
    /does not bind every statement parameter/,
  );
  assert.throws(
    () => definePostgresqlOverrideCatalogEntry({
      statement: source.statement,
      planEntry: plan,
      sql: "SELECT preference_key AS \"preferenceKey\", value FROM portal_user_preferences WHERE employee_number = $employeeNumber",
      resolvedFeatures: [],
    }),
    /leaves plan blockers unresolved/,
  );
});

test("DB Block 5: auch 1371 Deklarationen bleiben bei 0/1371 Receipts ohne Vollfreigabe", () => {
  const entries = Object.freeze(
    SOURCE_ENTRIES.map((_, index) => catalogEntryAt(index)),
  );
  assert.equal(entries.length, POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT);
  assert.equal(
    POSTGRESQL_APPLICATION_ACCEPTANCE_REQUIRED_RECEIPT_COUNT,
    POSTGRESQL_FULL_APPLICATION_STATEMENT_COUNT,
  );
  assert.equal(
    POSTGRESQL_APPLICATION_ACCEPTANCE_AVAILABLE_RECEIPT_COUNT,
    0,
  );

  assert.throws(
    () => defineCatalog(entries.slice(0, -1), true),
    /must cover exactly 1371 statements/,
  );
  assert.throws(
    () => defineCatalog([...entries.slice(0, -1), entries[0]], true),
    /incomplete, duplicated, or unordered/,
  );

  const deliberatelyPartial = defineCatalog(entries.slice(0, -1), false);
  assert.equal(deliberatelyPartial.status, "partial-development-slice");
  assert.equal(deliberatelyPartial.developmentExecutable, true);
  assert.equal(deliberatelyPartial.executable, true);
  assert.equal(deliberatelyPartial.applicationExecutable, false);
  assert.equal(deliberatelyPartial.fullApplicationCatalog, false);
  assert.equal(deliberatelyPartial.productActivation, false);
  assert.equal(deliberatelyPartial.acceptance.acceptedReceiptCount, 0);
  assert.equal(deliberatelyPartial.acceptance.requiredReceiptCount, 1371);
  assert.throws(
    () => assertFullPostgresqlApplicationCatalog(deliberatelyPartial),
    /acceptance gate is closed at 0\/1371/,
  );

  assert.throws(
    () => defineCatalog(entries, true),
    /acceptance gate is closed at 0\/1371/,
  );
  assert.throws(
    () => defineCatalog(entries, false),
    /partial PostgreSQL development catalog cannot contain all 1371 statements/,
  );
  assert.equal(deliberatelyPartial.entries.length, entries.length - 1);
  assert.equal(deliberatelyPartial.providerEntries.length, entries.length - 1);
  assert.match(deliberatelyPartial.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(isDeepFrozen(deliberatelyPartial), true);
});
