"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MIGRATION_ERROR_CODES,
  createMigrationPlan,
  defineMigrationManifest,
} = require("../lib/persistence/migrations/contract");

function sampleManifest({
  secondOperation = "personnel.schema.v2",
  secondRollback = ["personnel.schema.v2.rollback"],
} = {}) {
  return defineMigrationManifest({
    id: "grabenplaner.application",
    migrations: [
      {
        id: "v1.personnel-baseline",
        description: "Personnel baseline",
        operations: ["personnel.schema.v1"],
        rollbackOperations: ["personnel.schema.v1.rollback"],
      },
      {
        id: "v2.personnel-number",
        description: "Stable personnel numbers",
        operations: [secondOperation],
        rollbackOperations: secondRollback,
      },
    ],
  });
}

test("Block 4/7: Migrationsmanifest bleibt providerneutral, deterministisch und tief unveraenderlich", () => {
  const first = sampleManifest();
  const second = sampleManifest();

  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(
    first.migrations.map(({ id, position }) => ({ id, position })),
    [
      { id: "v1.personnel-baseline", position: 0 },
      { id: "v2.personnel-number", position: 1 },
    ],
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.migrations), true);
  assert.equal(Object.isFrozen(first.migrations[0].operations), true);
  assert.throws(
    () => defineMigrationManifest({
      id: "invalid.sql-manifest",
      migrations: [{
        id: "v1.invalid-sql",
        operations: ["schema.invalid"],
        sql: "CREATE TABLE forbidden(id TEXT)",
      }],
    }),
    (error) => error.code === MIGRATION_ERROR_CODES.DEFINITION_INVALID,
  );
});

test("Block 4/7: Planer unterscheidet Neuaufbau, Upgrade, No-op und Rollback", () => {
  const manifest = sampleManifest();
  const rebuild = createMigrationPlan({ manifest });
  assert.equal(rebuild.kind, "rebuild");
  assert.deepEqual(
    rebuild.steps.map(({ direction, migration }) => [direction, migration.id]),
    [
      ["apply", "v1.personnel-baseline"],
      ["apply", "v2.personnel-number"],
    ],
  );

  const appliedV1 = [{
    id: manifest.migrations[0].id,
    fingerprint: manifest.migrations[0].fingerprint,
  }];
  const upgrade = createMigrationPlan({ manifest, appliedMigrations: appliedV1 });
  assert.equal(upgrade.kind, "upgrade");
  assert.deepEqual(upgrade.steps.map((step) => step.migration.id), ["v2.personnel-number"]);

  const appliedAll = manifest.migrations.map(({ id, fingerprint }) => ({ id, fingerprint }));
  assert.equal(
    createMigrationPlan({ manifest, appliedMigrations: appliedAll }).kind,
    "noop",
  );
  const rollback = createMigrationPlan({
    manifest,
    appliedMigrations: appliedAll,
    targetId: "v1.personnel-baseline",
  });
  assert.equal(rollback.kind, "rollback");
  assert.deepEqual(
    rollback.steps.map(({ direction, migration }) => [direction, migration.id]),
    [["rollback", "v2.personnel-number"]],
  );
});

test("Block 4/7: veraenderte Historie und nicht reversible Ziele scheitern geschlossen", () => {
  const original = sampleManifest();
  const changed = sampleManifest({ secondOperation: "personnel.schema.v2.changed" });
  const originalHistory = original.migrations.map(
    ({ id, fingerprint }) => ({ id, fingerprint }),
  );

  assert.throws(
    () => createMigrationPlan({
      manifest: changed,
      appliedMigrations: originalHistory,
    }),
    (error) => error.code === MIGRATION_ERROR_CODES.HISTORY_INVALID,
  );

  const irreversible = sampleManifest({ secondRollback: null });
  const irreversibleHistory = irreversible.migrations.map(
    ({ id, fingerprint }) => ({ id, fingerprint }),
  );
  assert.throws(
    () => createMigrationPlan({
      manifest: irreversible,
      appliedMigrations: irreversibleHistory,
      targetId: "v1.personnel-baseline",
    }),
    (error) => error.code === MIGRATION_ERROR_CODES.ROLLBACK_UNAVAILABLE,
  );

  assert.throws(
    () => sampleManifest({ secondRollback: [] }),
    (error) => error.code === MIGRATION_ERROR_CODES.DEFINITION_INVALID,
  );
});
