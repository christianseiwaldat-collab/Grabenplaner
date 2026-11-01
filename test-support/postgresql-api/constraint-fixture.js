"use strict";

// One reviewed corrupted legacy row for the current DTO authorization test.
// The exact native permission CHECK is immediately restored as NOT VALID;
// it still validates every new write. Cleanup removes the synthetic old row
// and validates the original constraint over the complete table again.
const assert = require("node:assert/strict");
const constraint = "portal_permission_scope_grants_permission_check";
const table = 'gp."portal_permission_scope_grants"';
const name = '"' + constraint + '"';
function permissionCheck(db) {
  const rows = db.postgresqlCatalogQuery("core", `SELECT c.conname AS name,
    c.convalidated AS validated,pg_catalog.pg_get_constraintdef(c.oid) AS definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='gp.portal_permission_scope_grants'::regclass AND c.contype='c'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute
        WHERE attrelid=c.conrelid AND attname='permission')]`);
  assert.equal(rows.length, 1); assert.equal(rows[0].name, constraint);
  return rows[0];
}
function installLegacyLearningScopeFixture(db, employeeNumber, locationId) {
  assert.equal(db.postgresqlTestFixture, true);
  const before = permissionCheck(db);
  assert.equal(before.validated, true);
  assert.equal(db.prepare(`SELECT 1 FROM portal_permission_scope_grants
    WHERE employee_number=? AND permission='personnel:learning:assignments:write'
      AND location_id=? AND department_id=0`).get(employeeNumber, locationId), undefined);
  const remove = () => db.prepare(`DELETE FROM portal_permission_scope_grants
    WHERE employee_number=? AND permission='personnel:learning:assignments:write'
      AND location_id=? AND department_id=0`).run(employeeNumber, locationId);
  const validate = () => {
    db.postgresqlFixtureDdl("core", "ALTER TABLE " + table + " VALIDATE CONSTRAINT " + name);
    const after = permissionCheck(db);
    assert.equal(after.validated, true); assert.equal(after.definition, before.definition);
  };
  db.postgresqlFixtureDdl("core", "ALTER TABLE " + table + " DROP CONSTRAINT " + name);
  try {
    try {
      db.prepare(`INSERT INTO portal_permission_scope_grants
        (employee_number,permission,location_id,department_id,approved_by)
        VALUES(?,'personnel:learning:assignments:write',?,0,'101')`).run(employeeNumber, locationId);
    } finally {
      db.postgresqlFixtureDdl("core", "ALTER TABLE " + table + " ADD CONSTRAINT " + name + " " + before.definition + " NOT VALID");
    }
    assert.equal(permissionCheck(db).validated, false);
  } catch (error) { remove(); validate(); throw error; }
  let removed = false;
  return () => { if (!removed) { remove(); validate(); removed = true; } };
}
module.exports = { installLegacyLearningScopeFixture, permissionCheck };
