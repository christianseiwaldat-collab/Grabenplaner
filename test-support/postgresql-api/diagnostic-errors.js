"use strict";

// Explicit diagnostic workflow only. Never log query text, bind values, URLs,
// personal data or driver messages containing substituted database values.
require("./guard").assertSyntheticEnvironment();
if (process.env.GP_PG_API_DIAGNOSTIC !== "bounded-errors-v1") throw new Error("PG_API_DIAGNOSTIC_NOT_ENABLED");
const { createHash } = require("node:crypto");
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
