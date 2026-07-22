#!/usr/bin/env node
"use strict";

const MAX_INPUT_BYTES = 64 * 1024;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUIRED_VALUES = new Map([
  ["type", "drive"],
  ["scope", "drive.file"],
  ["client_id", "XXX"],
  ["client_secret", "XXX"],
  ["token", "XXX"],
]);
const FAILURE_MESSAGE = "Die redigierte rclone-Konfiguration entspricht nicht der freigegebenen OAuth-Richtlinie.\n";

function fail() {
  process.stderr.write(FAILURE_MESSAGE);
  process.exitCode = 1;
}

function parseRedactedConfig(text, expectedRemote) {
  if (!REMOTE_NAME_PATTERN.test(expectedRemote) || text.includes("\0")) return null;

  const values = new Map();
  let sectionCount = 0;
  let currentSection = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]$/);
    if (sectionMatch) {
      sectionCount += 1;
      if (sectionCount !== 1 || sectionMatch[1] !== expectedRemote) return null;
      currentSection = sectionMatch[1];
      continue;
    }

    if (currentSection !== expectedRemote) return null;
    const keyMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!keyMatch) return null;
    const [, key, value] = keyMatch;
    if (!REQUIRED_VALUES.has(key) || values.has(key)) return null;
    values.set(key, value);
  }

  if (sectionCount !== 1 || values.size !== REQUIRED_VALUES.size) return null;
  for (const [key, expectedValue] of REQUIRED_VALUES) {
    if (values.get(key) !== expectedValue) return null;
  }
  return {
    ok: true,
    dedicatedClient: true,
    provider: "google-drive",
    scope: "drive.file",
  };
}

if (process.argv.length !== 3 || !REMOTE_NAME_PATTERN.test(process.argv[2])) {
  fail();
} else {
  const chunks = [];
  let receivedBytes = 0;
  let rejected = false;

  process.stdin.on("data", (chunk) => {
    if (rejected) return;
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_INPUT_BYTES) {
      rejected = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });

  process.stdin.on("error", () => {
    rejected = true;
  });

  process.stdin.on("end", () => {
    if (rejected) {
      fail();
      return;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      fail();
      return;
    }
    const result = parseRedactedConfig(text, process.argv[2]);
    if (!result) {
      fail();
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}
