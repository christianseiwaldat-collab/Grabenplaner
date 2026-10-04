"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProtectionStatus: normalize } = require("../lib/personnel-protection-status");

const period = overrides => ({
  id: "period-01", phase: "pregnancy", confirmed: true, validFrom: "2032-01-05",
  validTo: "2032-06-30", referenceId: "hr:synthetic/01", normalDailyMinutes: 480, ...overrides,
});
const status = periods => ({ version: 1, planningEnabled: true, periods: periods || [period()] });
const invalid = callback => assert.throws(callback,
  error => error.status === 400 && error.code === "PERSONNEL_PROTECTION_STATUS_INVALID");

test("protection status: missing and explicit null remain unrecorded, including on replacement", () => {
  assert.equal(normalize(), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize(undefined, { previous: status() }), null);
  assert.equal(normalize(null, { previous: status() }), null);
});

test("protection status: empty input never infers an applicable phase or enables planning", () => {
  assert.deepEqual(normalize({}), { version: 1, planningEnabled: false, periods: [] });
  assert.deepEqual(normalize({ periods: [period({ confirmed: false, normalDailyMinutes: null })] }).planningEnabled, false);
  for (const key of ["sex", "gender", "birthDate", "diagnosis", "dueDate", "medicalNotes"]) {
    invalid(() => normalize({ [key]: "synthetic-private-input" }));
  }
});

test("protection status: a confirmed record preserves only the declared schema", () => {
  assert.deepEqual(normalize(status()), status());
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(status()))), status());
});

test("protection status: planning enablement is explicit and never supplied by period confirmation", () => {
  const previous = { ...status(), planningEnabled: false };
  assert.equal(normalize({ periods: [period()] }, { previous }).planningEnabled, false);
  assert.equal(normalize({ planningEnabled: true }, { previous }).planningEnabled, true);
  assert.equal(normalize({ planningEnabled: false }, { previous: status() }).planningEnabled, false);
  for (const value of [1, 0, "true", "false", null, undefined, [], {}]) {
    invalid(() => normalize({ planningEnabled: value }));
  }
});

test("protection status: omitted periods preserve their complete confirmed basis without sharing references", () => {
  const previous = status();
  const next = normalize({ planningEnabled: false }, { previous });
  assert.deepEqual(next.periods, previous.periods);
  assert.notEqual(next.periods, previous.periods);
  assert.notEqual(next.periods[0], previous.periods[0]);
  next.periods[0].referenceId = "changed-copy";
  assert.equal(previous.periods[0].referenceId, "hr:synthetic/01");
});

test("protection status: an explicit empty list deletes periods without manufacturing known coverage", () => {
  assert.deepEqual(normalize({ periods: [] }, { previous: status() }), {
    version: 1, planningEnabled: true, periods: [],
  });
});

test("protection status: list replacement preserves only the submitted periods", () => {
  const previous = status([period(), period({ id: "period-02", phase: "breastfeeding" })]);
  assert.deepEqual(normalize({ periods: [period()] }, { previous }).periods, [period()]);
});

test("protection status: all supported phases are explicit, and unknown cannot be confirmed", () => {
  for (const phase of ["pregnancy", "postpartum", "breastfeeding", "not_applicable", "employment_prohibition"]) {
    assert.equal(normalize(status([period({ phase })])).periods[0].phase, phase);
  }
  assert.equal(normalize(status([period({ phase: "unknown", confirmed: false })])).periods[0].confirmed, false);
  invalid(() => normalize(status([period({ phase: "unknown" })])));
  for (const phase of ["", "Pregnancy", "none", "pregnant", null, true, 0, {}]) {
    invalid(() => normalize(status([period({ phase })])));
  }
});

test("protection status: confirmation accepts real booleans and requires an opaque HR reference", () => {
  for (const confirmed of [1, 0, "true", "false", null, undefined, {}]) {
    invalid(() => normalize(status([period({ confirmed })])));
  }
  invalid(() => normalize(status([period({ referenceId: "" })])));
  assert.equal(normalize(status([period({ confirmed: false, referenceId: "" })])).periods[0].referenceId, "");
});

test("protection status: every basis change revokes inherited confirmation", () => {
  const changes = [
    { id: "new-period-id" }, { phase: "postpartum" }, { validFrom: "2032-02-01" },
    { validTo: "2032-07-01" }, { referenceId: "hr:synthetic/new" }, { normalDailyMinutes: 420 },
  ];
  for (const change of changes) {
    const replacement = period(change);
    delete replacement.confirmed;
    const result = normalize({ periods: [replacement] }, { previous: status() });
    assert.equal(result.periods[0].confirmed, false, JSON.stringify(change));
  }
});

test("protection status: unchanged period basis can retain confirmation despite list reordering", () => {
  const first = period(), second = period({ id: "period-02", phase: "breastfeeding" });
  const prior = status([first, second]);
  const supplied = [second, first].map(value => {
    const next = { ...value }; delete next.confirmed; return next;
  });
  assert.deepEqual(normalize({ periods: supplied }, { previous: prior }).periods, [second, first]);
});

test("protection status: an explicit new confirmation validates the new complete basis", () => {
  const replacement = period({ phase: "postpartum", validFrom: "2032-03-01", referenceId: "hr:new" });
  assert.deepEqual(normalize({ periods: [replacement] }, { previous: status() }).periods, [replacement]);
  invalid(() => normalize({ periods: [period({ phase: "unknown" })] }, { previous: status() }));
  invalid(() => normalize({ periods: [period({ referenceId: "" })] }, { previous: status() }));
});

test("protection status: explicit deconfirmation is respected and missing confirmation never activates a new period", () => {
  assert.equal(normalize({ periods: [period({ confirmed: false })] }, { previous: status() }).periods[0].confirmed, false);
  const newPeriod = period(); delete newPeriod.confirmed;
  assert.equal(normalize(status([newPeriod])).periods[0].confirmed, false);
});

test("protection status: omitted optional replacement fields reset their basis and deconfirm", () => {
  const replacement = { id: "period-01", phase: "pregnancy", validFrom: "2032-01-05" };
  assert.deepEqual(normalize({ periods: [replacement] }, { previous: status() }).periods[0], {
    ...replacement, confirmed: false, validTo: "", referenceId: "", normalDailyMinutes: null,
  });
});

test("protection status: ordinary daily minutes are explicit, bounded integers with nullable unknown", () => {
  for (const normalDailyMinutes of [null, 1, 480, 540]) {
    assert.equal(normalize(status([period({ normalDailyMinutes })])).periods[0].normalDailyMinutes, normalDailyMinutes);
  }
  for (const normalDailyMinutes of [0, -1, 541, 480.5, "480", undefined, NaN, Infinity, true]) {
    invalid(() => normalize(status([period({ normalDailyMinutes })])));
  }
});

test("protection status: validity uses real calendar dates and inclusive ordered intervals", () => {
  assert.equal(normalize(status([period({ validFrom: "2032-02-29", validTo: "2032-02-29" })])).periods[0].validTo, "2032-02-29");
  for (const date of ["", "2031-02-29", "2032-02-30", "2032-04-31", "2032-13-01", "2032-01-00", "2032-1-05", " 2032-01-05", null, 20320105]) {
    invalid(() => normalize(status([period({ validFrom: date })])));
    if (date !== "") invalid(() => normalize(status([period({ validTo: date })])));
  }
  invalid(() => normalize(status([period({ validTo: "2032-01-04" })])));
});

test("protection status: open confirmed prohibition is retained for downstream manual coverage review", () => {
  assert.equal(normalize(status([period({ phase: "employment_prohibition", validTo: "" })])).periods[0].validTo, "");
});

test("protection status: overlapping explicit phases are retained for the evaluator to resolve", () => {
  const periods = [period(), period({ id: "period-02", phase: "breastfeeding" })];
  assert.deepEqual(normalize(status(periods)).periods, periods);
});

test("protection status: stable references have strict alphabets and an 80 character limit", () => {
  assert.equal(normalize(status([period({ id: "a".repeat(80), referenceId: "A._:/-" + "a".repeat(74) })])).periods[0].id.length, 80);
  for (const id of ["", "a".repeat(81), "HR:1", "HR/1", " HR", "HR 1", "ä", "HR\0", "HR\n", null, 123]) {
    invalid(() => normalize(status([period({ id })])));
  }
  for (const referenceId of ["a".repeat(81), "medical free text", "HR\t1", "HR\u007f1", "HR\u00851", "ä", null, 123]) {
    invalid(() => normalize(status([period({ referenceId })])));
  }
});

test("protection status: at most 32 unique periods are accepted", () => {
  const periods = Array.from({ length: 32 }, (_, index) => period({ id: `period-${index}` }));
  assert.equal(normalize(status(periods)).periods.length, 32);
  invalid(() => normalize(status([...periods, period({ id: "period-33" })])));
  invalid(() => normalize(status([period(), period({ phase: "postpartum" })])));
});

test("protection status: unexpected versions, keys and non-record inputs fail closed", () => {
  for (const value of [[], "", 0, false, new Date(), Object.create({ planningEnabled: true })]) invalid(() => normalize(value));
  for (const version of [0, 2, "1", null, undefined, true]) invalid(() => normalize({ version }));
  invalid(() => normalize({ ...status(), medicalNote: "synthetic-private-input" }));
  invalid(() => normalize(status([period({ medicalNote: "synthetic-private-input" })])));
  for (const value of [null, {}, "periods", false]) invalid(() => normalize({ periods: value }));
  for (const value of [null, [], "period", false]) invalid(() => normalize({ periods: [value] }));
});

test("protection status: own prototype keys and symbol properties are rejected", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const outer = status(), inner = period();
    Object.defineProperty(outer, key, { value: "synthetic-private-input", enumerable: true });
    Object.defineProperty(inner, key, { value: "synthetic-private-input", enumerable: true });
    invalid(() => normalize(outer));
    invalid(() => normalize(status([inner])));
  }
  invalid(() => normalize({ ...status(), [Symbol("private")]: true }));
  invalid(() => normalize(status([{ ...period(), [Symbol("private")]: true }])));
});

test("protection status: accessor inputs are rejected without reading them", () => {
  let getterCalls = 0;
  const outer = status(), inner = period(), periods = [period()];
  Object.defineProperty(outer, "planningEnabled", { get() { getterCalls++; return true; } });
  Object.defineProperty(inner, "phase", { get() { getterCalls++; return "pregnancy"; } });
  Object.defineProperty(periods, "0", { get() { getterCalls++; return period(); } });
  invalid(() => normalize(outer));
  invalid(() => normalize(status([inner])));
  invalid(() => normalize(status(periods)));
  assert.equal(getterCalls, 0);
});

test("protection status: periods arrays reject sparse slots, own extra properties and altered prototypes", () => {
  const arrays = [[period()], [period()], [period()], new Array(1), [period()]];
  arrays[0].note = "synthetic-private-input";
  arrays[1][Symbol("private")] = true;
  Object.defineProperty(arrays[2], "__proto__", { value: null });
  Object.setPrototypeOf(arrays[4], null);
  for (const value of arrays) invalid(() => normalize({ periods: value }));
});

test("protection status: null-prototype records are safe while prior input is validated too", () => {
  const value = Object.assign(Object.create(null), status([Object.assign(Object.create(null), period())]));
  assert.deepEqual(normalize(value), status());
  invalid(() => normalize({}, { previous: { ...status(), unsafe: true } }));
  invalid(() => normalize({}, { previous: status([period({ referenceId: "" })]) }));
});

test("protection status: frozen originals remain unchanged and private values stay out of errors", () => {
  const previous = status(); Object.freeze(previous.periods[0]); Object.freeze(previous.periods); Object.freeze(previous);
  const replacement = { ...period(), referenceId: "hr:synthetic/new", confirmed: false };
  Object.freeze(replacement);
  const next = normalize({ periods: [replacement] }, { previous });
  assert.equal(next.periods[0].confirmed, false);
  assert.deepEqual(previous, status());
  const secret = "synthetic-private-input-should-never-appear";
  try { normalize(status([period({ referenceId: secret + " with spaces" })])); }
  catch (error) { assert.equal(JSON.stringify({ message: error.message, code: error.code }).includes(secret), false); }
});
