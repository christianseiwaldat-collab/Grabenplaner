"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENGINE_VERSION,
  evaluateAumIdentity,
  identityFromTexts,
} = require("../lib/amu-identity-check");

const MATCHING_NUMBER = "1000010190";
const OTHER_NUMBER = "1009311299";

test("leitet serverseitig nur einen eindeutigen, beschrifteten SV-Kandidaten ab", () => {
  const result = identityFromTexts([
    "Name Erika Musterfrau\nVersicherungsnummer: 1000 010190\nDiagnose vertraulich",
    "Arbeitsunfähig von 10.07.2026 bis 17.07.2026",
  ]);

  assert.deepEqual(result, { status: "detected", candidate: MATCHING_NUMBER });
  assert.doesNotMatch(JSON.stringify(result), /Erika|Diagnose|vertraulich|Arbeitsunfähig/i);
});

test("stuft ungültige, unbeschriftete und widersprüchliche SV-Werte als nicht erkannt ein", () => {
  assert.deepEqual(identityFromTexts(["Versicherungsnummer: 1000 010191"]), {
    status: "not_detected",
    candidate: "",
  });
  assert.deepEqual(identityFromTexts([`Referenz ${MATCHING_NUMBER}`]), {
    status: "not_detected",
    candidate: "",
  });
  assert.deepEqual(identityFromTexts([
    `Versicherungsnummer: ${MATCHING_NUMBER}`,
    `SV-Nr.: ${OTHER_NUMBER}`,
  ]), {
    status: "not_detected",
    candidate: "",
  });
});

test("überspringt den Dokumentabgleich ohne im Personalakt hinterlegte SV-Nummer", async () => {
  let compareCalls = 0;
  const result = await evaluateAumIdentity([], {
    profileConfigured: false,
    compareCandidate() { compareCalls += 1; return true; },
  });

  assert.equal(result.status, "profile_missing");
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(compareCalls, 0);
  assert.equal(Object.hasOwn(result, "candidate"), false);
});

test("bewertet einen erkannten SV-Kandidaten ausschließlich als Trefferstatus", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFixture = process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT;
  process.env.NODE_ENV = "test";
  process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = `Versicherungsnummer: ${MATCHING_NUMBER}\nDiagnose vertraulich`;
  try {
    const observed = [];
    const matched = await evaluateAumIdentity([], {
      profileConfigured: true,
      compareCandidate(value) { observed.push(value); return value === MATCHING_NUMBER; },
    });
    const mismatch = await evaluateAumIdentity([], {
      profileConfigured: true,
      compareCandidate(value) { observed.push(value); return false; },
    });

    assert.deepEqual(observed, [MATCHING_NUMBER, MATCHING_NUMBER]);
    assert.equal(matched.status, "matched");
    assert.equal(mismatch.status, "mismatch");
    for (const result of [matched, mismatch]) {
      assert.equal(result.engineVersion, ENGINE_VERSION);
      assert.equal(Object.hasOwn(result, "candidate"), false);
      assert.doesNotMatch(JSON.stringify(result), /1000010190|Diagnose|vertraulich/i);
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFixture === undefined) delete process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT;
    else process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = previousFixture;
  }
});

test("lässt fehlende OCR-Treffer kontrolliert zur manuellen Prüfung offen", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFixture = process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT;
  process.env.NODE_ENV = "test";
  process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = "Versicherungsnummer unleserlich";
  try {
    const result = await evaluateAumIdentity([], {
      profileConfigured: true,
      compareCandidate() { throw new Error("darf ohne Kandidaten nicht aufgerufen werden"); },
    });
    assert.equal(result.status, "not_detected");
    assert.equal(Object.hasOwn(result, "candidate"), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFixture === undefined) delete process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT;
    else process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = previousFixture;
  }
});
