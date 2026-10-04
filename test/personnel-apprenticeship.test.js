"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApprenticeshipFields: normalize, APPRENTICESHIP_FIELD_KEYS } = require("../lib/personnel-apprenticeship");

const confirmed = Object.freeze({
  apprenticeshipStatus: "active", apprenticeshipConfirmed: true,
  apprenticeshipValidFrom: "2026-09-01", apprenticeshipValidTo: "",
  apprenticeshipSourceReference: "synthetischer geprüfter Lehrvertrag",
});
const invalid = (action) => assert.throws(action, (error) => error.status === 400 && error.code === "PERSONNEL_APPRENTICESHIP_INVALID");

test("Lehrlingsstatus: Legacy und freier Beschäftigungstext bleiben ungeklärt", () => {
  assert.deepEqual(normalize({ employmentType: "Lehrling", classification: "apprentice" }), {
    apprenticeshipStatus: "unknown", apprenticeshipConfirmed: false,
    apprenticeshipValidFrom: "", apprenticeshipValidTo: "", apprenticeshipSourceReference: "",
  });
  assert.equal(APPRENTICESHIP_FIELD_KEYS.length, 5);
});

test("Lehrlingsstatus: eine ausdrückliche datierte Bestätigung mit Quelle ist zulässig", () => {
  assert.deepEqual(normalize(confirmed), confirmed);
  assert.deepEqual(normalize({ ...confirmed, apprenticeshipStatus: "not_apprentice" }), { ...confirmed, apprenticeshipStatus: "not_apprentice" });
  assert.deepEqual(normalize({ ...confirmed, apprenticeshipStatus: "completed", apprenticeshipValidTo: "2026-09-30" }), {
    ...confirmed, apprenticeshipStatus: "completed", apprenticeshipValidTo: "2026-09-30",
  });
});

test("Lehrlingsstatus: Bestätigung verlangt konkreten Status, Beginn und Grundlage", () => {
  for (const patch of [
    { apprenticeshipStatus: "unknown" }, { apprenticeshipValidFrom: "" }, { apprenticeshipSourceReference: "   " },
    { apprenticeshipStatus: "completed", apprenticeshipValidTo: "" },
  ]) invalid(() => normalize({ ...confirmed, ...patch }));
});

test("Lehrlingsstatus: Bestätigung akzeptiert ausschließlich echte Wahrheitswerte", () => {
  for (const value of ["true", "false", 1, 0, null, {}, []]) {
    invalid(() => normalize({ ...confirmed, apprenticeshipConfirmed: value }));
  }
  assert.equal(normalize({ apprenticeshipConfirmed: false }, confirmed).apprenticeshipConfirmed, false);
});

test("Lehrlingsstatus: Status und Datumsfelder sind kein frei interpretierter Text", () => {
  for (const status of ["Lehrling", "ACTIVE", "", true]) invalid(() => normalize({ apprenticeshipStatus: status }));
  for (const key of ["apprenticeshipValidFrom", "apprenticeshipValidTo", "apprenticeshipSourceReference"]) {
    invalid(() => normalize({ [key]: 123 }));
    invalid(() => normalize({ [key]: "synthetisch\0ungültig" }));
  }
});

test("Lehrlingsstatus: echte Kalenderdaten werden einschließlich Schaltjahren geprüft", () => {
  for (const date of ["2026-02-30", "2025-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "nicht-datiert"]) {
    for (const key of ["apprenticeshipValidFrom", "apprenticeshipValidTo"]) invalid(() => normalize({ [key]: date }));
  }
  const leap = normalize({ apprenticeshipValidFrom: "2028-02-29", apprenticeshipValidTo: "2028-03-01" });
  assert.equal(leap.apprenticeshipValidFrom, "2028-02-29");
  assert.equal(leap.apprenticeshipConfirmed, false);
});

test("Lehrlingsstatus: der Gültigkeitszeitraum darf nicht rückwärts laufen", () => {
  invalid(() => normalize({ apprenticeshipValidFrom: "2026-09-02", apprenticeshipValidTo: "2026-09-01" }));
  assert.equal(normalize({ apprenticeshipValidFrom: "2026-09-01", apprenticeshipValidTo: "2026-09-01" }).apprenticeshipValidTo, "2026-09-01");
});

test("Lehrlingsstatus: die Quelle bleibt begrenzt und wird ohne neue Bestätigung nicht erfunden", () => {
  assert.equal(normalize({ apprenticeshipSourceReference: "x".repeat(240) }).apprenticeshipSourceReference.length, 240);
  invalid(() => normalize({ apprenticeshipSourceReference: "x".repeat(241) }));
  const empty = normalize({ apprenticeshipSourceReference: "" }, confirmed);
  assert.equal(empty.apprenticeshipSourceReference, "");
  assert.equal(empty.apprenticeshipConfirmed, false);
});

test("Lehrlingsstatus: jede echte Basisänderung entkräftet eine ausgelassene Bestätigung", () => {
  const patches = [
    { apprenticeshipStatus: "not_apprentice" },
    { apprenticeshipValidFrom: "2026-10-01" },
    { apprenticeshipValidTo: "2026-12-31" },
    { apprenticeshipSourceReference: "neue synthetische Grundlage" },
  ];
  for (const patch of patches) {
    const result = normalize(patch, confirmed);
    assert.equal(result.apprenticeshipConfirmed, false, JSON.stringify(patch));
    for (const [key, value] of Object.entries(patch)) assert.equal(result[key], value);
    assert.equal(confirmed.apprenticeshipConfirmed, true, "Der Ausgangsdatensatz darf nicht mutiert werden.");
  }
});

test("Lehrlingsstatus: unveränderte und nur äußerlich getrimmte Werte bewahren die Bestätigung", () => {
  assert.deepEqual(normalize({}, confirmed), confirmed);
  for (const [key, value] of Object.entries(confirmed).filter(([key]) => key !== "apprenticeshipConfirmed")) {
    assert.deepEqual(normalize({ [key]: value }, confirmed), confirmed);
  }
  assert.deepEqual(normalize({ apprenticeshipStatus: " active ", apprenticeshipSourceReference: ` ${confirmed.apprenticeshipSourceReference} ` }, confirmed), confirmed);
});

test("Lehrlingsstatus: bewusste erneute Bestätigung validiert den vollständig zusammengeführten Stand", () => {
  const renewed = normalize({ apprenticeshipValidFrom: "2026-10-01", apprenticeshipConfirmed: true }, confirmed);
  assert.equal(renewed.apprenticeshipConfirmed, true);
  assert.equal(renewed.apprenticeshipValidFrom, "2026-10-01");
  invalid(() => normalize({ apprenticeshipSourceReference: "", apprenticeshipConfirmed: true }, confirmed));
  invalid(() => normalize({ apprenticeshipStatus: "completed", apprenticeshipConfirmed: true }, confirmed));
});

test("Lehrlingsstatus: Datenpflege allein aktiviert keine noch ungeklärte Bestätigung", () => {
  const result = normalize({ apprenticeshipValidFrom: "2026-10-01" }, { ...confirmed, apprenticeshipConfirmed: false });
  assert.equal(result.apprenticeshipConfirmed, false);
  const explicitlyUnconfirmed = normalize({ apprenticeshipStatus: "not_apprentice", apprenticeshipConfirmed: false }, confirmed);
  assert.equal(explicitlyUnconfirmed.apprenticeshipConfirmed, false);
});
