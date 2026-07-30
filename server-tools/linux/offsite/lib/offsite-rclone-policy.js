#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const MAX_INPUT_BYTES = 64 * 1024;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const FORMAT = "grabenplaner-offsite-rclone-provider-policy";
const SCHEMA_VERSION = 1;
const FAILURE_MESSAGE = "Die redigierte rclone-Konfiguration entspricht keiner freigegebenen Provider-Richtlinie.\n";
const S3_PROVIDERS = Object.freeze(new Map([
  ["fsn1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "fsn1",
  })],
  ["nbg1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "nbg1",
  })],
  ["hel1.your-objectstorage.com", Object.freeze({
    providerId: "hetzner_object_storage",
    region: "hel1",
  })],
  ["s3.eu-central-003.backblazeb2.com", Object.freeze({
    providerId: "backblaze_b2",
    region: "eu-central-003",
  })],
]));

function fail() {
  process.stderr.write(FAILURE_MESSAGE);
  process.exitCode = 1;
}

function exactKeys(values, required, optional = new Set()) {
  if (required.size + optional.size < values.size) return false;
  for (const key of values.keys()) {
    if (!required.has(key) && !optional.has(key)) return false;
  }
  return [...required].every((key) => values.has(key));
}

function normalizeEndpoint(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^http:\/\//i.test(value)) return null;
  const withoutScheme = value.replace(/^https:\/\//i, "");
  if (withoutScheme.endsWith("/") || withoutScheme.includes("/")
    || withoutScheme !== withoutScheme.toLowerCase()) {
    return null;
  }
  return withoutScheme;
}

function canonicalPolicy({
  providerId,
  remoteName,
  backend,
  authentication,
  endpoint = null,
  region = null,
  scope = null,
  canonicalConfig,
}) {
  const configSha256 = crypto.createHash("sha256").update(canonicalConfig, "utf8").digest("hex");
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    providerId,
    remoteName,
    backend,
    authentication,
    endpoint,
    region,
    scope,
    configSha256,
  };
}

function googleDrivePolicy(values, expectedRemote) {
  const required = new Set(["type", "scope", "client_id", "client_secret", "token"]);
  const optional = new Set(["team_drive"]);
  if (!exactKeys(values, required, optional)
    || values.get("type") !== "drive"
    || values.get("scope") !== "drive.file"
    || values.get("client_id") !== "XXX"
    || values.get("client_secret") !== "XXX"
    || values.get("token") !== "XXX"
    || (values.has("team_drive") && values.get("team_drive") !== "")) {
    return null;
  }
  return canonicalPolicy({
    providerId: "google_drive",
    remoteName: expectedRemote,
    backend: "drive",
    authentication: "dedicated_oauth",
    scope: "drive.file",
    canonicalConfig: [
      "authentication=dedicated_oauth",
      "backend=drive",
      "client_id=XXX",
      "client_secret=XXX",
      "scope=drive.file",
      "token=XXX",
    ].join("\n"),
  });
}

function s3Policy(values, expectedRemote) {
  const required = new Set([
    "type",
    "provider",
    "access_key_id",
    "secret_access_key",
    "endpoint",
  ]);
  const optional = new Set(["acl", "env_auth", "region"]);
  if (!exactKeys(values, required, optional)
    || values.get("type") !== "s3"
    || values.get("secret_access_key") !== "XXX"
    || (!["XXX", undefined].includes(values.get("access_key_id"))
      && !ACCESS_KEY_PATTERN.test(values.get("access_key_id")))
    || (values.has("env_auth") && values.get("env_auth") !== "false")
    || (values.has("acl") && values.get("acl") !== "private")) {
    return null;
  }
  const endpoint = normalizeEndpoint(values.get("endpoint"));
  const selected = endpoint ? S3_PROVIDERS.get(endpoint) : null;
  const configuredProvider = values.get("provider");
  const configuredRegion = values.get("region");
  const providerAccepted = selected?.providerId === "hetzner_object_storage"
    ? configuredProvider === "Other" || configuredProvider === "Hetzner"
    : configuredProvider === "Other";
  const regionAccepted = configuredRegion === selected?.region
    || (selected?.providerId === "hetzner_object_storage"
      && configuredProvider === "Hetzner"
      && (configuredRegion === undefined || configuredRegion === ""));
  if (!selected || !providerAccepted || !regionAccepted) return null;
  return canonicalPolicy({
    providerId: selected.providerId,
    remoteName: expectedRemote,
    backend: "s3",
    authentication: "static_access_key",
    endpoint,
    region: selected.region,
    canonicalConfig: [
      "acl=private",
      "access_key_id=REDACTED",
      "authentication=static_access_key",
      "backend=s3",
      `endpoint=${endpoint}`,
      "env_auth=false",
      `provider=${selected.providerId === "hetzner_object_storage" ? "hetzner_fixed" : "Other"}`,
      `region=${selected.region}`,
      "secret_access_key=XXX",
    ].join("\n"),
  });
}

function parseRedactedConfig(text, expectedRemote) {
  if (!REMOTE_NAME_PATTERN.test(expectedRemote) || text.includes("\0")) return null;

  const values = new Map();
  const seenKeys = new Set();
  let sectionCount = 0;
  let currentSection = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

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
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
    values.set(key, value);
  }

  if (sectionCount !== 1) return null;
  if (values.get("type") === "drive") return googleDrivePolicy(values, expectedRemote);
  if (values.get("type") === "s3") return s3Policy(values, expectedRemote);
  return null;
}

function main() {
  if (process.argv.length !== 3 || !REMOTE_NAME_PATTERN.test(process.argv[2])) {
    fail();
    return;
  }
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

if (require.main === module) {
  main();
}

module.exports = {
  FORMAT,
  MAX_INPUT_BYTES,
  REMOTE_NAME_PATTERN,
  SCHEMA_VERSION,
  parseRedactedConfig,
};
