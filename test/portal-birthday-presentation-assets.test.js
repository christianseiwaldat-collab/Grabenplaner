"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "public", "assets", "birthday-presentations");
const presentationAssets = Object.freeze({
  dezent: "dezent.svg",
  elegant: "elegant.svg",
  farbenfroh: "farbenfroh.svg",
  fotowelt: "fotowelt.svg",
  technik: "technik.svg",
});

const forbiddenElements = /<(?:animate|animateMotion|animateTransform|audio|canvas|discard|embed|foreignObject|iframe|image|link|object|script|set|style|text|use|video)\b/iu;
const activeAttributes = /\s(?:href|src|style|on[a-z][a-z0-9:_-]*)\s*=/iu;
const externalReference = /(?:data:|file:|https?:|javascript:|vbscript:|\/\/|url\s*\()/iu;

test("Block 9: nur die fünf fest freigegebenen Geburtstagsgrafiken werden ausgeliefert", () => {
  assert.equal(Object.isFrozen(presentationAssets), true);
  assert.deepEqual(Object.keys(presentationAssets), [
    "dezent",
    "elegant",
    "farbenfroh",
    "fotowelt",
    "technik",
  ]);

  const files = fs.readdirSync(assetDirectory, { withFileTypes: true });
  assert.ok(files.every((entry) => entry.isFile()), "Der Assetordner darf keine Unterordner enthalten.");
  assert.deepEqual(
    files.map((entry) => entry.name).sort(),
    Object.values(presentationAssets).sort(),
  );
});

for (const [presentationId, fileName] of Object.entries(presentationAssets)) {
  test(`Block 9: ${presentationId} ist ein statisches, responsives Dekorations-SVG`, () => {
    const absolutePath = path.join(assetDirectory, fileName);
    const stats = fs.statSync(absolutePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    const rootTag = source.match(/^<svg\b[^>]*>/u)?.[0] || "";
    const contentWithoutNamespace = source.replace(
      /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u,
      "",
    );

    assert.equal(stats.isFile(), true);
    assert.ok(stats.size >= 800 && stats.size <= 20_000, "Unplausible SVG-Dateigröße.");
    assert.match(source, /^<svg\s/u);
    assert.match(source, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    assert.match(source, /viewBox="0 0 1440 900"/u);
    assert.match(source, /preserveAspectRatio="xMidYMid slice"/u);
    assert.match(source, /aria-hidden="true"/u);
    assert.match(source, /focusable="false"/u);
    assert.doesNotMatch(rootTag, /\s(?:width|height)\s*=/iu);
    assert.doesNotMatch(source, forbiddenElements);
    assert.doesNotMatch(source, activeAttributes);
    assert.doesNotMatch(contentWithoutNamespace, externalReference);
    assert.doesNotMatch(source, /\b(?:class|id|role|tabindex)\s*=/iu);
    assert.doesNotMatch(source, /\b(?:begin|dur|end|repeatCount|keyTimes|keySplines)\s*=/iu);
    assert.doesNotMatch(source, /(?:@font-face|font-family|currentColor|var\s*\()/iu);
    assert.doesNotMatch(source, /(?:Geburt|Mitarbeiter|Personalnummer|@|\b\d{4}-\d{2}-\d{2}\b)/iu);

    const textNodes = source
      .replace(/<[^>]+>/gu, "")
      .replace(/\s+/gu, "");
    assert.equal(textNodes, "", "Das SVG darf keine sichtbaren oder versteckten Texte enthalten.");
  });
}
