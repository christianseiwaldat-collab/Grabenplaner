"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "server-tools", "linux", "offsite", "lib", "offsite-rclone-policy.js");
const remote = "gpdrive";
const failureMessage = "Die redigierte rclone-Konfiguration entspricht keiner freigegebenen Provider-Richtlinie.\n";

function validGoogleConfig(overrides = {}, extraLines = []) {
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

function validS3Config({
  endpoint = "fsn1.your-objectstorage.com",
  region = "fsn1",
  accessKeyId = "XXX",
  provider = "Other",
  extraLines = [],
} = {}) {
  return [
    `[${remote}]`,
    "type = s3",
    `provider = ${provider}`,
    "env_auth = false",
    `access_key_id = ${accessKeyId}`,
    "secret_access_key = XXX",
    `region = ${region}`,
    `endpoint = ${endpoint}`,
    "acl = private",
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
  assert.equal(result.stderr, failureMessage);
}

function assertPolicy(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "authentication",
    "backend",
    "configSha256",
    "endpoint",
    "format",
    "providerId",
    "region",
    "remoteName",
    "schemaVersion",
    "scope",
  ]);
  assert.equal(value.format, "grabenplaner-offsite-rclone-provider-policy");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.remoteName, remote);
  assert.match(value.configSha256, /^[a-f0-9]{64}$/);
  for (const [key, expectedValue] of Object.entries(expected)) assert.equal(value[key], expectedValue);
  return value;
}

test("Google Drive still requires a dedicated OAuth client and exactly drive.file", () => {
  assertPolicy(run(validGoogleConfig()), {
    providerId: "google_drive",
    backend: "drive",
    authentication: "dedicated_oauth",
    endpoint: null,
    region: null,
    scope: "drive.file",
  });
});

test("Google Drive accepts rclone's redaction comment and inactive empty team_drive only", () => {
  assertPolicy(run(`${validGoogleConfig({}, ["team_drive ="])}# token expires at a redacted time\n`), {
    providerId: "google_drive",
    backend: "drive",
    authentication: "dedicated_oauth",
    endpoint: null,
    region: null,
    scope: "drive.file",
  });
});

test("only fixed Hetzner EU endpoints with their matching region are accepted", () => {
  for (const region of ["fsn1", "nbg1", "hel1"]) {
    const compatible = assertPolicy(run(validS3Config({
      endpoint: `https://${region}.your-objectstorage.com`,
      region,
      accessKeyId: "HTZR0123456789ABCDEF",
    })), {
      providerId: "hetzner_object_storage",
      backend: "s3",
      authentication: "static_access_key",
      endpoint: `${region}.your-objectstorage.com`,
      region,
      scope: null,
    });
    const official = assertPolicy(run(validS3Config({
      endpoint: `${region}.your-objectstorage.com`,
      region,
      accessKeyId: "HTZR0123456789ABCDEF",
      provider: "Hetzner",
    }).replace(`region = ${region}\n`, "")), {
      providerId: "hetzner_object_storage",
      backend: "s3",
      authentication: "static_access_key",
      endpoint: `${region}.your-objectstorage.com`,
      region,
      scope: null,
    });
    assert.equal(official.configSha256, compatible.configSha256);
  }
});

test("only Backblaze B2 EU Central is accepted", () => {
  assertPolicy(run(validS3Config({
    endpoint: "s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    accessKeyId: "0040123456789abcdef012345",
  })), {
    providerId: "backblaze_b2",
    backend: "s3",
    authentication: "static_access_key",
    endpoint: "s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    scope: null,
  });
});

test("custom, non-EU, mismatched or insecure S3 endpoints stay fail-closed", () => {
  for (const input of [
    validS3Config({ endpoint: "s3.example.invalid", region: "eu-central-1" }),
    validS3Config({ endpoint: "http://fsn1.your-objectstorage.com", region: "fsn1" }),
    validS3Config({ endpoint: "fsn1.your-objectstorage.com/tenant", region: "fsn1" }),
    validS3Config({ endpoint: "fsn1.your-objectstorage.com", region: "nbg1" }),
    validS3Config({ endpoint: "s3.us-west-004.backblazeb2.com", region: "us-west-004" }),
    validS3Config({ provider: "AWS" }),
    validS3Config({
      endpoint: "s3.eu-central-003.backblazeb2.com",
      region: "eu-central-003",
      provider: "Hetzner",
    }),
    validS3Config({ provider: "Hetzner", region: "nbg1" }),
    validS3Config({ extraLines: ["force_path_style = true"] }),
    validS3Config({ extraLines: ["unknown_option = XXX"] }),
    validS3Config().replace("env_auth = false", "env_auth = true"),
    validS3Config().replace("acl = private", "acl = public-read"),
  ]) {
    assertRejected(run(input));
  }
});

test("Google rejects shared clients, broader scopes and alternate authentication", () => {
  for (const input of [
    validGoogleConfig({ client_id: null, client_secret: null }),
    validGoogleConfig({ client_id: null }),
    validGoogleConfig({ client_secret: null }),
    validGoogleConfig({ token: null }),
    validGoogleConfig({ scope: "drive" }),
    validGoogleConfig({ scope: "drive.file,drive.readonly" }),
    validGoogleConfig({ client_id: "not-redacted" }),
    validGoogleConfig({ client_secret: "not-redacted" }),
    validGoogleConfig({ token: "not-redacted" }),
  ]) {
    assertRejected(run(input));
  }
  for (const key of [
    "auth_url",
    "token_url",
    "client_credentials",
    "service_account_file",
    "service_account_credentials",
    "env_auth",
    "impersonate",
    "root_folder_id",
    "unknown_option",
  ]) {
    assertRejected(run(validGoogleConfig({}, [`${key} = XXX`])));
  }
});

test("active, duplicated or disguised shared-drive settings are rejected", () => {
  for (const input of [
    validGoogleConfig({}, ["team_drive = XXX"]),
    validGoogleConfig({}, ["team_drive =", "team_drive ="]),
    validGoogleConfig({}, ["team_drive = shared-drive-id"]),
    validGoogleConfig({}, ["unknown_option ="]),
  ]) {
    assertRejected(run(input));
  }
});

test("mismatched, repeated or malformed sections and keys are rejected", () => {
  const duplicateKey = validGoogleConfig({}, ["scope = drive.file"]);
  const duplicateSection = `${validGoogleConfig()}\n${validGoogleConfig()}`;
  const secondSection = `${validGoogleConfig()}\n[other]\ntype = drive\n`;
  const wrongSection = validGoogleConfig().replace(`[${remote}]`, "[other]");
  const keyBeforeSection = `type = drive\n${validGoogleConfig()}`;
  const malformedLine = `${validGoogleConfig()}unexpected line\n`;
  for (const input of [duplicateKey, duplicateSection, secondSection, wrongSection, keyBeforeSection, malformedLine]) {
    assertRejected(run(input));
  }
});

test("remote argument and input bounds remain strict", () => {
  for (const args of [[], [remote, "extra"], ["drive:name"], ["../drive"], ["_drive"], ["a".repeat(65)]]) {
    assertRejected(run(validGoogleConfig(), args));
  }
  assertRejected(run(Buffer.alloc(64 * 1024 + 1, 0x41)));
  assertRejected(run(Buffer.from(`[${remote}]\ntype = drive\0\n`, "utf8")));
  assertRejected(run(Buffer.from([0xff, 0xfe, 0xfd])));
});

test("provider validation never reflects OAuth or S3 credential material", () => {
  const secrets = [
    "client-id-sensitive-value.apps.googleusercontent.com",
    "client-secret-sensitive-value",
    "refresh-token-sensitive-value",
    "s3-secret-sensitive-value",
  ];
  const google = run([
    `[${remote}]`,
    "type = drive",
    `client_id = ${secrets[0]}`,
    `client_secret = ${secrets[1]}`,
    "scope = drive.file",
    `token = ${secrets[2]}`,
    "",
  ].join("\n"));
  const s3 = run(validS3Config().replace("secret_access_key = XXX", `secret_access_key = ${secrets[3]}`));
  for (const result of [google, s3]) {
    assertRejected(result);
    const combined = `${result.stdout}${result.stderr}`;
    for (const secret of secrets) assert.equal(combined.includes(secret), false);
  }
});
