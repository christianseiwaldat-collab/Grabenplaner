"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");

const {
  MAX_LOAN_PHOTO_INPUT_BYTES,
  MAX_LOAN_PHOTO_OUTPUT_BYTES,
  MAX_LOAN_PHOTO_PIXELS,
  prepareLoanPhoto,
  scaledDimensions,
} = require("../lib/loan-photo");

test("Leihfotos werden gedreht, verkleinert und ohne Metadaten als JPEG gespeichert", async () => {
  const source = await sharp({
    create: {
      width: 3200,
      height: 2400,
      channels: 3,
      background: { r: 32, g: 118, b: 91 },
    },
  })
    .withMetadata({ orientation: 6, density: 300 })
    .png()
    .toBuffer();

  const result = await prepareLoanPhoto({
    buffer: source,
    originalName: "Leihfoto: Ausgabe?.png",
  });
  const metadata = await sharp(result.buffer).metadata();

  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.filename, "Leihfoto- Ausgabe-.jpg");
  assert.ok(result.byteSize <= MAX_LOAN_PHOTO_OUTPUT_BYTES);
  assert.ok(Number(metadata.width) * Number(metadata.height) <= MAX_LOAN_PHOTO_PIXELS);
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test("Leihfoto-Aufbereitung lehnt leere, zu große und unlesbare Dateien neutral ab", async () => {
  await assert.rejects(prepareLoanPhoto({ buffer: Buffer.alloc(0) }), {
    code: "LOAN_PHOTO_EMPTY",
  });
  await assert.rejects(
    prepareLoanPhoto({ buffer: Buffer.alloc(MAX_LOAN_PHOTO_INPUT_BYTES + 1) }),
    { code: "LOAN_PHOTO_TOO_LARGE", status: 413 },
  );
  await assert.rejects(
    prepareLoanPhoto({ buffer: Buffer.from("kein-foto") }),
    { code: "LOAN_PHOTO_INVALID", status: 415 },
  );
});

test("Leihfoto-Dimensionen bewahren das Seitenverhältnis innerhalb des Pixelbudgets", () => {
  assert.deepEqual(scaledDimensions(1000, 500), { width: 1000, height: 500 });
  const scaled = scaledDimensions(6000, 4000);
  assert.ok(scaled.width * scaled.height <= MAX_LOAN_PHOTO_PIXELS);
  assert.ok(Math.abs((scaled.width / scaled.height) - 1.5) < 0.01);
});
