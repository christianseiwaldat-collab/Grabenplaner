"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RETAIL_KV_SOURCE: source, normalizeRetailKv: normalize,
  resolveRetailKvPeriod: resolve, projectRetailKvForDate: project } = require("../lib/personnel-retail-kv");

const period = changes => ({
  id: "synthetic-period-1", group: "salaried", confirmed: true,
  validFrom: "2026-01-01", validTo: "2026-12-31", sourceReference: "hr:synthetic/assignment",
  collectiveAgreementVersionId: "synthetic-kv-version", approvedAssignmentId: "synthetic-approved-assignment",
  sourceVersion: source.id, sourceSha256: source.sha256, contractWeeklyMinutes: 2310,
  normalWorkModel: "standard", agreementStatus: "none_confirmed",
  agreementReference: "hr:synthetic/absence-check", agreementValidFrom: "2026-01-01",
  agreementValidTo: "2026-12-31", agreementConfirmedBy: "synthetic-hr-principal",
  workplaceKind: "unknown", workplaceConfirmed: false, exceptionModel: "unknown", averagingPeriod: null, ...changes,
});
const status = periods => ({ version: 1, planningEnabled: true, periods: periods || [period()] });
const invalid = callback => assert.throws(callback, error => error.status === 400
  && error.code === "PERSONNEL_RETAIL_KV_INVALID" && !error.message.includes("PRIVATE"));
const withoutConfirmation = value => { const copy = { ...value }; delete copy.confirmed; return copy; };

test("retail KV: missing and null stay unrecorded; empty record invents no enablement, group or BV absence", () => {
  assert.equal(normalize(), null);
  assert.equal(normalize(null, { previous: status() }), null);
  assert.deepEqual(normalize({}), { version: 1, planningEnabled: false, periods: [] });
  const saved = normalize({ periods: [{ id: "draft", validFrom: "2026-02-01" }] });
  assert.equal(saved.planningEnabled, false);
  assert.equal(saved.periods[0].group, "unknown");
  assert.equal(saved.periods[0].normalWorkModel, "unknown");
  assert.equal(saved.periods[0].agreementStatus, "unknown");
  assert.equal(saved.periods[0].contractWeeklyMinutes, null);
  assert.equal(saved.periods[0].confirmed, false);
});

test("retail KV: confirmed salaried and apprentice bases round-trip without sharing private objects", () => {
  for (const group of ["salaried", "apprentice"]) {
    const value = status([period({ group })]);
    const saved = normalize(value);
    assert.deepEqual(saved, value);
    assert.notEqual(saved, value);
    assert.notEqual(saved.periods, value.periods);
    assert.notEqual(saved.periods[0], value.periods[0]);
  }
});

test("retail KV: enablement is an explicit boolean independent of confirmation and survives unrelated replacement", () => {
  assert.equal(normalize({ periods: [period()] }).planningEnabled, false);
  assert.deepEqual(normalize({ planningEnabled: false }, { previous: status() }).periods, [period()]);
  const disabled = { ...status(), planningEnabled: false };
  assert.equal(normalize({ periods: [period()] }, { previous: disabled }).planningEnabled, false);
  for (const planningEnabled of [1, 0, "true", "false", null, undefined, [], {}]) invalid(() => normalize({ planningEnabled }));
});

test("retail KV: pending enabled records may omit bindings but their public planning state stays unknown", () => {
  const value = status([{ id: "pending", group: "salaried", validFrom: "2026-02-01" }]);
  assert.equal(normalize(value).periods[0].approvedAssignmentId, "");
  assert.deepEqual(project(value, "2026-02-02", { assignmentVerified: true }), {
    date: "2026-02-02", enabled: true, state: "unknown", employeeGroup: "unknown",
    contractWeeklyMinutes: null, normalWorkModel: "unknown", agreementStatus: "unknown",
    agreementApplicable: false, sourceVerified: false,
    workplaceFacts: { kind: "unknown", confirmed: false, exceptionModel: "unknown" }, averagingPeriod: null,
  });
});

test("retail KV: confirmations require an explicit group, opaque personal basis and both immutable binding links", () => {
  for (const change of [{ group: "unknown" }, { sourceReference: "" },
    { collectiveAgreementVersionId: "" }, { approvedAssignmentId: "" },
    { sourceVersion: "" }, { sourceSha256: "" }]) invalid(() => normalize(status([period(change)])));
  for (const confirmed of [1, 0, "true", "false", null, undefined, {}]) invalid(() => normalize(status([period({ confirmed })])));
  const exclusion = period({ group: "not_applicable", collectiveAgreementVersionId: "",
    approvedAssignmentId: "", sourceVersion: "", sourceSha256: "", contractWeeklyMinutes: null,
    normalWorkModel: "unknown", agreementStatus: "unknown", agreementReference: "",
    agreementValidFrom: "", agreementValidTo: "", agreementConfirmedBy: "" });
  assert.equal(normalize(status([exclusion])).periods[0].confirmed, true);
  assert.equal(project(status([exclusion]), "2026-02-01").state, "not_applicable");
  invalid(() => normalize(status([period({ ...exclusion, sourceReference: "" })])));
});

test("retail KV: manual workers, medical attributes and inferred classifications are outside this record", () => {
  for (const group of ["worker", "manual_worker", "employee", "Angestellte", "", null, true]) invalid(() => normalize(status([period({ group })])));
  for (const key of ["positionId", "employmentClassification", "birthDate", "protectionStatus", "phase", "diagnosis", "medicalNotes"]) {
    invalid(() => normalize({ ...status(), [key]: "PRIVATE" }));
    invalid(() => normalize(status([period({ [key]: "PRIVATE" })])));
  }
});

test("retail KV: source version and exact source bytes cannot be replaced by a plausible hash or another year", () => {
  assert.equal(Object.isFrozen(source), true);
  assert.equal(source.id, "wko.kv.handel.angestellte.2026.20261003");
  assert.equal(source.sha256, "ea214b34db934d18a4c0b25c0ae6dd3b62dceb5255851e91ac25908cee876e90");
  for (const sourceSha256 of ["a".repeat(64), source.sha256.toUpperCase(), "PRIVATE", null, undefined]) {
    invalid(() => normalize(status([period({ sourceSha256 })])));
  }
  for (const sourceVersion of ["2026", "2027", "wko.kv.handel.2026", null, undefined]) invalid(() => normalize(status([period({ sourceVersion })])));
});

test("retail KV: all factual basis changes revoke inherited confirmation; explicit new confirmation remains possible", () => {
  const changes = [
    { id: "new-id" }, { group: "apprentice" }, { validFrom: "2026-02-01" }, { validTo: "2026-11-30" },
    { sourceReference: "hr:changed" }, { collectiveAgreementVersionId: "new-version" },
    { approvedAssignmentId: "new-assignment" }, { sourceVersion: "" }, { sourceSha256: "" },
    { contractWeeklyMinutes: 1200 }, { normalWorkModel: "agreement_other" },
    { agreementStatus: "documented" }, { agreementReference: "hr:new-agreement" },
    { agreementValidFrom: "2026-02-01" }, { agreementValidTo: "2026-11-30" },
    { agreementConfirmedBy: "another-hr-principal" },
  ];
  for (const change of changes) {
    assert.equal(normalize({ periods: [withoutConfirmation(period(change))] }, { previous: status() }).periods[0].confirmed,
      false, JSON.stringify(change));
  }
  assert.equal(normalize({ periods: [period({ contractWeeklyMinutes: 1200 })] }, { previous: status() }).periods[0].confirmed, true);
});

test("retail KV: unchanged values retain confirmation by stable ID, and explicit deconfirmation wins", () => {
  assert.equal(normalize({ periods: [withoutConfirmation(period())] }, { previous: status() }).periods[0].confirmed, true);
  assert.equal(normalize({ periods: [period({ confirmed: false })] }, { previous: status() }).periods[0].confirmed, false);
  assert.equal(normalize({ periods: [withoutConfirmation(period())] }).periods[0].confirmed, false);
});

test("retail KV: replacement deletes omitted basis, periods and facts rather than borrowing prior evidence", () => {
  const value = normalize({ periods: [{ id: period().id, validFrom: "2026-01-01" }] }, { previous: status() });
  assert.equal(value.periods[0].confirmed, false);
  assert.equal(value.periods[0].sourceReference, "");
  assert.equal(value.periods[0].approvedAssignmentId, "");
  assert.equal(value.periods[0].agreementStatus, "unknown");
  assert.deepEqual(normalize({ periods: [] }, { previous: status() }).periods, []);
});

test("retail KV: factual weekly contract minutes are nullable bounded integers, never fabricated full time", () => {
  for (const contractWeeklyMinutes of [null, 1, 1200, 2310]) assert.equal(normalize(status([period({ contractWeeklyMinutes })])).periods[0].contractWeeklyMinutes, contractWeeklyMinutes);
  for (const contractWeeklyMinutes of [0, -1, 2311, 2309.5, "2310", true, undefined, NaN, Infinity]) invalid(() => normalize(status([period({ contractWeeklyMinutes })])));
});

test("retail KV: personal and agreement intervals use real dates and inclusive ordered endpoints", () => {
  const leap = period({ validFrom: "2024-02-29", validTo: "2024-02-29" });
  assert.equal(normalize(status([leap])).periods[0].validFrom, "2024-02-29");
  for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "2026-1-01", " 2026-01-01", null, 20260101]) {
    for (const key of ["validFrom", "validTo", "agreementValidFrom", "agreementValidTo"]) invalid(() => normalize(status([period({ [key]: value })])));
  }
  invalid(() => normalize(status([period({ validTo: "2025-12-31" })])));
  invalid(() => normalize(status([period({ agreementValidTo: "2025-12-31" })])));
  invalid(() => normalize(status([period({ agreementValidFrom: "", agreementValidTo: "2026-12-31" })])));
});

test("retail KV: confirmed contradictory overlaps including their boundary day are rejected", () => {
  for (const change of [{ group: "apprentice" }, { contractWeeklyMinutes: 1200 },
    { normalWorkModel: "agreement_other" }, { approvedAssignmentId: "other-approved-assignment" },
    { agreementStatus: "documented" }, { agreementValidFrom: "2026-02-01" }]) {
    invalid(() => normalize(status([period(), period({ id: "second", ...change })])));
  }
  invalid(() => normalize(status([period({ validTo: "2026-06-30" }),
    period({ id: "second", group: "apprentice", validFrom: "2026-06-30" })])));
});

test("retail KV: adjacent transitions resolve the final apprentice day and next salaried day correctly", () => {
  const value = status([period({ group: "apprentice", validTo: "2026-06-30" }),
    period({ id: "second", validFrom: "2026-07-01" })]);
  assert.equal(resolve(value, "2026-06-30").period.group, "apprentice");
  assert.equal(resolve(value, "2026-07-01").period.group, "salaried");
  assert.equal(project(value, "2026-07-01", { assignmentVerified: true }).employeeGroup, "salaried");
});

test("retail KV: ambiguous duplicate or pending coverage never picks an optimistic confirmed period", () => {
  for (const second of [period({ id: "second" }), period({ id: "second", group: "unknown", confirmed: false })]) {
    const value = status([period(), second]);
    assert.equal(normalize(value).periods.length, 2);
    assert.equal(resolve(value, "2026-02-01").reason, "ambiguous_period");
    assert.equal(project(value, "2026-02-01", { assignmentVerified: true }).state, "unknown");
  }
});

test("retail KV: no coverage, disabled and unrecorded states remain distinct and never imply exemption", () => {
  assert.equal(project(null, "2026-02-01").state, "unrecorded");
  assert.equal(project({ ...status(), planningEnabled: false }, "2026-02-01").state, "disabled");
  assert.equal(project(status([]), "2026-02-01", { assignmentVerified: true }).state, "unknown");
  assert.equal(resolve(status(), "2025-12-31").reason, "missing_period");
  invalid(() => project(status(), "2026-02-30"));
});

test("retail KV: open personal validity does not extend immutable 2026 source validity into another year", () => {
  const value = status([period({ validFrom: "2025-12-01", validTo: "" })]);
  assert.equal(resolve(value, "2025-12-31").reason, "source_outside_validity");
  assert.equal(resolve(value, "2026-01-01").sourceVerified, true);
  assert.equal(resolve(value, "2026-12-31").sourceVerified, true);
  const nextYear = project(value, "2027-01-01", { assignmentVerified: true });
  assert.equal(nextYear.sourceVerified, false);
  assert.equal(nextYear.state, "unknown");
});

test("retail KV: actual binding verification is required even when every saved private field claims approval", () => {
  for (const assignmentVerified of [false, "true", 1, null, undefined, {}]) assert.equal(project(status(), "2026-02-01", { assignmentVerified }).state, "unknown");
  assert.equal(project(status(), "2026-02-01", { assignmentVerified: true }).state, "confirmed");
  assert.equal(project(status(), "2026-02-01").contractWeeklyMinutes, null);
});

test("retail KV: a standard work model cannot silently turn unknown agreement status into confirmed absence", () => {
  const value = status([period({ agreementStatus: "unknown", agreementReference: "", agreementValidFrom: "",
    agreementValidTo: "", agreementConfirmedBy: "" })]);
  assert.equal(normalize(value).periods[0].confirmed, true);
  const publicValue = project(value, "2026-02-01", { assignmentVerified: true });
  assert.equal(publicValue.state, "confirmed");
  assert.equal(publicValue.normalWorkModel, "standard");
  assert.equal(publicValue.agreementStatus, "unknown");
  assert.equal(publicValue.agreementApplicable, false);
});

test("retail KV: absence and documented agreements need explicit evidence, period and confirmer", () => {
  for (const agreementStatus of ["none_confirmed", "documented"]) {
    for (const change of [{ agreementReference: "" }, { agreementValidFrom: "", agreementValidTo: "" },
      { agreementConfirmedBy: "" }]) invalid(() => normalize(status([period({ agreementStatus, ...change })])));
    assert.equal(project(status([period({ agreementStatus })]), "2026-02-01", { assignmentVerified: true }).agreementApplicable, true);
  }
  invalid(() => normalize(status([period({ confirmed: false, agreementStatus: "none_confirmed", agreementConfirmedBy: "" })])));
});

test("retail KV: agreement applicability is dated and an open interval cannot prove a complete 26-week window", () => {
  const value = status([period({ agreementStatus: "documented", normalWorkModel: "durchrechnung26Weeks",
    agreementValidFrom: "2026-02-01", agreementValidTo: "2026-06-30" })]);
  assert.equal(project(value, "2026-01-31", { assignmentVerified: true }).agreementApplicable, false);
  assert.equal(project(value, "2026-02-01", { assignmentVerified: true }).agreementApplicable, true);
  assert.equal(project(value, "2026-06-30", { assignmentVerified: true }).agreementApplicable, true);
  assert.equal(project(value, "2026-07-01", { assignmentVerified: true }).agreementApplicable, false);
  const open = status([period({ agreementStatus: "documented", normalWorkModel: "durchrechnung26Weeks", agreementValidTo: "" })]);
  assert.equal(project(open, "2026-03-01", { assignmentVerified: true }).agreementApplicable, false);
});

test("retail KV: public projection has an exact allowlist and never copies IDs, evidence references or confirmer", () => {
  const value = status([period({ id: "PRIVATE-period", sourceReference: "PRIVATE:personal-basis",
    collectiveAgreementVersionId: "PRIVATE-version", approvedAssignmentId: "PRIVATE-assignment",
    agreementReference: "PRIVATE:agreement", agreementConfirmedBy: "PRIVATE-HR" })]);
  const result = project(value, "2026-02-01", { assignmentVerified: true });
  assert.deepEqual(Object.keys(result).sort(), ["date", "enabled", "state", "employeeGroup", "contractWeeklyMinutes",
    "normalWorkModel", "agreementStatus", "agreementApplicable", "sourceVerified", "workplaceFacts", "averagingPeriod"].sort());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sourceReference|confirmedBy|approvedAssignmentId|validFrom|validTo/);
  assert.equal(JSON.stringify(value).includes("PRIVATE"), true);
});

test("retail KV: invalid stored data resolves to unknown without leaking rejected values into planning", () => {
  const value = status([period({ privateMedicalNote: "PRIVATE" })]);
  invalid(() => normalize(value));
  assert.equal(resolve(value, "2026-02-01").reason, "invalid_record");
  const projected = project(value, "2026-02-01", { assignmentVerified: true });
  assert.equal(projected.state, "unknown");
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|medical/);
});

test("retail KV: opaque references use strict alphabets and reject prose, controls, prototype and oversized identifiers", () => {
  for (const key of ["sourceReference", "agreementReference", "agreementConfirmedBy"]) {
    for (const value of ["PRIVATE text", "PRIVATE\n", "PRIVATE\0", "ä", "a".repeat(81), null, 123]) invalid(() => normalize(status([period({ [key]: value })])));
  }
  for (const id of ["", "has:colon", "has/slash", "a".repeat(81), null, true]) invalid(() => normalize(status([period({ id })])));
  for (const key of ["collectiveAgreementVersionId", "approvedAssignmentId"]) {
    assert.equal(normalize(status([period({ [key]: "a".repeat(160) })])).periods[0][key].length, 160);
    invalid(() => normalize(status([period({ [key]: "a".repeat(161) })])));
  }
});

test("retail KV: maximum 32 unique periods and genuine dense arrays are required", () => {
  const periods = Array.from({ length: 32 }, (_, index) => period({ id: `p-${index}`, confirmed: false }));
  assert.equal(normalize(status(periods)).periods.length, 32);
  invalid(() => normalize(status([...periods, period({ id: "extra" })])));
  invalid(() => normalize(status([period(), period()])));
  invalid(() => normalize(status(new Array(2))));
  const custom = [period()]; custom.extra = "PRIVATE"; invalid(() => normalize(status(custom)));
  const accessors = [period()]; Object.defineProperty(accessors, "0", { get() { throw new Error("PRIVATE"); } });
  invalid(() => normalize(status(accessors)));
});

test("retail KV: versions, records, inherited values, unexpected keys and accessors fail closed", () => {
  for (const value of [[], 1, true, "PRIVATE", new Date(), Object.create({ planningEnabled: true })]) invalid(() => normalize(value));
  for (const version of [0, 2, "1", null, undefined, true]) invalid(() => normalize({ version }));
  for (const periods of [null, {}, true, "PRIVATE"]) invalid(() => normalize({ periods }));
  for (const normalWorkModel of ["gleitzeit", "standard_auto", null, true]) invalid(() => normalize(status([period({ normalWorkModel })])));
  for (const agreementStatus of ["none", "not_found", "confirmed", null, false]) invalid(() => normalize(status([period({ agreementStatus })])));
  invalid(() => normalize({ ...status(), [Symbol("PRIVATE")]: true }));
  invalid(() => normalize({ ...status(), unknown: true }));
  const accessor = {}; Object.defineProperty(accessor, "planningEnabled", { get() { throw new Error("PRIVATE"); } });
  invalid(() => normalize(accessor));
  invalid(() => normalize(JSON.parse('{"__proto__": {"planningEnabled": true}}')));
});

test("retail KV: workplace kinds and exception models are explicit bounded facts unrelated to a position", () => {
  for (const workplaceKind of ["retail_sales", "retail_other", "wholesale_sales", "wholesale_other"]) {
    const value = status([period({ workplaceKind, workplaceConfirmed: true, exceptionModel: "none_confirmed" })]);
    assert.deepEqual(project(value, "2026-02-01", { assignmentVerified: true }).workplaceFacts,
      { kind: workplaceKind, confirmed: true, exceptionModel: "none_confirmed" });
  }
  for (const workplaceKind of ["sales", "retail", "branch_manager", "", null, true]) invalid(() => normalize(status([period({ workplaceKind })])));
  for (const exceptionModel of ["none", "allowed", "sunday_authorized", "", null, false]) invalid(() => normalize(status([period({ exceptionModel })])));
  for (const workplaceConfirmed of ["true", 1, null, undefined]) invalid(() => normalize(status([period({ workplaceConfirmed })])));
  invalid(() => normalize(status([period({ workplaceConfirmed: true })])));
  invalid(() => normalize(status([period({ confirmed: false, workplaceKind: "retail_sales", workplaceConfirmed: true, sourceReference: "" })])));
});

test("retail KV: changed workplace kind, exceptions or personal basis revoke workplace confirmation", () => {
  const prior = status([period({ workplaceKind: "retail_sales", workplaceConfirmed: true, exceptionModel: "none_confirmed" })]);
  for (const change of [{ workplaceKind: "wholesale_sales" }, { exceptionModel: "unsupported" },
    { sourceReference: "new:workplace-basis" }, { group: "apprentice" }, { validFrom: "2026-02-01" }]) {
    const replacement = withoutConfirmation({ ...prior.periods[0], ...change });
    delete replacement.workplaceConfirmed;
    const saved = normalize({ periods: [replacement] }, { previous: prior }).periods[0];
    assert.equal(saved.workplaceConfirmed, false, JSON.stringify(change));
    assert.equal(saved.confirmed, false, JSON.stringify(change));
  }
  const unchanged = withoutConfirmation(prior.periods[0]); delete unchanged.workplaceConfirmed;
  assert.equal(normalize({ periods: [unchanged] }, { previous: prior }).periods[0].workplaceConfirmed, true);
  const renewed = period({ workplaceKind: "wholesale_sales", workplaceConfirmed: true, exceptionModel: "unsupported" });
  assert.equal(normalize({ periods: [renewed] }, { previous: prior }).periods[0].workplaceConfirmed, true);
  assert.deepEqual(project(prior, "2026-02-01").workplaceFacts, { kind: "unknown", confirmed: false, exceptionModel: "unknown" });
});

const averaging = changes => ({ start: "2026-01-01", end: "2026-06-30", confirmed: true, carryMinutes: null, ...changes });
const averagedPeriod = changes => period({ normalWorkModel: "durchrechnung26Weeks", agreementStatus: "documented",
  averagingPeriod: averaging(), ...changes });

test("retail KV: an averaging interval is separately confirmed without inventing carry or a complete plan horizon", () => {
  const value = status([averagedPeriod()]);
  const saved = normalize(value);
  assert.deepEqual(saved.periods[0].averagingPeriod, averaging());
  const projected = project(value, "2026-02-01", { assignmentVerified: true });
  assert.deepEqual(projected.averagingPeriod, averaging());
  assert.notEqual(projected.averagingPeriod, value.periods[0].averagingPeriod);
  assert.equal(projected.averagingPeriod.carryMinutes, null);
  assert.equal(project(value, "2026-02-01").averagingPeriod, null);
  assert.equal(project(status(), "2026-02-01", { assignmentVerified: true }).averagingPeriod, null);
});

test("retail KV: confirmed averaging needs the documented model and a covering agreement, not merely a true checkbox", () => {
  for (const change of [{ normalWorkModel: "standard" }, { normalWorkModel: "agreement_other" },
    { agreementStatus: "none_confirmed" }, { agreementStatus: "unknown" },
    { agreementReference: "" }, { agreementConfirmedBy: "" }, { sourceReference: "" },
    { agreementValidFrom: "2026-02-01" }, { agreementValidTo: "2026-05-31" }]) {
    invalid(() => normalize(status([averagedPeriod(change)])));
  }
  const pending = status([period({ normalWorkModel: "unknown", agreementStatus: "unknown",
    averagingPeriod: averaging({ confirmed: false }) })]);
  assert.equal(normalize(pending).periods[0].averagingPeriod.confirmed, false);
});

test("retail KV: changes to averaging interval, carry or model basis revoke inherited interval and personnel confirmation", () => {
  const prior = status([averagedPeriod()]);
  for (const change of [{ start: "2026-02-01" }, { end: "2026-05-31" }, { carryMinutes: 60 }]) {
    const replacement = withoutConfirmation(averagedPeriod({ averagingPeriod: averaging(change) }));
    delete replacement.averagingPeriod.confirmed;
    const saved = normalize({ periods: [replacement] }, { previous: prior }).periods[0];
    assert.equal(saved.averagingPeriod.confirmed, false);
    assert.equal(saved.confirmed, false);
  }
  for (const change of [{ contractWeeklyMinutes: 1200 }, { agreementReference: "new:agreement" },
    { sourceReference: "new:contract" }, { group: "apprentice" }]) {
    const replacement = withoutConfirmation(averagedPeriod(change)); delete replacement.averagingPeriod.confirmed;
    assert.equal(normalize({ periods: [replacement] }, { previous: prior }).periods[0].averagingPeriod.confirmed, false);
  }
  const replacement = withoutConfirmation(averagedPeriod()); delete replacement.averagingPeriod.confirmed;
  assert.equal(normalize({ periods: [replacement] }, { previous: prior }).periods[0].averagingPeriod.confirmed, true);
});

test("retail KV: averaging accepts only genuine dates, safe integer carry or null and exact nested keys", () => {
  for (const carryMinutes of [null, 0, 60, -60, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    assert.equal(normalize(status([averagedPeriod({ averagingPeriod: averaging({ carryMinutes }) })])).periods[0].averagingPeriod.carryMinutes, carryMinutes);
  }
  for (const carryMinutes of [1.5, "60", false, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => normalize(status([averagedPeriod({ averagingPeriod: averaging({ carryMinutes }) })])));
  }
  for (const change of [{ start: "2026-02-29" }, { end: "2026-02-30" }, { start: "2026-07-01" },
    { end: "" }, { confirmed: "true" }, { confirmed: null }, { note: "PRIVATE" }]) {
    invalid(() => normalize(status([averagedPeriod({ averagingPeriod: averaging(change) })])));
  }
  for (const averagingPeriod of [[], "PRIVATE", true, 1, undefined]) invalid(() => normalize(status([averagedPeriod({ averagingPeriod })])));
  const accessor = averaging(); Object.defineProperty(accessor, "carryMinutes", { get() { throw new Error("PRIVATE"); } });
  invalid(() => normalize(status([averagedPeriod({ averagingPeriod: accessor })])));
});

test("retail KV: contradictory confirmed workplace or averaging facts cannot coexist in the same personal interval", () => {
  const first = period({ workplaceKind: "retail_sales", workplaceConfirmed: true });
  invalid(() => normalize(status([first, { ...first, id: "second", workplaceKind: "wholesale_sales" }])));
  invalid(() => normalize(status([averagedPeriod(), averagedPeriod({ id: "second", averagingPeriod: averaging({ carryMinutes: 60 }) })])));
});

test("retail KV: an open documented agreement may cover a separately bounded confirmed averaging period", () => {
  const value = status([averagedPeriod({ agreementValidTo: "" })]);
  assert.equal(normalize(value).periods[0].agreementValidTo, "");
  const projection = project(value, "2026-02-01", { assignmentVerified: true });
  assert.equal(projection.agreementApplicable, true);
  assert.deepEqual(projection.averagingPeriod, averaging());
});
