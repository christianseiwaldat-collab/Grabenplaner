"use strict";

const { createHash } = require("node:crypto");

const MIGRATION_CONTRACT_VERSION = 1;
const MIGRATION_ERROR_CODES = Object.freeze({
  DEFINITION_INVALID: "MIGRATION_DEFINITION_INVALID",
  HISTORY_INVALID: "MIGRATION_HISTORY_INVALID",
  TARGET_INVALID: "MIGRATION_TARGET_INVALID",
  ROLLBACK_UNAVAILABLE: "MIGRATION_ROLLBACK_UNAVAILABLE",
  ADAPTER_INVALID: "MIGRATION_ADAPTER_INVALID",
  OPERATION_UNAVAILABLE: "MIGRATION_OPERATION_UNAVAILABLE",
  EXECUTION_INVALID: "MIGRATION_EXECUTION_INVALID",
});

const MANIFESTS = new WeakSet();
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

class MigrationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationContractError";
    this.code = code;
  }
}

function migrationError(code, message) {
  return new MigrationContractError(code, message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      `${label} must be a plain object.`,
    );
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      `${label} contains unsupported fields.`,
    );
  }
}

function normalizedIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      `${label} is not a stable migration identifier.`,
    );
  }
  return value;
}

function normalizedDescription(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 240 || value.includes("\0")) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      "Migration descriptions must be short plain text.",
    );
  }
  return value;
}

function normalizedOperations(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      `${label} must be a non-empty operation-id list.`,
    );
  }
  const operations = value.map((entry) => normalizedIdentifier(entry, label));
  if (new Set(operations).size !== operations.length) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      `${label} contains duplicate operation ids.`,
    );
  }
  return Object.freeze(operations);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertMigrationManifest(manifest) {
  if (!MANIFESTS.has(manifest)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      "A migration manifest created by defineMigrationManifest is required.",
    );
  }
  return manifest;
}

function defineMigrationManifest(options = {}) {
  exactKeys(options, ["id", "migrations"], "Migration manifest");
  const manifestId = normalizedIdentifier(options.id, "Manifest id");
  if (!Array.isArray(options.migrations) || options.migrations.length === 0) {
    throw migrationError(
      MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      "A migration manifest needs at least one migration.",
    );
  }

  const ids = new Set();
  const migrations = options.migrations.map((entry, position) => {
    exactKeys(
      entry,
      ["id", "description", "operations", "rollbackOperations"],
      `Migration at position ${position}`,
    );
    const id = normalizedIdentifier(entry.id, "Migration id");
    if (ids.has(id)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.DEFINITION_INVALID,
        `Migration id ${id} is duplicated.`,
      );
    }
    ids.add(id);
    const operations = normalizedOperations(entry.operations, `${id}.operations`);
    const rollbackOperations = entry.rollbackOperations === undefined
      ? null
      : normalizedOperations(
        entry.rollbackOperations,
        `${id}.rollbackOperations`,
        { nullable: true },
      );
    const normalized = {
      id,
      description: normalizedDescription(entry.description),
      position,
      operations,
      rollbackOperations,
    };
    return Object.freeze({
      ...normalized,
      fingerprint: fingerprint({
        contractVersion: MIGRATION_CONTRACT_VERSION,
        manifestId,
        ...normalized,
      }),
    });
  });

  const manifest = Object.freeze({
    contractVersion: MIGRATION_CONTRACT_VERSION,
    id: manifestId,
    migrations: Object.freeze(migrations),
    fingerprint: fingerprint({
      contractVersion: MIGRATION_CONTRACT_VERSION,
      id: manifestId,
      migrations: migrations.map((migration) => ({
        id: migration.id,
        position: migration.position,
        fingerprint: migration.fingerprint,
      })),
    }),
  });
  MANIFESTS.add(manifest);
  return manifest;
}

function normalizedAppliedHistory(manifest, appliedMigrations) {
  if (!Array.isArray(appliedMigrations)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.HISTORY_INVALID,
      "Applied migration history must be an ordered list.",
    );
  }
  if (appliedMigrations.length > manifest.migrations.length) {
    throw migrationError(
      MIGRATION_ERROR_CODES.HISTORY_INVALID,
      "Applied migration history is longer than its manifest.",
    );
  }
  const normalized = appliedMigrations.map((entry, position) => {
    if (!isPlainRecord(entry)
      || Object.keys(entry).some((key) => !["id", "fingerprint"].includes(key))
      || typeof entry.id !== "string"
      || typeof entry.fingerprint !== "string"
      || !FINGERPRINT_PATTERN.test(entry.fingerprint)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "Applied migration history contains an invalid entry.",
      );
    }
    const expected = manifest.migrations[position];
    if (entry.id !== expected.id || entry.fingerprint !== expected.fingerprint) {
      throw migrationError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "Applied migration history is not an unchanged manifest prefix.",
      );
    }
    return Object.freeze({
      id: entry.id,
      fingerprint: entry.fingerprint,
    });
  });
  return Object.freeze(normalized);
}

function createMigrationPlan(options = {}) {
  exactKeys(
    options,
    ["manifest", "appliedMigrations", "targetId"],
    "Migration plan options",
  );
  const manifest = assertMigrationManifest(options.manifest);
  const appliedMigrations = normalizedAppliedHistory(
    manifest,
    options.appliedMigrations ?? [],
  );
  const hasTarget = Object.hasOwn(options, "targetId");
  let targetPosition;
  if (!hasTarget) {
    targetPosition = manifest.migrations.length - 1;
  } else if (options.targetId === null) {
    targetPosition = -1;
  } else {
    if (typeof options.targetId !== "string") {
      throw migrationError(
        MIGRATION_ERROR_CODES.TARGET_INVALID,
        "Migration target must be a manifest id or null.",
      );
    }
    targetPosition = manifest.migrations.findIndex(
      (migration) => migration.id === options.targetId,
    );
    if (targetPosition < 0) {
      throw migrationError(
        MIGRATION_ERROR_CODES.TARGET_INVALID,
        "Migration target does not belong to the manifest.",
      );
    }
  }

  const currentPosition = appliedMigrations.length - 1;
  const steps = [];
  let kind = "noop";
  if (targetPosition > currentPosition) {
    kind = appliedMigrations.length === 0 ? "rebuild" : "upgrade";
    for (let position = currentPosition + 1; position <= targetPosition; position += 1) {
      steps.push(Object.freeze({
        direction: "apply",
        migration: manifest.migrations[position],
      }));
    }
  } else if (targetPosition < currentPosition) {
    kind = "rollback";
    for (let position = currentPosition; position > targetPosition; position -= 1) {
      const migration = manifest.migrations[position];
      if (migration.rollbackOperations === null) {
        throw migrationError(
          MIGRATION_ERROR_CODES.ROLLBACK_UNAVAILABLE,
          `Migration ${migration.id} has no rollback operations.`,
        );
      }
      steps.push(Object.freeze({
        direction: "rollback",
        migration,
      }));
    }
  }

  return Object.freeze({
    manifestId: manifest.id,
    manifestFingerprint: manifest.fingerprint,
    kind,
    currentId: currentPosition < 0 ? null : manifest.migrations[currentPosition].id,
    targetId: targetPosition < 0 ? null : manifest.migrations[targetPosition].id,
    steps: Object.freeze(steps),
  });
}

module.exports = {
  MIGRATION_CONTRACT_VERSION,
  MIGRATION_ERROR_CODES,
  MigrationContractError,
  assertMigrationManifest,
  createMigrationPlan,
  defineMigrationManifest,
};
