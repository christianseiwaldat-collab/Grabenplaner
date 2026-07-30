"use strict";

const { createHash } = require("node:crypto");
const {
  runMigrationManifest,
} = require("../lib/persistence/migrations/runner");
const {
  createSqliteMigrationAdapter,
} = require("../lib/persistence/sqlite/migrations/adapter");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function createSqliteMigrationFixture({
  manifest,
  operations,
} = {}) {
  const database = openSqliteLegacyDatabase(":memory:");
  let adapter;
  try {
    const explicitOperations = Object.fromEntries(
      Object.entries(operations || {}).map(([operationId, operation]) => {
        if (operation && typeof operation === "object" && !Array.isArray(operation)) {
          return [operationId, operation];
        }
        return [operationId, Object.freeze({
          handler: operation,
          implementationFingerprint: createHash("sha256")
            .update(JSON.stringify({
              fixtureOperationId: operationId,
              handlerSource: String(operation).replace(/\r\n?/g, "\n"),
            }))
            .digest("hex"),
        })];
      }),
    );
    adapter = createSqliteMigrationAdapter({
      database,
      operations: explicitOperations,
    });
  } catch (error) {
    database.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    adapter,
    database,
    async history() {
      return adapter.runExclusive((session) => (
        session.readAppliedMigrations(manifest.id)
      ));
    },
    migrate(options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)
        || Object.keys(options).some((key) => !["targetId", "context"].includes(key))) {
        throw new TypeError("SQLite migration fixture options are invalid.");
      }
      const runOptions = { manifest, adapter };
      if (Object.hasOwn(options, "targetId")) runOptions.targetId = options.targetId;
      if (Object.hasOwn(options, "context")) runOptions.context = options.context;
      return runMigrationManifest(runOptions);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}

module.exports = {
  createSqliteMigrationFixture,
};
