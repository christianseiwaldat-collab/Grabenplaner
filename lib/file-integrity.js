"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const HASH_BUFFER_BYTES = 1024 * 1024;

function unchanged(before, after) {
  return after.isFile() && !after.isSymbolicLink()
    && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

// Keep the existing synchronous backup contract, but never allocate a DB-sized
// Buffer. Read only the initial file length, and reject truncation/replacement.
function sha256File(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size)) {
    throw new Error("Die Pruefsummendatei ist keine regulaere Datei.");
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!unchanged(before, fs.fstatSync(descriptor))) {
      throw new Error("Die Pruefsummendatei wurde beim Oeffnen veraendert.");
    }
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    const hash = crypto.createHash("sha256");
    let position = 0;
    while (position < before.size) {
      const bytes = fs.readSync(descriptor, buffer, 0,
        Math.min(buffer.length, before.size - position), position);
      if (bytes <= 0) throw new Error("Die Pruefsummendatei endete unerwartet.");
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    if (!unchanged(before, fs.fstatSync(descriptor)) || !unchanged(before, fs.lstatSync(filePath))) {
      throw new Error("Die Pruefsummendatei wurde waehrend des Lesens veraendert.");
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { HASH_BUFFER_BYTES, sha256File };
