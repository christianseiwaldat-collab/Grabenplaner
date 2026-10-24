"use strict";

// Explicit diagnostic workflow only. Never log query text, bind values, URLs,
// personal data or driver messages containing substituted database values.
require("./guard").assertSyntheticEnvironment();
if (process.env.GP_PG_API_DIAGNOSTIC !== "bounded-errors-v1") throw new Error("PG_API_DIAGNOSTIC_NOT_ENABLED");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const query = Client.prototype.query;
const emitted = new Set();
function report(error, input) {
  if (!error || emitted.size >= 96) return;
  const safe = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : null;
  const row = {
    diagnosticOnly: true, code: safe(error.code), constraint: safe(error.constraint),
    schema: safe(error.schema), table: safe(error.table),
    messageKey: typeof error.message === "string" && /^[A-Z][A-Z0-9_]{4,120}$/.test(error.message) ? error.message : null,
    sqlSha256: createHash("sha256").update(typeof input === "string" ? input : input?.text || "").digest("hex"),
  };
  const record = JSON.stringify(row);
  if (!emitted.has(record)) { emitted.add(record); process.stderr.write("PG_DIAGNOSTIC " + record + "\n"); }
}
Client.prototype.query = function(...args) {
  const input = args[0];
  const last = args.length - 1;
  if (typeof args[last] === "function") {
    const callback = args[last];
    args[last] = function(error, ...results) { report(error, input); return callback.call(this, error, ...results); };
  }
  let result;
  try { result = query.apply(this, args); }
  catch (error) { report(error, input); throw error; }
  if (result && typeof result.then === "function") result.then(undefined, error => report(error, input));
  return result;
};

// The persistence facade deliberately hides unknown adapter messages. Keep
// that production behavior and record only a hash and reviewed code locations
// in this explicitly guarded diagnostic process, before normalization.
const errors = require("../../lib/persistence/errors");
const normalize = errors.normalizePersistenceError;
const repository = path.resolve(__dirname, "../..");
const knownMessages = new Map([
  ["Core development schema contract mismatch", "CORE_SCHEMA_CONTRACT_MISMATCH"],
  ["Core boundary migration required", "CORE_BOUNDARY_MIGRATION_REQUIRED"],
  ["Isolated environment verification failed", "PG_ENVIRONMENT_MISMATCH"],
]);
const knownFrames = new Set([
  "server.js", "lib/persistence/contract.js", "lib/persistence/postgresql/provider.js",
  "lib/persistence/postgresql/boundary/migrate.js", "lib/persistence/postgresql/core/application.js",
  "lib/persistence/postgresql/boundary/application.js", "lib/persistence/postgresql/application.js",
  "lib/persistence/postgresql/read-scope.js", "lib/persistence/postgresql/application-operations/access.js",
  "lib/persistence/postgresql/boundary/transaction-activity.js",
  "lib/persistence/repositories/organization-personnel.js", "lib/persistence/repositories/portal-access.js",
  "lib/persistence/repositories/personnel-lifecycle.js", "lib/persistence/postgresql/core/catalog.js",
  "lib/persistence/postgresql/sales/catalog.js",
]);
function reportAdapter(error) {
  try {
    if (error && !errors.isPersistenceError(error) && emitted.size < 96) {
      const frames = [];
      for (const line of String(error.stack || "").split("\n")) {
        if (!/^\s+at /.test(line)) continue;
        const match = /\(?((?:[A-Za-z]:[\\/]|\/)[^()]+):([0-9]+):([0-9]+)\)?$/.exec(line);
        if (!match) continue;
        const file = path.relative(repository, path.resolve(match[1])).replaceAll("\\", "/");
        if (!knownFrames.has(file)) continue;
        frames.push({ file, line: Number(match[2]), column: Number(match[3]) });
        if (frames.length === 8) break;
      }
      const row = { diagnosticOnly: true,
        messageKey: knownMessages.get(error.message) || null,
        messageSha256: createHash("sha256").update(String(error.message || "").slice(0, 16384)).digest("hex"),
        frames };
      const record = JSON.stringify(row);
      if (!emitted.has(record)) { emitted.add(record); process.stderr.write("PG_ADAPTER_DIAGNOSTIC " + record + "\n"); }
    }
  } catch { /* An observer must never change an original failure. */ }
}
errors.normalizePersistenceError = function(error, options) {
  reportAdapter(error);
  return normalize.call(this, error, options);
};
const OriginalPersistenceError = errors.PersistenceError;
const ObservedPersistenceError = new Proxy(OriginalPersistenceError, {
  construct(target, args, newTarget) {
    try { reportAdapter(args[1]?.cause); } catch { /* Preserve constructor behavior. */ }
    return Reflect.construct(target, args, newTarget === ObservedPersistenceError ? target : newTarget);
  },
});
// Instances retain the actual original class/prototype and sanitized cause.
// Only this guarded process receives the distinct observing constructor proxy.
errors.PersistenceError = ObservedPersistenceError;
