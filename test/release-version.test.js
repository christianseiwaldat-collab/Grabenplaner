const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyRelease,
  compareVersions,
  normalizeVersionTag,
  selectLatestRelease,
} = require("../lib/release-version");

test("Updater: kurze Beta-Tags und Patchstände werden vergleichbar normalisiert", () => {
  assert.equal(normalizeVersionTag("v0.59-beta"), "0.59.0-beta");
  assert.equal(normalizeVersionTag("v0.59.1-beta"), "0.59.1-beta");
  assert.equal(compareVersions("v0.59.1-beta", "0.59.0-beta"), 1);
  assert.equal(compareVersions("v0.59-beta", "0.59.0-beta"), 0);
});

test("Updater: Serviceupdates bleiben eigene, aufsteigend sortierte Releases", () => {
  const selected = selectLatestRelease([
    { tagName: "v0.59-beta", name: "Grabenplaner v0.59 Beta", publishedAt: "2026-07-15T00:00:00Z" },
    { tagName: "v0.59.1-beta", name: "Serviceupdate · Grabenplaner v0.59.1 Beta", publishedAt: "2026-07-15T12:00:00Z" },
    { tagName: "v0.60-beta", name: "Entwurf", isDraft: true, publishedAt: "2026-07-16T00:00:00Z" },
  ]);

  assert.equal(selected.tagName, "v0.59.1-beta");
  assert.deepEqual(classifyRelease(selected), { kind: "service", label: "Serviceupdate" });
});

test("Updater: Sicherheitskennzeichnung hat Vorrang vor der Patchnummer", () => {
  assert.deepEqual(
    classifyRelease({ tagName: "v0.59.2-beta", name: "Sicherheitsupdate · Grabenplaner v0.59.2 Beta" }),
    { kind: "security", label: "Sicherheitsupdate" },
  );
});

test("Updater: reguläre Minor-Versionen bleiben Funktionsreleases", () => {
  assert.deepEqual(
    classifyRelease({ tagName: "v0.60-beta", name: "Grabenplaner v0.60 Beta" }),
    { kind: "feature", label: "Neue Version" },
  );
});
