"use strict";

const {
  MIGRATION_ERROR_CODES,
  MigrationContractError,
  assertMigrationManifest,
  createMigrationPlan,
} = require("./contract");

function adapterError(message) {
  return new MigrationContractError(MIGRATION_ERROR_CODES.ADAPTER_INVALID, message);
}

function assertSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)
    || typeof session.readAppliedMigrations !== "function"
    || typeof session.executeMigrationStep !== "function") {
    throw adapterError("Migration adapter session is invalid.");
  }
}

async function runMigrationManifest(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(
      (key) => !["manifest", "adapter", "targetId", "context"].includes(key),
    )) {
    throw adapterError("Migration runner options are invalid.");
  }
  const manifest = assertMigrationManifest(options.manifest);
  const { adapter } = options;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)
    || typeof adapter.runExclusive !== "function") {
    throw adapterError("A migration adapter with runExclusive is required.");
  }

  return adapter.runExclusive(async (session) => {
    assertSession(session);
    const appliedMigrations = await session.readAppliedMigrations(manifest.id);
    const planOptions = { manifest, appliedMigrations };
    if (Object.hasOwn(options, "targetId")) planOptions.targetId = options.targetId;
    const plan = createMigrationPlan(planOptions);
    const applied = [];
    const rolledBack = [];

    for (const step of plan.steps) {
      const operationIds = step.direction === "apply"
        ? step.migration.operations
        : step.migration.rollbackOperations;
      await session.executeMigrationStep({
        contractVersion: manifest.contractVersion,
        manifestId: manifest.id,
        migration: step.migration,
        direction: step.direction,
        operationIds,
        context: options.context,
      });
      if (step.direction === "apply") applied.push(step.migration.id);
      else rolledBack.push(step.migration.id);
    }

    const finalHistory = await session.readAppliedMigrations(manifest.id);
    const verification = createMigrationPlan({
      manifest,
      appliedMigrations: finalHistory,
      targetId: plan.targetId,
    });
    if (verification.kind !== "noop") {
      throw new MigrationContractError(
        MIGRATION_ERROR_CODES.HISTORY_INVALID,
        "Migration adapter did not persist the planned target.",
      );
    }

    return Object.freeze({
      manifestId: manifest.id,
      manifestFingerprint: manifest.fingerprint,
      kind: plan.kind,
      previousId: plan.currentId,
      currentId: plan.targetId,
      applied: Object.freeze(applied),
      rolledBack: Object.freeze(rolledBack),
    });
  });
}

module.exports = {
  runMigrationManifest,
};
