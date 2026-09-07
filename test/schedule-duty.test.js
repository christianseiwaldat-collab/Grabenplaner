"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { defaultScheduleDutyCode, resolveScheduleDuty, departmentDutyCode } = require("../public/schedule-duty");

test("Filialaufsicht defaults follow positions, not employee numbers or app roles", () => {
  for (const position_id of ["teamleitung", "fl-stellvertretung"]) {
    assert.equal(defaultScheduleDutyCode({ position_id, personnel_number: "synthetic-other" }), "branch_supervision");
    assert.equal(resolveScheduleDuty({}, { position_id }).code, "FL");
  }
  for (const position_id of ["abteilungsleitung", "verkaufsmitarbeiter", "", undefined]) {
    assert.equal(defaultScheduleDutyCode({ position_id, personnel_number: "252", role: "developer" }), "general");
  }
});

test("manual departments and general duties override supervision defaults", () => {
  const leader = { position_id: "teamleitung", preferred_department_id: 11 };
  assert.deepEqual(resolveScheduleDuty({ department_id: 22, department_name: "Fotowelt" }, leader), {
    code: "FO", label: "Fotowelt", kind: "department", departmentId: 22,
  });
  assert.equal(resolveScheduleDuty({ duty_code: "general" }, leader).code, "AG");
  assert.equal(resolveScheduleDuty({ duty_code: "branch_supervision" }, { position_id: "abteilungsleitung" }).code, "FL");
  assert.equal(resolveScheduleDuty({}, leader).code, "FL");
});

test("duty labels resolve genuine department identifiers without hardcoding ids", () => {
  assert.equal(resolveScheduleDuty({ dutyCode: "department", departmentId: "99" }, {}, [{ id: 99, name: "Hardware" }]).code, "HW");
  assert.equal(resolveScheduleDuty({ department_id: 777 }, {}, [{ id: 777, name: "Fotowelt" }]).code, "FO");
  assert.equal(resolveScheduleDuty({ department_id: 81 }).label, "Abteilung 81");
  assert.equal(departmentDutyCode("Service und Reparatur"), "SUR");
  assert.equal(departmentDutyCode("Büro"), "BU");
  assert.equal(resolveScheduleDuty({ duty_code: "unknown" }, { position_id: "teamleitung" }).kind, "general");
});

test("shared browser and server resolver have identical, non-mutating behavior", () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/schedule-duty.js"), "utf8"), context);
  const employee = Object.freeze({ positionId: "fl-stellvertretung" });
  const shift = Object.freeze({ departmentId: "88", departmentName: "Fotowelt", dutyCode: "department" });
  assert.equal(JSON.stringify(context.GPScheduleDuty.resolveScheduleDuty(shift, employee)), JSON.stringify(resolveScheduleDuty(shift, employee)));
  assert.equal(context.GPScheduleDuty.defaultScheduleDutyCode(employee), "branch_supervision");
});
