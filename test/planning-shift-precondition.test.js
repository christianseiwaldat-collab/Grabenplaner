"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { canonicalPlanningShift, planningShiftRevision, assertExpectedPlanningShiftRevision } = require("../lib/planning-shift-precondition");

const fields = ["id", "employee_number", "location_id", "department_id", "duty_code", "shift_date", "start_time", "end_time", "area", "note"];
const fixture = () => ({
  id: "0007", employee_number: "434", location_id: "18", department_id: "03", duty_code: "department",
  shift_date: "2031-03-04", start_time: "09:00", end_time: "17:00", area: "Verkauf", note: "  Notiz ü  ",
});
const canonicalJson = '{"id":"7","employee_number":"434","location_id":"18","department_id":"3","duty_code":"department","shift_date":"2031-03-04","start_time":"09:00","end_time":"17:00","area":"Verkauf","note":"  Notiz ü  "}';
const canonicalHash = "f95273e1a21e349c3c8248c51277b898dc94690fb24223ea6155e2797434d5d9";
const unavailable = work => assert.throws(work, error => error.status === 503 && error.code === "SHIFT_REVISION_UNAVAILABLE");

test("canonical order and UTF-8 compact JSON determine the revision", () => {
  assert.deepEqual(Object.keys(canonicalPlanningShift(fixture())), fields);
  assert.equal(JSON.stringify(canonicalPlanningShift(fixture())), canonicalJson);
  assert.equal(planningShiftRevision(fixture()), crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex"));
  assert.equal(planningShiftRevision(fixture()), canonicalHash);
});

test("safe numeric identifiers and decimal spellings normalize to the same strings", () => {
  const row = fixture();
  assert.equal(planningShiftRevision(row), planningShiftRevision({ ...row, id: 7, department_id: 3 }));
  assert.equal(canonicalPlanningShift({ ...row, id: "9007199254740991" }).id, "9007199254740991");
});

test("nullable duty, area, note and department values remain null", () => {
  const row = { ...fixture(), department_id: null, duty_code: null, area: null, note: null };
  const canonical = canonicalPlanningShift(row);
  for (const field of ["department_id", "duty_code", "area", "note"]) assert.equal(canonical[field], null);
});

test("canonicalization neither mutates the source nor incorporates unrelated join metadata", () => {
  const row = Object.freeze({ ...fixture(), employee_full_name: "Synthetic joined label" });
  const before = JSON.stringify(row);
  assert.equal(planningShiftRevision(row), planningShiftRevision(fixture()));
  assert.equal(JSON.stringify(row), before);
  assert.equal(Object.keys(canonicalPlanningShift(row)).length, 10);
});

test("note whitespace, empty text and null are three distinct raw states", () => {
  const row = fixture();
  const revisions = [row.note, row.note.trim(), "", null].map(note => planningShiftRevision({ ...row, note }));
  assert.equal(new Set(revisions).size, 4);
});

const mutations = {
  id: 8, employee_number: "435", location_id: "11", department_id: 4, duty_code: "general",
  shift_date: "2031-03-05", start_time: "08:45", end_time: "17:15", area: "Foto", note: "Andere Notiz",
};
for (const [field, value] of Object.entries(mutations)) {
  test(`changing authoritative field ${field} changes the revision`, () => {
    const row = fixture();
    assert.notEqual(planningShiftRevision({ ...row, [field]: value }), planningShiftRevision(row));
  });
}

test("each of the ten own fields is mandatory, including a raw note value", () => {
  for (const field of fields) {
    const row = fixture();
    delete row[field];
    unavailable(() => canonicalPlanningShift(row));
    unavailable(() => planningShiftRevision(row));
  }
});

test("inherited properties and accessors cannot substitute for authoritative own data", () => {
  unavailable(() => canonicalPlanningShift(Object.create(fixture())));
  let invoked = false;
  const row = fixture();
  Object.defineProperty(row, "note", { get() { invoked = true; return "unexpected"; } });
  unavailable(() => canonicalPlanningShift(row));
  assert.equal(invoked, false);
});

test("non-row, partial and array inputs are unavailable rather than silently defaulted", () => {
  for (const row of [undefined, null, false, 7, "row", [], {}, { note: "" }]) unavailable(() => canonicalPlanningShift(row));
  const proxy = new Proxy(fixture(), { getOwnPropertyDescriptor() { throw new Error("Malformed source row"); } });
  unavailable(() => canonicalPlanningShift(proxy));
});

test("malformed, zero, fractional and unsafe numeric identifiers are unavailable", () => {
  const bad = [undefined, null, false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "", "0", "000", "-1", "+1", "1.0", "1e2", " 1", "1 ", "9007199254740992"];
  for (const value of bad) unavailable(() => canonicalPlanningShift({ ...fixture(), id: value }));
  for (const value of bad.filter(value => value !== null)) unavailable(() => canonicalPlanningShift({ ...fixture(), department_id: value }));
});

test("employee, location, date and time fields require nonempty raw strings", () => {
  for (const field of ["employee_number", "location_id", "shift_date", "start_time", "end_time"]) {
    for (const value of [undefined, null, false, 18, NaN, ""]) unavailable(() => canonicalPlanningShift({ ...fixture(), [field]: value }));
  }
});

test("nullable text fields reject all values except strings and explicit null", () => {
  for (const field of ["duty_code", "area", "note"]) {
    for (const value of [undefined, false, 0, NaN, {}, []]) unavailable(() => canonicalPlanningShift({ ...fixture(), [field]: value }));
    assert.equal(canonicalPlanningShift({ ...fixture(), [field]: "" })[field], "");
  }
});

test("an exact expected revision returns the canonical authoritative row", () => {
  const row = fixture();
  assert.deepEqual(assertExpectedPlanningShiftRevision(row, planningShiftRevision(row)), canonicalPlanningShift(row));
});

test("a valid but different expected revision is a conflict", () => {
  const row = fixture();
  assert.throws(() => assertExpectedPlanningShiftRevision({ ...row, note: "changed" }, planningShiftRevision(row)),
    error => error.status === 409 && error.code === "SHIFT_REVISION_CONFLICT");
});

test("present malformed expected revisions are invalid rather than legacy requests", () => {
  const good = planningShiftRevision(fixture());
  for (const value of [null, false, 0, {}, [], "", "a".repeat(63), "a".repeat(65), "g".repeat(64), good.toUpperCase(), good + "\n", " " + good]) {
    assert.throws(() => assertExpectedPlanningShiftRevision(fixture(), value),
      error => error.status === 400 && error.code === "SHIFT_REVISION_INVALID");
  }
});

test("an omitted revision explicitly retains the legacy request contract", () => {
  assert.equal(assertExpectedPlanningShiftRevision(fixture()), null);
  assert.equal(assertExpectedPlanningShiftRevision(undefined, undefined), null);
});
