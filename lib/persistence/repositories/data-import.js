"use strict";
const { assertPersistenceAccess } = require("../contract");
const { DATA_IMPORT_STATEMENTS: S } = require("../statements/data-import");
const { fail } = require("../../data-import-contract");
const REPOSITORIES = new WeakSet();
function createDataImportRepository(access) {
  assertPersistenceAccess(access);
  if (typeof access.transaction !== "function") fail("IMPORT_ATOMIC_STORAGE_REQUIRED");
  const repository = Object.freeze({
    atomic(work) {
      return access.transaction(async executor => {
        const methods = {};
        for (const [name, statement] of Object.entries(S)) methods[name] = parameters => executor[statement.operation](statement, parameters);
        methods.expectOne = async (name, parameters) => {
          const result = await methods[name](parameters);
          if (result.rowsAffected !== 1) fail("IMPORT_CONCURRENT_CHANGE", 409);
        };
        // Writers must use this exact transaction; independent connections are forbidden.
        return work(Object.freeze(methods), executor);
      }, { isolation: "serializable" });
    },
  });
  REPOSITORIES.add(repository); return repository;
}
function assertDataImportRepository(repository) { if (!REPOSITORIES.has(repository)) fail("IMPORT_STORAGE_UNTRUSTED"); return repository; }
module.exports = { createDataImportRepository, assertDataImportRepository };
