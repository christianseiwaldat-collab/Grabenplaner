"use strict";

// Explicit test seed helper. Current PostgreSQL constraints stay enabled; a
// location fixture supplies its own valid branch cost center before insertion.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const S = require("../../lib/persistence/postgresql/core/sql");
const schema = require("./metadata");
const types = new WeakMap();
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const supportedTypes = new Set(["text", "bigint", "integer", "smallint", "double precision", "real", "boolean", "numeric"]);

function prepareLocationFixture(db, sql) {
  assert.equal(db.postgresqlTestFixture, true, "location seeds require an owned PostgreSQL fixture");
  const tokens = S.tokens(sql);
  const into = tokens.findIndex(token => token.toUpperCase() === "INTO");
  assert.equal(tokens[0]?.toUpperCase(), "INSERT");
  assert.equal(S.name(tokens[into + 1]), "locations");
  assert.equal(tokens[into + 2], "(");
  const columnEnd = S.matching(tokens, into + 2);
  const columns = S.split(tokens.slice(into + 3, columnEnd)).map(column => {
    assert.equal(column.length, 1); return S.name(column[0]);
  });
  assert.equal(new Set(columns).size, columns.length);
  assert.ok(columns.includes("id") && !columns.includes("cost_center_id"));
  assert.equal(tokens[columnEnd + 1]?.toUpperCase(), "VALUES");
  let cursor = columnEnd + 2;
  const rows = [];
  while (tokens[cursor] === "(") {
    const end = S.matching(tokens, cursor);
    const fields = S.split(tokens.slice(cursor + 1, end));
    assert.equal(fields.length, columns.length);
    rows.push(fields); cursor = end + 1;
    if (tokens[cursor] !== ",") break;
    cursor++;
  }
  const suffix = tokens.slice(cursor).filter(token => token !== ";");
  assert.ok(!suffix.some(token => token === "?" || /^[$:@][A-Za-z_]/.test(token)), "fixture conflict clauses cannot add bind parameters");
  const replace = tokens.slice(0, into).some(token => token.toUpperCase() === "REPLACE");
  const ignore = tokens.slice(0, into).some(token => token.toUpperCase() === "IGNORE");
  assert.ok(!suffix.length || !replace && !ignore);
  return Object.freeze({
    run(...values) {
      if (!types.has(db)) types.set(db, new Map(schema.columns(db, "locations").map(column => [column.name, column.type])));
      const columnTypes = types.get(db);
      for (const name of columns) assert.ok(supportedTypes.has(columnTypes.get(name)), "unreviewed location fixture column: " + name);
      const inputs = rows.map(fields => "(" + fields.map((field, index) =>
        "CAST((" + S.text(field) + ") AS " + columnTypes.get(columns[index]) + ")").join(",") + ")").join(",");
      // PostgreSQL evaluates the original bound values and literals with the
      // real target column types. The helper never parses user data as SQL.
      const entries = db.postgresqlCatalogQuery("core", `SELECT * FROM (VALUES ${inputs}) AS fixture_values(${columns.map(quote).join(",")})`, values);
      const insertColumns = [...columns, "cost_center_id"];
      let conflict = S.text(suffix);
      if (ignore) conflict = "ON CONFLICT DO NOTHING";
      if (replace) conflict = "ON CONFLICT(id) DO UPDATE SET " + insertColumns.filter(name => name !== "id")
        .map(name => quote(name) + "=excluded." + quote(name)).join(",");
      let changes = 0;
      for (const entry of entries) {
        const identity = String(entry.id);
        const id = "fixture-location-" + identity;
        const code = "FIXTURE-" + crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
        db.prepare(`INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active)
          VALUES(?,?,?,'branch','branch',1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1`)
          .run(id, code, entry.name || "Fixture location " + identity);
        changes += db.prepare(`INSERT INTO locations(${insertColumns.map(quote).join(",")})
          VALUES(${insertColumns.map(() => "?").join(",")}) ${conflict}`)
          .run(...columns.map(name => entry[name]), id).changes;
      }
      return { changes, lastInsertRowid: 0 };
    },
  });
}

module.exports = { prepareLocationFixture };
