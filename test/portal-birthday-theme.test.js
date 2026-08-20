"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  birthdayThemeEventForVienna,
} = require("../lib/portal-birthday-presentation-claim");

test("Block 11: Geburtstag und unmittelbar folgender Wiener Kalendertag sind aktiv", () => {
  assert.deepEqual(
    birthdayThemeEventForVienna("1990-08-20", "2026-08-20T10:00:00.000Z"),
    { eventYear: 2026 },
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1990-08-20", "2026-08-21T10:00:00.000Z"),
    { eventYear: 2026 },
  );
  assert.equal(
    birthdayThemeEventForVienna("1990-08-20", "2026-08-22T10:00:00.000Z"),
    null,
  );
  assert.equal(
    birthdayThemeEventForVienna("1990-08-20", "2026-08-19T10:00:00.000Z"),
    null,
  );
});

test("Block 11: ungültige, heutige und zukünftige Geburtsdaten bleiben inaktiv", () => {
  for (const birthDate of [
    "",
    "invalid",
    "1990-02-30",
    "2026-08-20",
    "2026-08-21",
    "2099-08-20",
  ]) {
    assert.equal(
      birthdayThemeEventForVienna(birthDate, "2026-08-20T10:00:00.000Z"),
      null,
      birthDate,
    );
  }
});

test("Block 11: 29. Februar gilt im Nichtschaltjahr am 28. Februar und 1. März", () => {
  assert.equal(
    birthdayThemeEventForVienna("1992-02-29", "2026-02-27T10:00:00.000Z"),
    null,
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1992-02-29", "2026-02-28T10:00:00.000Z"),
    { eventYear: 2026 },
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1992-02-29", "2026-03-01T10:00:00.000Z"),
    { eventYear: 2026 },
  );
  assert.equal(
    birthdayThemeEventForVienna("1992-02-29", "2026-03-02T10:00:00.000Z"),
    null,
  );
});

test("Block 11: 29. Februar gilt im Schaltjahr am 29. Februar und 1. März", () => {
  assert.equal(
    birthdayThemeEventForVienna("1992-02-29", "2028-02-28T10:00:00.000Z"),
    null,
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1992-02-29", "2028-02-29T10:00:00.000Z"),
    { eventYear: 2028 },
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1992-02-29", "2028-03-01T10:00:00.000Z"),
    { eventYear: 2028 },
  );
  assert.equal(
    birthdayThemeEventForVienna("1992-02-29", "2028-03-02T10:00:00.000Z"),
    null,
  );
});

test("Block 11: Jahreswechsel ordnet den 1. Januar dem Ereignis vom 31. Dezember zu", () => {
  assert.deepEqual(
    birthdayThemeEventForVienna("1990-12-31", "2026-12-31T10:00:00.000Z"),
    { eventYear: 2026 },
  );
  assert.deepEqual(
    birthdayThemeEventForVienna("1990-12-31", "2026-12-31T23:30:00.000Z"),
    { eventYear: 2026 },
    "Der Serverzeitpunkt ist in Wien bereits der 1. Januar",
  );
  assert.equal(
    birthdayThemeEventForVienna("1990-12-31", "2027-01-02T10:00:00.000Z"),
    null,
  );
});
