"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("v0.76 integrates the read-only assurance reader without blocking main readiness", () => {
  assert.match(server, /require\("\.\/lib\/recovery-assurance-status"\)/);
  assert.match(server, /readRecoveryAssuranceStatus\(\{ configured: offsiteConfigured \}\)/);
  assert.match(server, /id: "recovery-assurance"/);
  const readyFormula = server.match(/ready: startupIntegrity[\s\S]*?mode: portal\.operationMode/)?.[0] || "";
  assert.doesNotMatch(readyFormula, /recoveryAssurance/);
  const readiness = server.match(/function sendReadiness[\s\S]*?function sendLiveness/)?.[0] || "";
  assert.doesNotMatch(readiness, /recoveryAssurance/);
});

test("v0.76 public status exposes only the redacted assurance contract", () => {
  const summary = server.match(/function serverStatusSummary[\s\S]*?function sendReadiness/)?.[0] || "";
  assert.match(summary, /recoveryAssurance:/);
  for (const allowed of [
    "configured", "state", "statusAvailable", "integrityVerified", "severity", "generatedAt",
    "eventCount", "lastSequence", "lastErrorCode", "summary", "events",
  ]) assert.match(summary, new RegExp(allowed));
  for (const forbidden of ["signing-private", "signing-public", "privateKey", "publicKey", "eventHash", "previousHash", "keyId"]) {
    assert.equal(summary.includes(forbidden), false, forbidden);
  }
});
