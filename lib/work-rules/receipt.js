"use strict";

const { createHash } = require("node:crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

module.exports = {
  canonicalSha256: fingerprint,
  canonicalJson,
  canonicalize,
  fingerprint,
};
