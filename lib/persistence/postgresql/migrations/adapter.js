"use strict";

const { createHash } = require("node:crypto");
const {
  MIGRATION_CONTRACT_VERSION,
  MIGRATION_ERROR_CODES,
  MigrationContractError,
} = require("../../migrations/contract");

const HISTORY_TABLE = "persistence_migration_history";
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_ARTIFACT_FORMAT_VERSION = 1;
const ALLOWED_DATA_COMMANDS = new Set([
  "DELETE",
  "INSERT",
  "SELECT",
  "UPDATE",
]);
const ALLOWED_DDL_OBJECTS = Object.freeze({
  ALTER: new Set(["INDEX", "TABLE"]),
  CREATE: new Set(["INDEX", "TABLE"]),
  DROP: new Set(["INDEX", "TABLE"]),
});
const FORBIDDEN_FUNCTIONS = new Set([
  "LO_EXPORT",
  "LO_IMPORT",
  "PG_ADVISORY_LOCK",
  "PG_ADVISORY_UNLOCK",
  "PG_ADVISORY_UNLOCK_ALL",
  "PG_ADVISORY_XACT_LOCK",
  "PG_CANCEL_BACKEND",
  "PG_RELOAD_CONF",
  "PG_ROTATE_LOGFILE",
  "PG_TERMINATE_BACKEND",
  "PG_TRY_ADVISORY_LOCK",
  "PG_TRY_ADVISORY_XACT_LOCK",
  "SET_CONFIG",
]);
const FORBIDDEN_TOKENS = new Set([
  "DEFINER",
  "FUNCTION",
  "PROCEDURE",
  "SCHEMA",
  "SEARCH_PATH",
  "SECURITY",
  "SESSION",
  "TEMP",
  "TEMPORARY",
  "UNLOGGED",
  HISTORY_TABLE.toUpperCase(),
]);
const EXPECTED_LEDGER_COLUMNS = Object.freeze([
  Object.freeze({
    name: "manifest_id",
    type: "text",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "position",
    type: "integer",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "migration_id",
    type: "text",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "fingerprint",
    type: "text",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "implementation_fingerprint",
    type: "text",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "implementation_contract_json",
    type: "jsonb",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "contract_version",
    type: "integer",
    notNull: true,
    hasDefault: false,
  }),
  Object.freeze({
    name: "applied_at",
    type: "timestamp with time zone",
    notNull: true,
    hasDefault: false,
  }),
]);
const EXPECTED_LEDGER_CONSTRAINTS = Object.freeze({
  persistence_migration_history_pkey: Object.freeze({
    type: "p",
    columns: Object.freeze(["manifest_id", "migration_id"]),
    expression: null,
  }),
  persistence_migration_history_manifest_position_key: Object.freeze({
    type: "u",
    columns: Object.freeze(["manifest_id", "position"]),
    expression: null,
  }),
  persistence_migration_history_position_check: Object.freeze({
    type: "c",
    columns: Object.freeze(["position"]),
    expression: "position>=0",
  }),
  persistence_migration_history_fingerprint_check: Object.freeze({
    type: "c",
    columns: Object.freeze(["fingerprint"]),
    expression: "fingerprint~'^[a-f0-9]{64}$'",
  }),
  persistence_migration_history_impl_fingerprint_check: Object.freeze({
    type: "c",
    columns: Object.freeze(["implementation_fingerprint"]),
    expression: "implementation_fingerprint~'^[a-f0-9]{64}$'",
  }),
  persistence_migration_history_contract_version_check: Object.freeze({
    type: "c",
    columns: Object.freeze(["contract_version"]),
    expression: `contract_version=${MIGRATION_CONTRACT_VERSION}`,
  }),
});

function migrationError(code, message) {
  return new MigrationContractError(code, message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, code, label) {
  if (!isPlainRecord(value)
    || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw migrationError(code, `${label} is invalid.`);
  }
}

function quotedIdentifier(identifier) {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedArtifactSql(sql) {
  if (typeof sql !== "string" || !sql.trim() || sql.includes("\0")) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "PostgreSQL migration artifacts contain invalid SQL.",
    );
  }
  return sql.replace(/\r\n?/g, "\n").trim();
}

function normalizedArtifactParameter(value) {
  if (value === null
    || typeof value === "boolean"
    || typeof value === "string") {
    if (typeof value === "string" && value.includes("\0")) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "PostgreSQL migration artifact parameters cannot contain NUL.",
      );
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizedArtifactParameter));
  }
  if (isPlainRecord(value)) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (!key || key.includes("\0")) {
        throw migrationError(
          MIGRATION_ERROR_CODES.ADAPTER_INVALID,
          "PostgreSQL migration artifact parameter keys are invalid.",
        );
      }
      normalized[key] = normalizedArtifactParameter(value[key]);
    }
    return Object.freeze(normalized);
  }
  throw migrationError(
    MIGRATION_ERROR_CODES.ADAPTER_INVALID,
    "PostgreSQL migration artifacts contain a non-reproducible parameter.",
  );
}

function normalizedOperationArtifact(operationId, artifact) {
  if (!isPlainRecord(artifact)
    || JSON.stringify(Object.keys(artifact).sort())
      !== JSON.stringify([
        "formatVersion",
        "operationVersion",
        "statements",
      ])
    || artifact.formatVersion !== OPERATION_ARTIFACT_FORMAT_VERSION
    || !Number.isSafeInteger(artifact.operationVersion)
    || artifact.operationVersion < 1
    || !Array.isArray(artifact.statements)
    || artifact.statements.length === 0) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "PostgreSQL migration registry contains an invalid operation artifact.",
    );
  }
  const statements = Object.freeze(artifact.statements.map((statement) => {
    if (!isPlainRecord(statement)
      || JSON.stringify(Object.keys(statement).sort())
        !== JSON.stringify(["parameters", "sql"])
      || !Array.isArray(statement.parameters)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "PostgreSQL migration artifact statements are invalid.",
      );
    }
    const sql = normalizedArtifactSql(statement.sql);
    assertOperationSqlAllowed(sql, MIGRATION_ERROR_CODES.ADAPTER_INVALID);
    return Object.freeze({
      sql,
      parameters: Object.freeze(
        statement.parameters.map(normalizedArtifactParameter),
      ),
    });
  }));
  const normalizedArtifact = Object.freeze({
    formatVersion: artifact.formatVersion,
    operationVersion: artifact.operationVersion,
    statements,
  });
  const implementationFingerprint = sha256(JSON.stringify({
    artifact: normalizedArtifact,
    operationId,
  }));
  return Object.freeze({
    artifact: normalizedArtifact,
    implementationFingerprint,
  });
}

function normalizedOperations(operations) {
  if (!isPlainRecord(operations)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "PostgreSQL migration operations must be a plain registry.",
    );
  }
  const registry = new Map();
  for (const [id, operation] of Object.entries(operations)) {
    if (!IDENTIFIER_PATTERN.test(id)
      || !isPlainRecord(operation)
      || JSON.stringify(Object.keys(operation).sort())
        !== JSON.stringify(["artifact"])) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "PostgreSQL migration registry contains an invalid operation.",
      );
    }
    registry.set(id, normalizedOperationArtifact(id, operation.artifact));
  }
  return registry;
}

function implementationContract(registry, migration) {
  function entries(operationIds, label) {
    if (!Array.isArray(operationIds)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        `PostgreSQL migration ${label} operations are invalid.`,
      );
    }
    return Object.freeze(operationIds.map((operationId) => {
      const operation = registry.get(operationId);
      if (!operation) {
        throw migrationError(
          MIGRATION_ERROR_CODES.OPERATION_UNAVAILABLE,
          `PostgreSQL migration operation ${operationId} is unavailable.`,
        );
      }
      return Object.freeze({
        operationId,
        implementationFingerprint: operation.implementationFingerprint,
      });
    }));
  }

  return Object.freeze({
    apply: entries(migration.operations, "apply"),
    rollback: entries(migration.rollbackOperations || [], "rollback"),
  });
}

function implementationContractFingerprint(contract) {
  return sha256(JSON.stringify(contract));
}

function normalizedStoredImplementationContract(registry, value) {
  let contract = value;
  if (typeof contract === "string") {
    try {
      contract = JSON.parse(contract);
    } catch {
      contract = null;
    }
  }
  if (!isPlainRecord(contract)
    || JSON.stringify(Object.keys(contract).sort())
      !== JSON.stringify(["apply", "rollback"])
    || !Array.isArray(contract.apply)
    || contract.apply.length === 0
    || !Array.isArray(contract.rollback)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.HISTORY_INVALID,
      "PostgreSQL migration history has an invalid implementation contract.",
    );
  }

  function entries(values) {
    const seen = new Set();
    return Object.freeze(values.map((entry) => {
      if (!isPlainRecord(entry)
        || JSON.stringify(Object.keys(entry).sort())
          !== JSON.stringify(["implementationFingerprint", "operationId"])
        || !IDENTIFIER_PATTERN.test(String(entry.operationId || ""))
        || !FINGERPRINT_PATTERN.test(
          String(entry.implementationFingerprint || ""),
        )
        || seen.has(entry.operationId)) {
        throw migrationError(
          MIGRATION_ERROR_CODES.HISTORY_INVALID,
          "PostgreSQL migration history has invalid implementation bindings.",
        );
      }
      seen.add(entry.operationId);
      const current = registry.get(entry.operationId);
      if (!current
        || current.implementationFingerprint
          !== entry.implementationFingerprint) {
        throw migrationError(
          MIGRATION_ERROR_CODES.HISTORY_INVALID,
          `PostgreSQL migration operation ${entry.operationId} changed after it was applied.`,
        );
      }
      return Object.freeze({
        operationId: entry.operationId,
        implementationFingerprint: entry.implementationFingerprint,
      });
    }));
  }

  return Object.freeze({
    apply: entries(contract.apply),
    rollback: entries(contract.rollback),
  });
}

function canonicalCheckExpression(expression) {
  return String(expression || "")
    .toLowerCase()
    .replace(/::text/g, "")
    .replace(/["()\s]/g, "");
}

function sqlStatements(sql) {
  if (typeof sql !== "string" || !sql.trim() || sql.includes("\0")) {
    throw migrationError(
      MIGRATION_ERROR_CODES.EXECUTION_INVALID,
      "PostgreSQL migration queries need one SQL statement.",
    );
  }
  const statements = [];
  let tokens = [];
  let hasContent = false;
  let position = 0;
  let state = "normal";
  let blockDepth = 0;
  let dollarTag = "";
  let quotedIdentifier = "";

  function completeStatement() {
    if (hasContent || tokens.length > 0) statements.push(tokens);
    tokens = [];
    hasContent = false;
  }

  while (position < sql.length) {
    const character = sql[position];
    const next = sql[position + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      position += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "/" && next === "*") {
        blockDepth += 1;
        position += 2;
      } else if (character === "*" && next === "/") {
        blockDepth -= 1;
        position += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        position += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") position += 2;
      else {
        if (character === "'") state = "normal";
        position += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      if ((character === "\"" && next === "\"") || character === "\\") {
        throw migrationError(
          MIGRATION_ERROR_CODES.EXECUTION_INVALID,
          "PostgreSQL migration queries cannot use escaped quoted identifiers.",
        );
      }
      if (character === "\"") {
        tokens.push(quotedIdentifier.toUpperCase());
        quotedIdentifier = "";
        state = "normal";
      } else {
        quotedIdentifier += character;
      }
      position += 1;
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, position)) {
        position += dollarTag.length;
        state = "normal";
      } else {
        position += 1;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      position += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      blockDepth = 1;
      position += 2;
      continue;
    }
    if (character === "'") {
      hasContent = true;
      state = "single-quote";
      position += 1;
      continue;
    }
    if (character === "\"") {
      hasContent = true;
      quotedIdentifier = "";
      state = "double-quote";
      position += 1;
      continue;
    }
    if (character === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/
        .exec(sql.slice(position))?.[0];
      if (tag) {
        hasContent = true;
        dollarTag = tag;
        state = "dollar-quote";
        position += tag.length;
        continue;
      }
    }
    if (character === ";") {
      completeStatement();
      position += 1;
      continue;
    }
    if (character === ".") {
      tokens.push(".");
      hasContent = true;
      position += 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/
      .exec(sql.slice(position))?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      hasContent = true;
      position += word.length;
      continue;
    }
    if (!/\s/.test(character)) hasContent = true;
    position += 1;
  }
  if (!["normal", "line-comment"].includes(state)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.EXECUTION_INVALID,
      "PostgreSQL migration query contains an unterminated SQL token.",
    );
  }
  completeStatement();
  if (statements.length !== 1) {
    throw migrationError(
      MIGRATION_ERROR_CODES.EXECUTION_INVALID,
      "PostgreSQL migration artifact entries must contain one SQL statement.",
    );
  }
  return statements[0];
}

function assertOperationSqlAllowed(
  sql,
  code = MIGRATION_ERROR_CODES.EXECUTION_INVALID,
) {
  const tokens = sqlStatements(sql);
  const command = tokens[0] || "";
  const qualifiedIdentifier = tokens.some((token, index) => (
    token === "."
      && /^[A-Z_][A-Z0-9_$]*$/.test(tokens[index - 1] || "")
      && /^[A-Z_][A-Z0-9_$]*$/.test(tokens[index + 1] || "")
  ));
  let commandAllowed = ALLOWED_DATA_COMMANDS.has(command);
  if (Object.hasOwn(ALLOWED_DDL_OBJECTS, command)) {
    let objectIndex = 1;
    if (command === "CREATE" && tokens[1] === "UNIQUE") objectIndex = 2;
    commandAllowed = ALLOWED_DDL_OBJECTS[command].has(tokens[objectIndex]);
  }
  const dataGrammarAllowed = (
    command !== "INSERT" || tokens[1] === "INTO"
  ) && (
    command !== "DELETE" || tokens[1] === "FROM"
  ) && (
    command !== "SELECT" || !tokens.includes("INTO")
  );
  if (!commandAllowed
    || !dataGrammarAllowed
    || tokens.some((token) => FORBIDDEN_FUNCTIONS.has(token))
    || tokens.some((token) => FORBIDDEN_TOKENS.has(token))
    || qualifiedIdentifier) {
    throw migrationError(
      code,
      `PostgreSQL migration artifacts cannot execute ${command || "this command"}.`,
    );
  }
}

async function executeOperationArtifact(client, operation) {
  for (const statement of operation.artifact.statements) {
    await client.query(statement.sql, statement.parameters);
  }
}

function advisoryLockKey(schemaName) {
  const digest = createHash("sha256")
    .update(`grabenplaner.postgresql.migrations:${schemaName}`)
    .digest();
  return digest.readBigInt64BE(0).toString();
}

function createPostgresqlMigrationAdapter({
  expectedRole,
  pool,
  schemaName,
  operations,
} = {}) {
  if (!pool || typeof pool !== "object"
    || typeof pool.connect !== "function") {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "An external PostgreSQL pool is required.",
    );
  }
  if (typeof schemaName !== "string"
    || !SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "PostgreSQL migration schemaName is invalid.",
    );
  }
  if (typeof expectedRole !== "string"
    || !ROLE_NAME_PATTERN.test(expectedRole)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "PostgreSQL migration expectedRole is invalid.",
    );
  }
  const registry = normalizedOperations(operations);
  const quotedSchema = quotedIdentifier(schemaName);
  const historyRelation = `${quotedSchema}.${quotedIdentifier(HISTORY_TABLE)}`;
  const lockKey = advisoryLockKey(schemaName);

  async function ensureExecutionBoundary(client) {
    const result = await client.query(`
      SELECT
        current_user::text AS "currentUser",
        session_user::text AS "sessionUser",
        owner.rolname::text AS "schemaOwner",
        actor.rolsuper AS "superuser",
        actor.rolcreaterole AS "createRole",
        actor.rolcreatedb AS "createDatabase",
        actor.rolbypassrls AS "bypassRowSecurity",
        actor.rolreplication AS "replication",
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = actor.oid
        ) AS "membershipCount"
      FROM pg_catalog.pg_namespace AS namespace
      INNER JOIN pg_catalog.pg_roles AS owner
        ON owner.oid = namespace.nspowner
      INNER JOIN pg_catalog.pg_roles AS actor
        ON actor.rolname = current_user
      WHERE namespace.nspname = $1
    `, [schemaName]);
    const boundary = result?.rows?.[0];
    if (result?.rowCount !== 1
      || result.rows.length !== 1
      || boundary.currentUser !== expectedRole
      || boundary.sessionUser !== expectedRole
      || boundary.schemaOwner !== expectedRole
      || boundary.superuser !== false
      || boundary.createRole !== false
      || boundary.createDatabase !== false
      || boundary.bypassRowSecurity !== false
      || boundary.replication !== false
      || boundary.membershipCount !== 0) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "PostgreSQL migration role and schema ownership boundary is invalid.",
      );
    }
  }

  async function ensureHistoryLedger(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${historyRelation} (
        "manifest_id" text NOT NULL,
        "position" integer NOT NULL,
        "migration_id" text NOT NULL,
        "fingerprint" text NOT NULL,
        "implementation_fingerprint" text NOT NULL,
        "implementation_contract_json" jsonb NOT NULL,
        "contract_version" integer NOT NULL,
        "applied_at" timestamp with time zone NOT NULL,
        CONSTRAINT persistence_migration_history_pkey
          PRIMARY KEY ("manifest_id", "migration_id"),
        CONSTRAINT persistence_migration_history_manifest_position_key
          UNIQUE ("manifest_id", "position"),
        CONSTRAINT persistence_migration_history_position_check
          CHECK ("position" >= 0),
        CONSTRAINT persistence_migration_history_fingerprint_check
          CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
        CONSTRAINT persistence_migration_history_impl_fingerprint_check
          CHECK ("implementation_fingerprint" ~ '^[a-f0-9]{64}$'),
        CONSTRAINT persistence_migration_history_contract_version_check
          CHECK ("contract_version" = ${MIGRATION_CONTRACT_VERSION})
      )
    `);

    const relationResult = await client.query(`
      SELECT
        c.relkind,
        c.relpersistence,
        c.relrowsecurity,
        c.relforcerowsecurity,
        (
          SELECT count(*)::integer
          FROM pg_catalog.pg_trigger AS trigger
          WHERE trigger.tgrelid = c.oid
            AND NOT trigger.tgisinternal
        ) AS user_trigger_count
      FROM pg_catalog.pg_class AS c
      INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
    `, [schemaName, HISTORY_TABLE]);
    const relation = relationResult.rows[0];
    if (relationResult.rowCount !== 1
      || relation.relkind !== "r"
      || relation.relpersistence !== "p"
      || relation.relrowsecurity !== false
      || relation.relforcerowsecurity !== false
      || relation.user_trigger_count !== 0) {
      throw migrationError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "PostgreSQL migration history has an incompatible relation.",
      );
    }

    const columnsResult = await client.query(`
      SELECT
        attribute.attname AS name,
        pg_catalog.format_type(
          attribute.atttypid,
          attribute.atttypmod
        ) AS type,
        attribute.attnotnull AS "notNull",
        (default_value.oid IS NOT NULL) AS "hasDefault"
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      INNER JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = relation.oid
       AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = $1
        AND relation.relname = $2
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `, [schemaName, HISTORY_TABLE]);
    if (JSON.stringify(columnsResult.rows)
      !== JSON.stringify(EXPECTED_LEDGER_COLUMNS)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "PostgreSQL migration history has incompatible columns.",
      );
    }

    const constraintsResult = await client.query(`
      SELECT
        ledger_constraint.conname AS name,
        ledger_constraint.contype AS type,
        COALESCE(
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(ledger_constraint.conkey)
              WITH ORDINALITY AS constraint_key(attnum, ordinal_position)
            INNER JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = ledger_constraint.conrelid
             AND attribute.attnum = constraint_key.attnum
            ORDER BY constraint_key.ordinal_position
          ),
          ARRAY[]::text[]
        ) AS columns,
        CASE
          WHEN ledger_constraint.contype = 'c'
          THEN pg_catalog.pg_get_expr(
            ledger_constraint.conbin,
            ledger_constraint.conrelid,
            true
          )
          ELSE NULL
        END AS expression
      FROM pg_catalog.pg_constraint AS ledger_constraint
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = ledger_constraint.conrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = $2
        AND ledger_constraint.contype <> 'n'
      ORDER BY ledger_constraint.conname
    `, [schemaName, HISTORY_TABLE]);
    const constraints = {};
    for (const constraint of constraintsResult.rows) {
      constraints[constraint.name] = {
        type: constraint.type,
        columns: constraint.columns,
        expression: constraint.type === "c"
          ? canonicalCheckExpression(constraint.expression)
          : null,
      };
    }
    const expectedConstraintNames = Object.keys(
      EXPECTED_LEDGER_CONSTRAINTS,
    ).sort();
    if (JSON.stringify(Object.keys(constraints).sort())
        !== JSON.stringify(expectedConstraintNames)
      || expectedConstraintNames.some((name) => (
        JSON.stringify(constraints[name])
          !== JSON.stringify(EXPECTED_LEDGER_CONSTRAINTS[name])
      ))) {
      throw migrationError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "PostgreSQL migration history has incompatible constraints.",
      );
    }
  }

  function assertActive(active) {
    if (!active.value) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        "PostgreSQL migration session is no longer active.",
      );
    }
  }

  function createSession(client, active) {
    async function internalHistory(manifestId) {
      const result = await client.query(`
        SELECT
          "position",
          "migration_id",
          "fingerprint",
          "implementation_fingerprint",
          "implementation_contract_json",
          "contract_version"
        FROM ${historyRelation}
        WHERE "manifest_id" = $1
        ORDER BY "position"
      `, [manifestId]);
      for (let position = 0; position < result.rows.length; position += 1) {
        const row = result.rows[position];
        if (!Number.isSafeInteger(row.position)
          || row.position !== position
          || !IDENTIFIER_PATTERN.test(String(row.migration_id || ""))
          || !FINGERPRINT_PATTERN.test(String(row.fingerprint || ""))
          || !FINGERPRINT_PATTERN.test(
            String(row.implementation_fingerprint || ""),
          )
          || row.contract_version !== MIGRATION_CONTRACT_VERSION) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "PostgreSQL migration history is not a contiguous supported chain.",
          );
        }
        const contract = normalizedStoredImplementationContract(
          registry,
          row.implementation_contract_json,
        );
        if (implementationContractFingerprint(contract)
          !== row.implementation_fingerprint) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "PostgreSQL migration history implementation fingerprint drifted.",
          );
        }
      }
      return result.rows;
    }

    async function readAppliedMigrations(manifestId) {
      assertActive(active);
      if (typeof manifestId !== "string"
        || !IDENTIFIER_PATTERN.test(manifestId)) {
        throw migrationError(
          MIGRATION_ERROR_CODES.ADAPTER_INVALID,
          "PostgreSQL migration manifest id is invalid.",
        );
      }
      const rows = await internalHistory(manifestId);
      assertActive(active);
      return Object.freeze(rows.map((row) => Object.freeze({
        id: row.migration_id,
        fingerprint: row.fingerprint,
      })));
    }

    async function executeMigrationStep(options = {}) {
      assertActive(active);
      exactKeys(
        options,
        [
          "context",
          "contractVersion",
          "direction",
          "manifestId",
          "migration",
          "operationIds",
        ],
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        "PostgreSQL migration step",
      );
      const {
        contractVersion,
        direction,
        manifestId,
        migration,
        operationIds,
      } = options;
      if (contractVersion !== MIGRATION_CONTRACT_VERSION
        || typeof manifestId !== "string"
        || !IDENTIFIER_PATTERN.test(manifestId)
        || !isPlainRecord(migration)
        || !Number.isSafeInteger(migration.position)
        || migration.position < 0
        || !IDENTIFIER_PATTERN.test(String(migration.id || ""))
        || !FINGERPRINT_PATTERN.test(String(migration.fingerprint || ""))
        || !Array.isArray(migration.operations)
        || !(migration.rollbackOperations === null
          || Array.isArray(migration.rollbackOperations))
        || !["apply", "rollback"].includes(direction)
        || !Array.isArray(operationIds)) {
        throw migrationError(
          MIGRATION_ERROR_CODES.EXECUTION_INVALID,
          "PostgreSQL migration step is invalid.",
        );
      }
      const expectedOperationIds = direction === "apply"
        ? migration.operations
        : migration.rollbackOperations;
      if (!Array.isArray(expectedOperationIds)
        || JSON.stringify(operationIds)
          !== JSON.stringify(expectedOperationIds)) {
        throw migrationError(
          MIGRATION_ERROR_CODES.EXECUTION_INVALID,
          "PostgreSQL migration operations do not match the manifest.",
        );
      }
      const currentImplementationContract = implementationContract(
        registry,
        migration,
      );
      const currentImplementationFingerprint =
        implementationContractFingerprint(currentImplementationContract);
      const boundOperations = operationIds.map((operationId) => ({
        operationId,
        operation: registry.get(operationId),
      }));
      const history = await internalHistory(manifestId);
      if (direction === "apply") {
        if (history.length !== migration.position) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "PostgreSQL migration apply position does not follow history.",
          );
        }
      } else {
        const current = history.at(-1);
        if (!current
          || current.position !== migration.position
          || current.migration_id !== migration.id
          || current.fingerprint !== migration.fingerprint
          || current.implementation_fingerprint
            !== currentImplementationFingerprint) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "PostgreSQL migration rollback does not match current history.",
          );
        }
      }

      for (const { operation } of boundOperations) {
        await executeOperationArtifact(client, operation);
      }

      if (direction === "apply") {
        await client.query(`
          INSERT INTO ${historyRelation} (
            "manifest_id",
            "position",
            "migration_id",
            "fingerprint",
            "implementation_fingerprint",
            "implementation_contract_json",
            "contract_version",
            "applied_at"
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, pg_catalog.clock_timestamp())
        `, [
          manifestId,
          migration.position,
          migration.id,
          migration.fingerprint,
          currentImplementationFingerprint,
          JSON.stringify(currentImplementationContract),
          contractVersion,
        ]);
      } else {
        const result = await client.query(`
          DELETE FROM ${historyRelation}
          WHERE "manifest_id" = $1
            AND "position" = $2
            AND "migration_id" = $3
            AND "fingerprint" = $4
            AND "implementation_fingerprint" = $5
        `, [
          manifestId,
          migration.position,
          migration.id,
          migration.fingerprint,
          currentImplementationFingerprint,
        ]);
        if (result.rowCount !== 1) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "PostgreSQL migration rollback could not remove its history row.",
          );
        }
      }
      assertActive(active);
    }

    return Object.freeze({
      executeMigrationStep,
      readAppliedMigrations,
    });
  }

  async function transactionRun(work) {
    let client;
    let sessionLockHeld = false;
    let transactionStarted = false;
    let active = null;
    let result;
    let primaryError = null;
    let releaseDamage;
    const cleanupErrors = [];
    try {
      client = await pool.connect();
      if (!client || typeof client.query !== "function"
        || typeof client.release !== "function") {
        throw migrationError(
          MIGRATION_ERROR_CODES.ADAPTER_INVALID,
          "PostgreSQL pool returned an invalid client.",
        );
      }
      await client.query(
        "SELECT pg_catalog.pg_advisory_lock($1::bigint)",
        [lockKey],
      );
      sessionLockHeld = true;
      await client.query(
        "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
      );
      transactionStarted = true;
      await ensureExecutionBoundary(client);
      await client.query(
        `SET LOCAL search_path TO ${quotedSchema}, pg_catalog`,
      );
      await ensureHistoryLedger(client);
      active = { value: true };
      result = await work(createSession(client, active));
      active.value = false;
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (active) active.value = false;
      primaryError = error;
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError);
          releaseDamage = rollbackError;
        }
      }
    }
    if (client && sessionLockHeld) {
      try {
        const unlock = await client.query(
          "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked",
          [lockKey],
        );
        if (unlock.rowCount !== 1 || unlock.rows[0]?.unlocked !== true) {
          throw migrationError(
            MIGRATION_ERROR_CODES.ADAPTER_INVALID,
            "PostgreSQL migration advisory lock could not be released.",
          );
        }
        sessionLockHeld = false;
      } catch (unlockError) {
        cleanupErrors.push(unlockError);
        releaseDamage = unlockError;
      }
    }
    if (client && typeof client.release === "function") {
      try {
        client.release(releaseDamage);
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    if (primaryError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "PostgreSQL migration run and connection cleanup both failed.",
      );
    }
    if (primaryError) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "PostgreSQL migration connection cleanup failed.",
      );
    }
    return result;
  }

  function runExclusive(work) {
    if (typeof work !== "function") {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "PostgreSQL migration session callback is required.",
      );
    }
    return transactionRun(work);
  }

  return Object.freeze({
    providerId: "postgresql",
    status: "development-contract",
    expectedRole,
    schemaName,
    applicationMigrationsImplemented: 0,
    productActivation: false,
    concurrencyContract: Object.freeze({
      lockFunction: "pg_advisory_lock",
      lockScope: "session-before-transaction",
      rationale: "fresh-serializable-snapshot-after-lock-wait",
      retry: false,
    }),
    securityBoundary: Object.freeze({
      artifactExecution: "adapter-owned-versioned-sql-bundle",
      artifactFingerprint: "sha256-canonical-json-v1",
      explicitSchemaQualification: "rejected",
      inheritedRoles: "rejected",
      ledgerAccessFromArtifacts: "rejected",
      roleRequirement: "dedicated-least-privilege-schema-role",
      superuserRequired: false,
    }),
    runExclusive,
  });
}

module.exports = {
  createPostgresqlMigrationAdapter,
};
