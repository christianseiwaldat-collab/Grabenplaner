"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { viennaDate, resolvePeriod } = require("../lib/voice-assistant-dates");
const today = "2026-10-12";
for (const [name, instant, expected] of [
  ["summer midnight", "2026-10-11T22:05:00Z", "2026-10-12"],
  ["winter midnight", "2026-12-31T23:05:00Z", "2027-01-01"],
  ["DST autumn before midnight", "2026-10-25T22:30:00Z", "2026-10-25"],
  ["DST autumn after midnight", "2026-10-25T23:30:00Z", "2026-10-26"],
]) test(name + " uses Europe/Vienna", () => assert.equal(viennaDate(new Date(instant)), expected));
for (const [text, from, to] of [
  ["nächsten Freitag", "2026-10-16", "2026-10-16"],
  ["Freitag nächste Woche", "2026-10-23", "2026-10-23"],
  ["diesen Freitag", "2026-10-16", "2026-10-16"],
  ["nächste Woche", "2026-10-19", "2026-10-25"],
  ["morgen", "2026-10-13", "2026-10-13"],
  ["übermorgen", "2026-10-14", "2026-10-14"],
  ["19. bis 23. Oktober", "2026-10-19", "2026-10-23"],
  ["neunzehnten bis dreiundzwanzigsten Oktober", "2026-10-19", "2026-10-23"],
  ["19.10.2026 bis 23.10.2026", "2026-10-19", "2026-10-23"],
  ["2026-10-19 bis 2026-10-23", "2026-10-19", "2026-10-23"],
  ["31.12. bis 3.1.", "2026-12-31", "2027-01-03"],
  ["am 3. Jänner", "2027-01-03", "2027-01-03"],
]) test("resolves " + text, () => {
  const resolved = resolvePeriod(text, { today });
  assert.equal(resolved.dateFrom, from); assert.equal(resolved.dateTo, to); assert.equal(resolved.timeZone, "Europe/Vienna");
});
test("next Friday from a Friday means a future Friday with disclosed interpretation", () => {
  const value = resolvePeriod("nächsten Freitag", { today: "2026-10-16" });
  assert.equal(value.dateFrom, "2026-10-23"); assert(value.assumptions.length);
});
for (const expression of ["bald", "19. bis 23.", "31. Februar 2027", "29.2.2027", "2026-13-01", "23. bis 19. Oktober 2026", "2026-10-01 bis 2028-01-01"]) {
  test("rejects incomplete/invalid period " + expression, () => assert.throws(() => resolvePeriod(expression, { today }), { code: "ASSISTANT_DATE_UNCLEAR" }));
}
test("explicit past year is retained for existing GP horizon validation", () => assert.equal(resolvePeriod("19. Oktober 2025", { today }).dateFrom, "2025-10-19"));
