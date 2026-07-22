"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "server-tools", "linux", "offsite", "lib", "offsite-rclone-policy.js");
const remote = "gpdrive";

function validConfig(overrides = {}, extraLines = []) {
  const values = {
    type: "drive",
    client_id: "XXX",
    client_secret: "XXX",
    scope: "drive.file",
    token: "XXX",
    ...overrides,
  };
  return [
    `[${remote}]`,
    ...Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => `${key} = ${value}`),
    ...extraLines,
    "",
  ].join("\n");
}

function run(input, args = [remote]) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
}

function assertRejected(result) {
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Die redigierte rclone-Konfiguration entspricht nicht der freigegebenen OAuth-Richtlinie.\n");
}

test("v0.76 accepts only the dedicated Google Drive OAuth policy", () => {
  const result = run(validConfig());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    dedicatedClient: true,
    provider: "google-drive",
    scope: "drive.file",
  });
});

test("v0.78.3 accepts rclone's own redaction comment and inactive empty team_drive field", () => {
  const result = run(`${validConfig({}, ["team_drive ="])}# token expires at a redacted time\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    dedicatedClient: true,
    provider: "google-drive",
    scope: "drive.file",
  });
});

test("v0.76 rejects shared-client, incomplete and non-drive.file configurations", () => {
  for (const input of [
    validConfig({ client_id: null, client_secret: null }),
    validConfig({ client_id: null }),
    validConfig({ client_secret: null }),
    validConfig({ token: null }),
    validConfig({ type: "s3" }),
    validConfig({ scope: "drive" }),
    validConfig({ scope: "drive.file,drive.readonly" }),
    validConfig({ client_id: "not-redacted" }),
    validConfig({ client_secret: "not-redacted" }),
    validConfig({ token: "not-redacted" }),
  ]) {
    assertRejected(run(input));
  }
});

test("v0.76 rejects alternate authentication and unapproved configuration fields", () => {
  for (const key of [
    "auth_url",
    "token_url",
    "client_credentials",
    "service_account_file",
    "service_account_credentials",
    "env_auth",
    "impersonate",
    "root_folder_id",
    "team_drive",
    "unknown_option",
  ]) {
    assertRejected(run(validConfig({}, [`${key} = XXX`])));
  }
});

test("v0.78.3 rejects active, duplicated or disguised shared-drive settings", () => {
  for (const input of [
    validConfig({}, ["team_drive = XXX"]),
    validConfig({}, ["team_drive =", "team_drive ="]),
    validConfig({}, ["team_drive = shared-drive-id"]),
    validConfig({}, ["unknown_option ="]),
  ]) {
    assertRejected(run(input));
  }
});

test("v0.76 rejects mismatched, repeated or malformed sections and keys", () => {
  const duplicateKey = validConfig({}, ["scope = drive.file"]);
  const duplicateSection = `${validConfig()}\n${validConfig()}`;
  const secondSection = `${validConfig()}\n[other]\ntype = drive\n`;
  const wrongSection = validConfig().replace(`[${remote}]`, "[other]");
  const keyBeforeSection = `type = drive\n${validConfig()}`;
  const malformedLine = `${validConfig()}unexpected line\n`;
  for (const input of [duplicateKey, duplicateSection, secondSection, wrongSection, keyBeforeSection, malformedLine]) {
    assertRejected(run(input));
  }
});

test("v0.76 strictly validates the remote CLI argument", () => {
  for (const args of [[], [remote, "extra"], ["drive:name"], ["../drive"], ["_drive"], ["a".repeat(65)]]) {
    assertRejected(run(validConfig(), args));
  }
});

test("v0.76 rejects oversized, binary and invalid UTF-8 input", () => {
  assertRejected(run(Buffer.alloc(64 * 1024 + 1, 0x41)));
  assertRejected(run(Buffer.from(`[${remote}]\ntype = drive\0\n`, "utf8")));
  assertRejected(run(Buffer.from([0xff, 0xfe, 0xfd])));
});

test("v0.76 never reflects OAuth material in output or errors", () => {
  const secrets = [
    "client-id-sensitive-value.apps.googleusercontent.com",
    "client-secret-sensitive-value",
    "refresh-token-sensitive-value",
  ];
  const result = run([
    `[${remote}]`,
    "type = drive",
    `client_id = ${secrets[0]}`,
    `client_secret = ${secrets[1]}`,
    "scope = drive.file",
    `token = ${secrets[2]}`,
    "",
  ].join("\n"));
  assertRejected(result);
  const combined = `${result.stdout}${result.stderr}`;
  for (const secret of secrets) assert.equal(combined.includes(secret), false);
});
