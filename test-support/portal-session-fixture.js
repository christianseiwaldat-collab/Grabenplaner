"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// Synthetic browser sessions must follow the same token binding as a login.
// Keep this independent of the server implementation so HTTP tests detect drift.
function sessionCsrf(token) {
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0, "a synthetic session token is required");
  return crypto.createHash("sha256").update(`gp-browser-csrf-v2\0${token}`).digest("hex");
}

function sessionCsrfFromCookie(cookie) {
  const entry = String(cookie).split(";").map(value => value.trim())
    .find(value => value.startsWith("grabenplaner_session="));
  assert.ok(entry, "a synthetic session cookie is required");
  return sessionCsrf(decodeURIComponent(entry.slice("grabenplaner_session=".length)));
}

module.exports = { sessionCsrf, sessionCsrfFromCookie };
