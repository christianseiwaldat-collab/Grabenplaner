"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");

const {
  MAX_CANDIDATE_PHOTO_INPUT_BYTES,
  MAX_CANDIDATE_PHOTO_OUTPUT_BYTES,
  MAX_CANDIDATE_PHOTO_EDGE,
  prepareCandidatePhoto,
} = require("../lib/candidate-photo");

test("Bewerberfoto wird gedreht, verkleinert und ohne Metadaten als JPEG gespeichert", async () => {
  const source = await sharp({
    create: {
      width: 2400,
      height: 1600,
      channels: 3,
      background: { r: 35, g: 118, b: 91 },
    },
  })
    .withMetadata({ orientation: 6, density: 300 })
    .png()
    .toBuffer();

  const result = await prepareCandidatePhoto({
    buffer: source,
    originalName: "Bewerberfoto: Test?.png",
  });
  const metadata = await sharp(result.buffer).metadata();

  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.filename, "Bewerberfoto- Test-.jpg");
  assert.equal(result.byteSize, result.buffer.length);
  assert.ok(result.byteSize <= MAX_CANDIDATE_PHOTO_OUTPUT_BYTES);
  assert.ok(result.width <= MAX_CANDIDATE_PHOTO_EDGE);
  assert.ok(result.height <= MAX_CANDIDATE_PHOTO_EDGE);
  assert.equal(result.width, metadata.width);
  assert.equal(result.height, metadata.height);
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.xmp, undefined);
});

test("Bewerberfoto lehnt leere, unlesbare, nicht zugelassene und zu große Eingaben ab", async () => {
  await assert.rejects(
    prepareCandidatePhoto({ buffer: Buffer.alloc(0) }),
    { code: "CANDIDATE_PHOTO_EMPTY" },
  );
  await assert.rejects(
    prepareCandidatePhoto({ buffer: Buffer.from("kein Bild", "utf8") }),
    { code: "CANDIDATE_PHOTO_INVALID", status: 415 },
  );

  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  );
  await assert.rejects(
    prepareCandidatePhoto({ buffer: gif, originalName: "foto.gif" }),
    { code: "CANDIDATE_PHOTO_FORMAT_UNSUPPORTED", status: 415 },
  );
  await assert.rejects(
    prepareCandidatePhoto({
      buffer: Buffer.alloc(MAX_CANDIDATE_PHOTO_INPUT_BYTES + 1),
      originalName: "zu-gross.jpg",
    }),
    { code: "CANDIDATE_PHOTO_TOO_LARGE", status: 413 },
  );
});
