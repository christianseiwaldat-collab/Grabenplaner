"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { personalAbsenceRequestPeriod, absenceRequestSubmissionAssessment,
  absenceRequestSubmissionAllowed } = require("../lib/absence-request-policy");

test("personal request horizon is inclusive at 365 days across a leap year and year changes", () => {
  for (const [today, last, next] of [["2031-04-01", "2032-03-31", "2032-04-01"],
    ["2028-02-29", "2029-02-28", "2029-03-01"], ["2026-10-25", "2027-10-25", "2027-10-26"]]) {
    for (const kind of ["vacation", "time_off"]) {
      assert.equal(personalAbsenceRequestPeriod(today, last, today, kind), null);
      assert.equal(personalAbsenceRequestPeriod(last, last, today, kind), null);
      const blocked = personalAbsenceRequestPeriod(last, next, today, kind);
      assert.equal(blocked.submissionAllowed, false);
      assert.equal(blocked.maximumDate, last);
      assert.match(blocked.code, /REQUEST_HORIZON$/);
    }
  }
});

test("past, invalid or reversed requests are rejected before any range traversal", () => {
  for (const [from, to] of [["2031-03-31", "2031-04-01"], ["2031-02-29", "2031-04-01"],
    ["2031-04-02", "2031-04-01"], ["2031-04-01", "9999-12-31"], ["", "2031-04-01"]]) {
    assert.equal(personalAbsenceRequestPeriod(from, to, "2031-04-01").submissionAllowed, false);
  }
});

test("only staffing warnings allow submission; approval feasibility stays red and false", () => {
  for (const code of ["VACATION_STAFFING_INSUFFICIENT", "TIME_OFF_STAFFING_INSUFFICIENT"]) {
    const assessment = absenceRequestSubmissionAssessment({ allowed: false, trafficLight: "red", code });
    assert.equal(assessment.submissionAllowed, true);
    assert.equal(assessment.allowed, false);
    assert.equal(assessment.trafficLight, "red");
  }
  for (const code of ["REQUEST_BLACKOUT", "VACATION_EMPLOYEE_LENDING_CONFLICT", "TIME_OFF_MIXED_RESPONSIBILITY",
    "VACATION_REQUEST_OVERLAP", "TIME_OFF_REQUEST_HORIZON", undefined]) {
    assert.equal(absenceRequestSubmissionAllowed({ allowed: false, trafficLight: "red", code, submissionAllowed: true }), false);
  }
});
