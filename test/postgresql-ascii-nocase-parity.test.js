"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeAsciiNoCaseComparisons } = require("../lib/persistence/postgresql/core/ascii-nocase-comparisons");
const { ORGANIZATION_PERSONNEL_STATEMENTS: organization } = require("../lib/persistence/statements/organization-personnel");
const { PORTAL_ACCESS_STATEMENTS: portal } = require("../lib/persistence/statements/portal-access");
const { INTEGRATION_RUNTIME_STATEMENTS: integration } = require("../lib/persistence/statements/integration-runtime");

test("four actual PostgreSQL catalog comparisons retain historical ASCII NOCASE lookup and login semantics", {
  skip: !process.env.GP_CORE_MIGRATOR_URL,
}, async () => {
  const { withCoreFixture } = require("../test-support/postgresql-migration/core-fixture");
  await withCoreFixture(async fixture => {
    // The same synthetic records enter both engines. The current application
    // statements and their normal providers perform every lookup below.
    const seed = `
      INSERT INTO cost_centers(id,code,name,type,cost_center_type_id)
      VALUES('ascii-case-center','FiL-Test','Synthetic case center','branch','branch');
      INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,created_at)
      VALUES('CaseFold-ABC','Synthetic lookup person','Synthetic','18','cc18','2020-02-29 10:00:00');
      INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,
        created_at,updated_at)
      VALUES('ascii-case-account','CaseFold-Login','Synthetic case account','branch','synthetic-hash',1,
        '2020-02-29 10:00:00','2020-02-29 10:00:00');
    `;
    fixture.sqlite.exec(seed);
    await fixture.migrator.query("BEGIN");
    await fixture.migrator.query("SET LOCAL ROLE gp_core_owner");
    await fixture.migrator.query("SET LOCAL search_path=pg_catalog,gp");
    try {
      await fixture.migrator.query(seed);
      await fixture.migrator.query("COMMIT");
    } catch (error) {
      await fixture.migrator.query("ROLLBACK");
      throw error;
    }
    async function parity(statement, parameters, present) {
      const expected = await fixture.sqliteProvider[statement.operation](statement, parameters);
      const actual = await fixture.postgres[statement.operation](statement, parameters);
      assert.deepEqual(actual, expected, statement.id + " " + JSON.stringify(parameters));
      assert.equal(statement.operation === "queryAll" ? actual.length > 0 : actual !== null,
        present, statement.id + ": expected match state");
      return actual;
    }
    for (const code of ["FiL-Test", "fil-test", "FIL-TEST", "fIl-tEsT"]) {
      assert.equal((await parity(organization.findCostCenterIdByCode, { code }, true)).id, "ascii-case-center");
    }
    await parity(organization.findCostCenterIdByCode, { code: "missing-code" }, false);
    for (const loginName of ["CaseFold-Login", "casefold-login", "CASEFOLD-LOGIN"]) {
      assert.equal((await parity(organization.organizationAccountLoginCollision, { loginName }, true)).found, true);
      const login = await parity(portal.getOrganizationLogin, { payload: { loginName } }, true);
      assert.equal(login.data.account_id, "ascii-case-account");
      assert.equal(login.data.employee_number, "CaseFold-Login");
    }
    for (const loginName of ["CaseFold-ABC", "casefold-abc", "CASEFOLD-ABC"]) {
      await parity(organization.organizationAccountLoginCollision, { loginName }, true);
    }
    await parity(organization.organizationAccountLoginCollision, { loginName: "missing-login" }, false);
    await parity(portal.getOrganizationLogin, { payload: { loginName: "missing-login" } }, false);
    for (const personnelNumber of ["CaseFold-ABC", "casefold-abc", "CASEFOLD-ABC"]) {
      const rows = await parity(integration.listEmployeeImportRowsCaseInsensitive, { payload: { personnelNumber } }, true);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].data.personnel_number, "CaseFold-ABC");
    }
    await parity(integration.listEmployeeImportRowsCaseInsensitive, { payload: { personnelNumber: "missing-person" } }, false);

    // SQLite NOCASE deliberately folds ASCII only. Keep non-ASCII distinctions
    // and SQL NULL behavior, rather than broadening authentication equivalence.
    for (const [left, right, expected] of [
      ["FIL01", "fil01", 1], ["I", "i", 1], ["A'B", "a'b", 1],
      ["Ä", "ä", 0], ["ß", "SS", 0], ["İ", "i", 0], [null, "A", null], [null, null, null],
    ]) {
      const old = fixture.sqlite.prepare("SELECT ? = ? COLLATE NOCASE AS matched").get(left, right).matched;
      const sql = normalizeAsciiNoCaseComparisons("SELECT $1 = $2 COLLATE NOCASE AS matched");
      const current = (await fixture.migrator.query(sql, [left, right])).rows[0].matched;
      assert.equal(old, expected);
      assert.equal(current === null ? null : Number(current), expected);
    }
  });
});
