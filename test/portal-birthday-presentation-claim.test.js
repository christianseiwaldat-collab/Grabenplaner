"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PORTAL_BIRTHDAY_TIME_ZONE,
  birthdayClaimReceipt,
  birthdayEventForVienna,
  isLeapYear,
  viennaCalendarDate,
} = require("../lib/portal-birthday-presentation-claim");
const {
  ensureSqlitePortalBirthdayPresentationClaimSchema,
  inspectSqlitePortalBirthdayPresentationClaimRows,
  inspectSqlitePortalBirthdayPresentationClaimSchema,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-claim-schema");

test("Block 10: Wiener Kalendertag ist explizit und unabhängig von der Prozesszeitzone", () => {
  assert.equal(PORTAL_BIRTHDAY_TIME_ZONE, "Europe/Vienna");
  assert.deepEqual(viennaCalendarDate("2026-08-19T22:30:00.000Z"), {
    year: 2026, month: 8, day: 20,
  });
  assert.deepEqual(viennaCalendarDate("2026-12-31T23:30:00.000Z"), {
    year: 2027, month: 1, day: 1,
  });
});

test("Block 10: Geburtstag gilt nur am Wiener Ereignistag und nie als Nachholfall", () => {
  assert.deepEqual(birthdayEventForVienna(
    "1990-08-20",
    "2026-08-20T10:00:00.000Z",
  ), { eventYear: 2026 });
  assert.equal(birthdayEventForVienna(
    "1990-08-20",
    "2026-08-21T10:00:00.000Z",
  ), null);
  assert.equal(birthdayEventForVienna(
    "2026-08-20",
    "2026-08-20T10:00:00.000Z",
  ), null, "Geburtsdatum muss strikt vor heute liegen");
  assert.equal(birthdayEventForVienna("invalid", "2026-08-20T10:00:00.000Z"), null);
});

test("Block 10: 29. Februar wird nur im Nichtschaltjahr auf 28. Februar gelegt", () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2100), false);
  assert.equal(isLeapYear(2000), true);
  assert.deepEqual(birthdayEventForVienna(
    "1992-02-29",
    "2026-02-28T12:00:00.000Z",
  ), { eventYear: 2026 });
  assert.equal(birthdayEventForVienna(
    "1992-02-29",
    "2028-02-28T12:00:00.000Z",
  ), null);
  assert.deepEqual(birthdayEventForVienna(
    "1992-02-29",
    "2028-02-29T12:00:00.000Z",
  ), { eventYear: 2028 });
});

test("Block 10: Claim-Beleg ist keyed, domain-separiert und snapshotgebunden", () => {
  const base = {
    employeeNumber: "252",
    eventYear: 2026,
    presentationId: "elegant",
    policyRevision: 3,
    assignmentRevision: 2,
  };
  const receipt = birthdayClaimReceipt("claim-secret", base);
  assert.match(receipt, /^[0-9a-f]{64}$/);
  assert.equal(receipt, birthdayClaimReceipt("claim-secret", base));
  assert.notEqual(receipt, birthdayClaimReceipt("other-secret", base));
  assert.notEqual(receipt, birthdayClaimReceipt("claim-secret", {
    ...base, assignmentRevision: 3,
  }));
  assert.throws(() => birthdayClaimReceipt("", base), TypeError);
  assert.throws(() => birthdayClaimReceipt("claim-secret", {
    ...base, presentationId: "off",
  }), TypeError);
});


test("Block 10: genehmigter all_personal_data-Export projiziert nur Jahr und Darstellung", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf('if (scope.has("all_personal_data")) {');
  const end = source.indexOf('if (scope.has("time_records")', start);
  assert.ok(start >= 0 && end > start);
  const projection = source.slice(start, end);
  assert.match(projection, /listClaimsForEmployee\(employeeNumber\)/);
  assert.match(projection, /eventYear:\s*Number\(claim\.eventYear\)/);
  assert.match(projection, /presentationId:\s*String\(claim\.presentationId/);
  assert.doesNotMatch(projection, /receipt|policyRevision|assignmentRevision|birthDate|age|claimedAt/);
});
