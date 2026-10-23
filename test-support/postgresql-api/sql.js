"use strict";

// Test seed/assertion SQL only. Application requests continue through the real,
// catalog-bound PostgreSQL provider. Unknown cross-database seed joins fail.
const S = require("../../lib/persistence/postgresql/core/sql");
const layout = require("../../lib/persistence/postgresql/sales/layout");
const inventory = require("../../lib/persistence/postgresql/contracts/block-1-inventory.json");
const sales = new Set(inventory.tables.filter(t => t.database === "sales").map(t => t.name));
for (const name of ["import_history_snapshots", "import_history_snapshot_members"]) sales.add(name);
const core = new Set(inventory.tables.filter(t => t.database === "core").map(t => t.name));

function translate(sql, values = []) {
  const tokens = S.tokens(String(sql));
  let index = 0;
  const parameters = [];
  const named = values.length === 1 && values[0] && typeof values[0] === "object"
    && !Buffer.isBuffer(values[0]) && !ArrayBuffer.isView(values[0]) ? values[0] : null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "?") { parameters.push(values[index++]); tokens[i] = "$" + parameters.length; }
    else if (/^[$:@][A-Za-z_][A-Za-z_0-9]*$/.test(tokens[i])) {
      const key = tokens[i].slice(1);
      if (!named || !Object.hasOwn(named, key)) throw new Error("PG_TEST_NAMED_PARAMETER_REQUIRED: " + key);
      parameters.push(named[key]); tokens[i] = "$" + parameters.length;
    }
  }
  if (!named && index !== values.length) throw new Error("PG_TEST_PARAMETER_COUNT");
  const relations = new Set();
  // Only relation positions affect routing. A column/alias named 'settings'
  // must not change the selected database.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (["FROM", "JOIN", "INTO", "UPDATE", "TABLE"].includes(tokens[i].toUpperCase())) {
      if (tokens[i].toUpperCase() === "UPDATE" && tokens[i - 1]?.toUpperCase() === "DO") continue;
      let j = i + 1;
      if (tokens[j]?.toUpperCase() === "IF") j += 3;
      const name = S.name(tokens[j + 1] === "." ? tokens[j + 2] : tokens[j]);
      if (name) relations.add(name);
    }
  }
  const touchesSales = [...relations].some(name => sales.has(name));
  const touchesCore = [...relations].some(name => core.has(name) && !sales.has(name));
  if (touchesSales && touchesCore) throw new Error("PG_TEST_MIXED_DATABASE_SEED: " + [...relations].join(","));
  const domain = touchesSales ? "sales" : "core";
  const legacyBusinessSql = [...relations].some(name => core.has(name) || sales.has(name));
  if (legacyBusinessSql) for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toUpperCase() === "TRUE") tokens[i] = "1";
    else if (tokens[i].toUpperCase() === "FALSE") tokens[i] = "0";
  }
  let rendered = S.insertIgnore(S.text(tokens).replace(/;\s*$/, ""))
    .replace(/\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/gi, "BEGIN")
    .replace(/\bCOLLATE\s+NOCASE\b/gi, "")
    .replace(/\bAUTOINCREMENT\b/gi, "")
    .replace(/\browid\b/gi, "id");
  if (/^INSERT OR REPLACE\b/i.test(rendered)) throw new Error("PG_TEST_REPLACE_REQUIRES_EXPLICIT_UPSERT");
  if (domain === "sales") rendered = layout.qualify(rendered);
  return { sql: rendered, values: parameters, domain, relations: [...relations], legacyBusinessSql };
}

function splitStatements(sql) {
  const tokens = S.tokens(String(sql)), parts = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === ";") {
    const part = S.text(tokens.slice(start, i)).trim(); if (part) parts.push(part); start = i + 1;
  }
  const last = S.text(tokens.slice(start)).trim(); if (last) parts.push(last);
  return parts;
}

module.exports = { core, sales, splitStatements, translate };
