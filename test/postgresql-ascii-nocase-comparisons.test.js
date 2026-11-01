"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const S = require("../lib/persistence/postgresql/core/sql");
const { normalizeAsciiNoCaseComparisons: normalize } = require("../lib/persistence/postgresql/core/ascii-nocase-comparisons");

test("reviewed NOCASE text comparisons fold both operands without changing parameters or literals", () => {
  assert.equal(normalize("SELECT id FROM cost_centers WHERE code = ? COLLATE NOCASE"),
    'SELECT id FROM cost_centers WHERE gp . ascii_fold ( code ) COLLATE "C" = gp . ascii_fold ( ? ) COLLATE "C"');
  assert.equal(normalize("SELECT 1 WHERE account.login_name COLLATE NOCASE = json_extract($payload, '$.loginName')"),
    'SELECT 1 WHERE gp . ascii_fold ( account . login_name ) COLLATE "C" = gp . ascii_fold ( json_extract ( $payload , \'$.loginName\' ) ) COLLATE "C"');
  const sql = "SELECT 'literal COLLATE NOCASE', x FROM t WHERE x <> 'ABC' COLLATE NOCASE AND y IS NOT NULL ORDER BY x COLLATE NOCASE";
  const normalized = normalize(sql);
  assert.ok(normalized.includes("'literal COLLATE NOCASE'"));
  assert.ok(normalized.includes('gp . ascii_fold ( x ) COLLATE "C" <> gp . ascii_fold ( \'ABC\' ) COLLATE "C"'));
  assert.ok(normalized.endsWith("ORDER BY x COLLATE NOCASE"));
  assert.equal(normalize(normalized), normalized);
});

test("NOCASE ordering remains delegated to the frozen expression compiler", () => {
  const sql = "SELECT x FROM t WHERE id=? ORDER BY x COLLATE NOCASE, id";
  assert.equal(normalize(sql), S.text(S.tokens(sql)));
  assert.equal(S.expression(normalize(sql)), S.expression(sql));
});

test("comparison normalization handles explicit parentheses, both collations and null-safe operators", () => {
  assert.equal(normalize("SELECT 1 WHERE (a || b) COLLATE NOCASE = (c || d) COLLATE NOCASE"),
    'SELECT 1 WHERE gp . ascii_fold ( ( a || b ) ) COLLATE "C" = gp . ascii_fold ( ( c || d ) ) COLLATE "C"');
  assert.equal(normalize("SELECT 1 WHERE a COLLATE NOCASE IS NOT b"),
    'SELECT 1 WHERE gp . ascii_fold ( a ) COLLATE "C" IS NOT gp . ascii_fold ( b ) COLLATE "C"');
  assert.throws(() => normalize("SELECT 1 WHERE a || b = c COLLATE NOCASE"), /BOUNDED_SCALARS/);
  assert.throws(() => normalize("SELECT 1 WHERE a COLLATE BINARY = b COLLATE NOCASE"), /CONFLICTING_COLLATIONS/);
});

test("all three active branch-order equality operations fold both operands and retain their bind counts", () => {
  const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname,
    "../lib/persistence/postgresql/application-operations/branch-orders.js"), "utf8");
  const { compileOperation } = require("../lib/persistence/postgresql/application-operations/access");
  const queries = [...source.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)].map(match => match[1])
    .filter(sql => /(?:title|email)\s*=\s*(?:\?|'[^']*')\s+COLLATE NOCASE/i.test(sql));
  assert.equal(queries.length, 3, "review every active equality, rather than only copied test SQL");
  assert.deepEqual(queries.map(sql => compileOperation(sql).parameters), [2, 2, 1]);
  for (const sql of queries) {
    const compiled = compileOperation(sql);
    assert.equal((compiled.sql.match(/gp \. ascii_fold/g) || []).length, 2);
    assert.match(compiled.sql, /COLLATE "C" = gp \. ascii_fold/);
    assert.equal(compiled.write, false);
    assert.equal(compileOperation(sql).sql, compiled.sql);
  }
});
