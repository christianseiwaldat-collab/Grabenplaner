"use strict";

// Reuse the already qualified Core fixture's complete organizational seed.
// Its SQL is collected as parameterized PostgreSQL commands; no SQLite database
// is opened and no application integrity trigger is replaced or disabled.
const { seedCoreFixture } = require("./sqlite-source");
const employee = (personnelNumber, fullName = "Synthetic upgrade actor") => ({
  sql: "INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id,preferred_department_id,position_id,cost_center_id,active) VALUES($1,$2,'Synthetic','18',1,'verkaufsmitarbeiter','cc18',1)",
  values: [personnelNumber, fullName],
});
function seed({ principal, organizationId, passwordHash }) {
  const commands = [];
  seedCoreFixture({
    exec(sql) { if (!["BEGIN", "COMMIT"].includes(sql)) throw Error("PASSKEY_FIXTURE_SEED_CONTROL"); },
    prepare(sql) { return { run(...values) {
      let index = 0;
      commands.push({ sql: sql.replace(/^INSERT INTO /, "INSERT INTO gp.").replace(/\?/g, () => "$" + (++index)), values });
    } }; },
  }, 0);
  return [
    { sql: "INSERT INTO gp.settings(key,value) VALUES('migration-test-owner',$1)", values: [principal] },
    ...commands,
    { sql: "INSERT INTO gp.portal_roles(id,name,permissions) VALUES($1,'Synthetic passkey upgrade role','[]')", values: [principal] },
    employee(principal),
    { sql: "INSERT INTO gp.portal_users(employee_number,password_hash,role,active,must_change_password,password_policy_version) VALUES($1,$2,$1,1,0,1)", values: [principal, passwordHash] },
    { sql: "INSERT INTO gp.portal_organization_accounts(id,login_name,display_name,password_hash,active,must_change_password,password_policy_version) VALUES($1,$2,'Synthetic upgrade organization',$3,1,0,1)", values: [organizationId, principal + "-organization", passwordHash] },
    { sql: "INSERT INTO gp.portal_organization_account_scopes(account_id,location_id,department_id) VALUES($1,'18',0)", values: [organizationId] },
    { sql: "INSERT INTO gp.portal_organization_account_permissions(account_id,permission) VALUES($1,'schedule:location:view')", values: [organizationId] },
  ];
}
module.exports = { seed, employee };
