"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const client = require(path.join(root, "lib", "offsite-target-client.js"));
const broker = require(path.join(
  root,
  "server-tools",
  "linux",
  "offsite",
  "lib",
  "offsite-target-broker.js",
));

const REQUEST_ID = "410d17bd-8eca-4f6a-9adf-9ab4ed897f63";
const NOW_MS = Date.parse("2026-07-26T16:00:00.000Z");
const LIVE_GOOGLE_REDACTED_CONFIG = [
  "[internal-drive]",
  "type = drive",
  "scope = drive.file",
  "client_id = XXX",
  "client_secret = XXX",
  "token = XXX",
  "",
].join("\n");
const LIVE_GOOGLE_CANONICAL_CONFIG = [
  "authentication=dedicated_oauth",
  "backend=drive",
  "client_id=XXX",
  "client_secret=XXX",
  "scope=drive.file",
  "token=XXX",
].join("\n");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function googleProviderBinding() {
  const policy = {
    format: "grabenplaner-offsite-rclone-provider-policy",
    schemaVersion: 1,
    providerId: "google_drive",
    remoteName: "internal-drive",
    backend: "drive",
    authentication: "dedicated_oauth",
    endpoint: null,
    region: null,
    scope: "drive.file",
    configSha256: crypto.createHash("sha256")
      .update(LIVE_GOOGLE_CANONICAL_CONFIG, "utf8")
      .digest("hex"),
  };
  return {
    format: "grabenplaner-offsite-provider-binding",
    schemaVersion: 1,
    providerId: "google_drive",
    remoteName: "internal-drive",
    backend: "drive",
    authentication: "dedicated_oauth",
    endpoint: null,
    region: null,
    scope: "drive.file",
    configSha256: policy.configSha256,
    policySha256: crypto.createHash("sha256")
      .update(canonicalJson(policy), "utf8")
      .digest("hex"),
    repositoryLayout: "google-drive-direct-safe-path-v1",
    storageRoot: null,
  };
}

function request(action = "status", parameters = {}, requestId = REQUEST_ID) {
  return Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action,
    requestId,
    parameters,
  })}\n`);
}

function writeProtected(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function fixture(repositoryPath = "Grabenplaner-Offsite/Aktiv_2026") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-target-control-"));
  const configRoot = path.join(temporary, "config");
  const runtimeRoot = path.join(temporary, "runtime");
  fs.mkdirSync(configRoot, { mode: 0o700 });
  fs.mkdirSync(runtimeRoot, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(configRoot, 0o700);
    fs.chmodSync(runtimeRoot, 0o755);
  }
  writeProtected(path.join(configRoot, "repository"), `rclone:internal-drive:${repositoryPath}\n`);
  writeProtected(path.join(configRoot, "repository-id"), "0123456789abcdef0123456789abcdef\n");
  writeProtected(path.join(configRoot, "rclone-config-password"), "this-is-a-private-test-password\n");
  writeProtected(path.join(configRoot, "installed-contract.json"), `${JSON.stringify({
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion: 6,
    fingerprint: "a".repeat(64),
    schemaSha256: "b".repeat(64),
    files: [],
    providerBinding: googleProviderBinding(),
  })}\n`);
  return {
    temporary,
    configRoot,
    runtimeRoot,
    statePath: path.join(runtimeRoot, "state.json"),
  };
}

function optionsFor(files, extra = {}) {
  const {
    liveRedactedConfig = LIVE_GOOGLE_REDACTED_CONFIG,
    runRclone: requestedRunRclone,
    ...rest
  } = extra;
  return {
    configRoot: files.configRoot,
    runtimeRoot: files.runtimeRoot,
    statePath: files.statePath,
    requireRootOwner: false,
    nowMs: NOW_MS,
    ...rest,
    runRclone(args, config, options) {
      if (args[0] === "config"
        && args[1] === "redacted"
        && args[2] === "internal-drive"
        && args.length === 3) {
        return { status: 0, stdout: liveRedactedConfig, stderr: "" };
      }
      if (typeof requestedRunRclone !== "function") {
        throw new Error("unexpected rclone operation");
      }
      return requestedRunRclone(args, config, options);
    },
  };
}

test("offsite target broker accepts only its exact bounded request schema", () => {
  assert.deepEqual(broker.parseRequest(request()), {
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "status",
    requestId: REQUEST_ID,
    parameters: {},
  });
  assert.deepEqual(broker.parseRequest(request("create-managed-folder", {
    folderLabel: "Archiv_2026-07",
  })).parameters, {
    folderLabel: "Archiv_2026-07",
  });
  assert.throws(() => broker.parseRequest(Buffer.from("{}\n")), { code: "TARGET_REQUEST_INVALID" });
  assert.throws(() => broker.parseRequest(Buffer.from(`${"x".repeat(broker.MAX_REQUEST_BYTES)}\n`)), {
    code: "TARGET_REQUEST_INVALID",
  });
  assert.throws(() => broker.parseRequest(Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "list-managed-folders",
    requestId: REQUEST_ID,
    parameters: {},
    remote: "attacker",
  })}\n`)), { code: "TARGET_REQUEST_INVALID" });
  for (const label of ["two words", "../escape", "Umlaut-\u00e4", "-leading", "trailing-", "x".repeat(49)]) {
    assert.throws(() => broker.parseRequest(request("create-managed-folder", { folderLabel: label })), {
      code: "TARGET_REQUEST_INVALID",
    });
  }
});

test("managed Google folder control stays fail-closed for every S3 provider", () => {
  for (const providerId of ["hetzner_object_storage", "backblaze_b2"]) {
    const files = fixture();
    try {
      let called = false;
      const result = broker.handleRequest(request("status"), optionsFor(files, {
        providerId,
        runRclone() {
          called = true;
          throw new Error("must not run");
        },
      }));
      assert.equal(result.ok, false);
      assert.equal(result.code, "TARGET_CONTROL_FAILED");
      assert.equal(called, false);
    } finally {
      fs.rmSync(files.temporary, { recursive: true, force: true });
    }
  }
});

test("root config derives the active managed label but never returns remote, path or repository id", () => {
  const files = fixture();
  try {
    const result = broker.handleRequest(request("status"), optionsFor(files));
    assert.equal(result.ok, true);
    assert.equal(result.code, "TARGET_CONTROL_READY");
    assert.equal(result.activeFolder, "Aktiv_2026");
    assert.deepEqual(result.folders, []);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /internal-drive/);
    assert.doesNotMatch(serialized, /Grabenplaner-Offsite/);
    assert.doesNotMatch(serialized, /0123456789abcdef/);
    assert.doesNotMatch(serialized, /private-test-password/);

    const outside = fixture("Legacy-Repository");
    try {
      const legacyResult = broker.handleRequest(request("status"), optionsFor(outside));
      assert.equal(legacyResult.activeFolder, null);
    } finally {
      fs.rmSync(outside.temporary, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("managed-folder listing is fixed below Grabenplaner-Offsite and strips rclone ids", () => {
  const files = fixture();
  const calls = [];
  try {
    const result = broker.handleRequest(request("list-managed-folders"), optionsFor(files, {
      runRclone(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Path: "Zukunft",
              Name: "Zukunft",
              IsDir: true,
              ID: "drive-folder-secret-2",
            },
            {
              Path: "Aktiv_2026",
              Name: "Aktiv_2026",
              IsDir: true,
              ID: "drive-folder-secret-1",
            },
          ]),
          stderr: "",
        };
      },
    }));
    assert.deepEqual(calls, [[
      "lsjson",
      "internal-drive:Grabenplaner-Offsite",
      "--dirs-only",
      "--max-depth",
      "1",
    ]]);
    assert.deepEqual(result.folders, ["Aktiv_2026", "Zukunft"]);
    assert.equal(result.activeFolder, "Aktiv_2026");
    assert.doesNotMatch(JSON.stringify(result), /drive-folder-secret|internal-drive|repository/i);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("managed-folder access fails closed before list or create when the live rclone policy drifts", () => {
  const driftedConfig = LIVE_GOOGLE_REDACTED_CONFIG.replace("scope = drive.file", "scope = drive");
  for (const [action, parameters] of [
    ["list-managed-folders", {}],
    ["create-managed-folder", { folderLabel: "Neu_2026" }],
  ]) {
    const files = fixture();
    let storageOperationCalled = false;
    try {
      const result = broker.handleRequest(request(action, parameters), optionsFor(files, {
        liveRedactedConfig: driftedConfig,
        runRclone() {
          storageOperationCalled = true;
          throw new Error("must not run after provider drift");
        },
      }));
      assert.equal(result.ok, false);
      assert.equal(result.code, "TARGET_CONTROL_FAILED");
      assert.equal(storageOperationCalled, false);
      assert.equal(fs.existsSync(`${files.statePath}.create`), false);
    } finally {
      fs.rmSync(files.temporary, { recursive: true, force: true });
    }
  }
});

test("managed-folder listing rejects installed-contract config or policy hash drift before storage access", () => {
  for (const field of ["configSha256", "policySha256"]) {
    const files = fixture();
    let storageOperationCalled = false;
    try {
      const receiptPath = path.join(files.configRoot, "installed-contract.json");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      receipt.providerBinding[field] = "f".repeat(64);
      writeProtected(receiptPath, `${JSON.stringify(receipt)}\n`);

      const result = broker.handleRequest(request("list-managed-folders"), optionsFor(files, {
        runRclone() {
          storageOperationCalled = true;
          throw new Error("must not run after contract drift");
        },
      }));
      assert.equal(result.ok, false, field);
      assert.equal(result.code, "TARGET_CONTROL_FAILED", field);
      assert.equal(storageOperationCalled, false, field);
    } finally {
      fs.rmSync(files.temporary, { recursive: true, force: true });
    }
  }
});

test("legacy repository with an absent managed prefix returns a successful empty folder list", () => {
  const files = fixture("Legacy-Repository");
  const calls = [];
  try {
    const result = broker.handleRequest(request("list-managed-folders"), optionsFor(files, {
      runRclone(args) {
        calls.push(args);
        return {
          status: 3,
          stdout: "",
          stderr: "directory not found",
        };
      },
    }));
    assert.deepEqual(calls, [[
      "lsjson",
      "internal-drive:Grabenplaner-Offsite",
      "--dirs-only",
      "--max-depth",
      "1",
    ]]);
    assert.equal(result.ok, true);
    assert.equal(result.code, "TARGET_FOLDERS_LISTED");
    assert.equal(result.activeFolder, null);
    assert.deepEqual(result.folders, []);

    const parsed = client.parseResponse(
      Buffer.from(`${JSON.stringify(result)}\n`),
      REQUEST_ID,
    );
    assert.equal(parsed.code, "TARGET_FOLDERS_LISTED");
    assert.equal(parsed.activeFolder, null);
    assert.deepEqual(parsed.folders, []);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("folder creation is ASCII-only, fixed-prefix and root-rate-limited before another mutation", () => {
  const files = fixture();
  const calls = [];
  try {
    const runRclone = (args) => {
      calls.push(args);
      if (args[0] === "lsjson") {
        return {
          status: 0,
          stdout: JSON.stringify([{ Path: "Aktiv_2026", Name: "Aktiv_2026", IsDir: true }]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const first = broker.handleRequest(
      request("create-managed-folder", { folderLabel: "Neu_2026-07" }),
      optionsFor(files, { runRclone }),
    );
    assert.equal(first.ok, true);
    assert.equal(first.code, "TARGET_FOLDER_CREATED");
    assert.equal(first.createdFolder, "Neu_2026-07");
    assert.deepEqual(calls[1], [
      "mkdir",
      "internal-drive:Grabenplaner-Offsite/Neu_2026-07",
    ]);

    const second = broker.handleRequest(
      request("create-managed-folder", { folderLabel: "Noch_Einer" }, crypto.randomUUID()),
      optionsFor(files, { runRclone, nowMs: NOW_MS + 15_000 }),
    );
    assert.equal(second.ok, false);
    assert.equal(second.code, "TARGET_REQUEST_RATE_LIMITED");
    assert.equal(second.retryAfterSeconds, 45);
    assert.equal(calls.filter((args) => args[0] === "mkdir").length, 1);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("folder creation fails closed at the 100-folder boundary before mkdir or rate-limit state", () => {
  const files = fixture();
  const calls = [];
  const folders = [
    { Path: "Aktiv_2026", Name: "Aktiv_2026", IsDir: true },
    ...Array.from({ length: broker.MAX_FOLDER_COUNT - 1 }, (_, index) => ({
      Path: `Ordner_${String(index).padStart(3, "0")}`,
      Name: `Ordner_${String(index).padStart(3, "0")}`,
      IsDir: true,
    })),
  ];
  try {
    const result = broker.handleRequest(
      request("create-managed-folder", { folderLabel: "Noch_Einer" }),
      optionsFor(files, {
        runRclone(args) {
          calls.push(args);
          return { status: 0, stdout: JSON.stringify(folders), stderr: "" };
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "TARGET_FOLDER_LIMIT_REACHED");
    assert.deepEqual(calls.map((args) => args[0]), ["lsjson"]);
    assert.equal(fs.existsSync(`${files.statePath}.create`), false);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("folder creation can be followed immediately by the separately rate-limited activation", () => {
  const files = fixture();
  try {
    const sharedOptions = {
      runRclone(args) {
        if (args[0] === "lsjson") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { Path: "Aktiv_2026", Name: "Aktiv_2026", IsDir: true },
              { Path: "Zukunft", Name: "Zukunft", IsDir: true },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runTargetSwitch() {
        writeProtected(
          path.join(files.configRoot, "repository"),
          "rclone:internal-drive:Grabenplaner-Offsite/Zukunft\n",
        );
        return {
          status: 0,
          stdout: `${JSON.stringify({
            format: broker.TARGET_SWITCH_FORMAT,
            schemaVersion: broker.TARGET_SWITCH_SCHEMA_VERSION,
            ok: true,
            code: "TARGET_FOLDER_ACTIVATED",
            migrationMode: "copied",
            recoverySetState: broker.TARGET_SWITCH_RECOVERY_SET_STATE,
            fallbackPreserved: true,
          })}\n`,
          stderr: "",
        };
      },
    };
    const created = broker.handleRequest(
      request("create-managed-folder", { folderLabel: "Neu_2026" }),
      optionsFor(files, sharedOptions),
    );
    assert.equal(created.code, "TARGET_FOLDER_CREATED");

    const activated = broker.handleRequest(
      request("activate-managed-folder", { folderLabel: "Zukunft" }, crypto.randomUUID()),
      optionsFor(files, { ...sharedOptions, nowMs: NOW_MS + 1_000 }),
    );
    assert.equal(activated.code, "TARGET_FOLDER_ACTIVATED");
    assert.equal(fs.existsSync(`${files.statePath}.create`), true);
    assert.equal(fs.existsSync(`${files.statePath}.activate`), true);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("activating the already active folder never reaches the root helper or rate-limit state", () => {
  const files = fixture();
  const switchCalls = [];
  try {
    const result = broker.handleRequest(
      request("activate-managed-folder", { folderLabel: "Aktiv_2026" }),
      optionsFor(files, {
        runRclone() {
          return {
            status: 0,
            stdout: JSON.stringify([
              { Path: "Aktiv_2026", Name: "Aktiv_2026", IsDir: true },
              { Path: "Zukunft", Name: "Zukunft", IsDir: true },
            ]),
            stderr: "",
          };
        },
        runTargetSwitch(folderLabel) {
          switchCalls.push(folderLabel);
          throw new Error("must not run");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "TARGET_FOLDER_ALREADY_ACTIVE");
    assert.deepEqual(switchCalls, []);
    assert.equal(fs.existsSync(`${files.statePath}.activate`), false);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("activation uses the exact privileged helper contract and confirms the prepared recovery set", () => {
  const files = fixture();
  const rcloneCalls = [];
  const switchCalls = [];
  try {
    const result = broker.handleRequest(
      request("activate-managed-folder", { folderLabel: "Zukunft" }),
      optionsFor(files, {
        runRclone(args) {
          rcloneCalls.push(args);
          return {
            status: 0,
            stdout: JSON.stringify([
              { Path: "Aktiv_2026", Name: "Aktiv_2026", IsDir: true },
              { Path: "Zukunft", Name: "Zukunft", IsDir: true },
            ]),
            stderr: "",
          };
        },
        runTargetSwitch(folderLabel) {
          switchCalls.push(folderLabel);
          writeProtected(
            path.join(files.configRoot, "repository"),
            "rclone:internal-drive:Grabenplaner-Offsite/Zukunft\n",
          );
          return {
            status: 0,
            stdout: `${JSON.stringify({
              format: broker.TARGET_SWITCH_FORMAT,
              schemaVersion: broker.TARGET_SWITCH_SCHEMA_VERSION,
              ok: true,
              code: "TARGET_FOLDER_ACTIVATED",
              migrationMode: "copied",
              recoverySetState: broker.TARGET_SWITCH_RECOVERY_SET_STATE,
              fallbackPreserved: true,
            })}\n`,
            stderr: "",
          };
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.code, "TARGET_FOLDER_ACTIVATED");
    assert.equal(result.activeFolder, "Zukunft");
    assert.deepEqual(result.folders, ["Aktiv_2026", "Zukunft"]);
    assert.equal(result.migrationMode, "copied");
    assert.equal(result.recoverySetState, "pending-offline-transfer-and-verification");
    assert.equal(result.fallbackPreserved, true);
    assert.deepEqual(switchCalls, ["Zukunft"]);
    assert.equal(rcloneCalls.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(`${files.statePath}.activate`, "utf8")).lastAction, "activate-managed-folder");
    assert.doesNotMatch(JSON.stringify(result), /internal-drive|Grabenplaner-Offsite\/|repository-id/i);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("activation helper receives exactly the fixed label CLI and a bounded long timeout", () => {
  const calls = [];
  const result = broker.defaultRunTargetSwitch("Zukunft", {
    targetSwitchSpawnSync(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify({
          format: broker.TARGET_SWITCH_FORMAT,
          schemaVersion: broker.TARGET_SWITCH_SCHEMA_VERSION,
          ok: true,
          code: "TARGET_FOLDER_ACTIVATED",
          migrationMode: "verified-existing",
          recoverySetState: broker.TARGET_SWITCH_RECOVERY_SET_STATE,
          fallbackPreserved: true,
        })}\n`,
        stderr: "",
      };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, broker.TARGET_SWITCH_HELPER);
  assert.deepEqual(calls[0].args, ["--folder-label", "Zukunft"]);
  assert.equal(calls[0].options.timeout, 31 * 60 * 1000);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("activation rejects non-exact, secret-bearing or contradictory helper output", () => {
  const valid = {
    format: broker.TARGET_SWITCH_FORMAT,
    schemaVersion: broker.TARGET_SWITCH_SCHEMA_VERSION,
    ok: true,
    code: "TARGET_FOLDER_ACTIVATED",
    migrationMode: "copied",
    recoverySetState: broker.TARGET_SWITCH_RECOVERY_SET_STATE,
    fallbackPreserved: true,
  };
  assert.deepEqual(
    broker.parseTargetSwitchResult({ status: 0, stdout: `${JSON.stringify(valid)}\n`, stderr: "" }),
    valid,
  );
  assert.throws(() => broker.parseTargetSwitchResult({
    status: 0,
    stdout: `${JSON.stringify({ ...valid, repositoryId: "secret-id" })}\n`,
    stderr: "",
  }), { code: "TARGET_CONTROL_FAILED" });
  assert.throws(() => broker.parseTargetSwitchResult({
    status: 0,
    stdout: `${JSON.stringify({ ...valid, fallbackPreserved: false })}\n`,
    stderr: "",
  }), { code: "TARGET_CONTROL_FAILED" });
  assert.throws(() => broker.parseTargetSwitchResult({
    status: 0,
    stdout: `${JSON.stringify({ ...valid, migrationMode: "already-active" })}\n`,
    stderr: "",
  }), { code: "TARGET_CONTROL_FAILED" });
});

test("client rejects non-canonical or secret-bearing broker responses", () => {
  const valid = {
    format: client.RESPONSE_FORMAT,
    schemaVersion: client.SCHEMA_VERSION,
    requestId: REQUEST_ID,
    ok: true,
    code: "TARGET_FOLDERS_LISTED",
    generatedAt: "2026-07-26T16:00:00.000Z",
    activeFolder: "Aktiv_2026",
    folders: ["Aktiv_2026", "Zukunft"],
    createdFolder: null,
    retryAfterSeconds: null,
    migrationMode: null,
    recoverySetState: null,
    fallbackPreserved: false,
  };
  assert.deepEqual(
    client.parseResponse(Buffer.from(`${JSON.stringify(valid)}\n`), REQUEST_ID),
    valid,
  );
  const activated = {
    ...valid,
    code: "TARGET_FOLDER_ACTIVATED",
    migrationMode: "copied",
    recoverySetState: client.TARGET_SWITCH_RECOVERY_SET_STATE,
    fallbackPreserved: true,
  };
  assert.deepEqual(
    client.parseResponse(Buffer.from(`${JSON.stringify(activated)}\n`), REQUEST_ID),
    activated,
  );
  assert.throws(() => client.parseResponse(Buffer.from(`${JSON.stringify({
    ...activated,
    fallbackPreserved: false,
  })}\n`), REQUEST_ID), {
    code: "TARGET_CONTROL_RESPONSE_INVALID",
  });
  assert.throws(() => client.parseResponse(Buffer.from(`${JSON.stringify({
    ...valid,
    remote: "private-drive",
  })}\n`), REQUEST_ID), {
    code: "TARGET_CONTROL_RESPONSE_INVALID",
  });
  assert.throws(() => client.parseResponse(Buffer.from(`${JSON.stringify({
    ...valid,
    folders: ["Zukunft", "Aktiv_2026"],
  })}\n`), REQUEST_ID), {
    code: "TARGET_CONTROL_RESPONSE_INVALID",
  });
  for (const code of ["TARGET_FOLDER_ALREADY_ACTIVE", "TARGET_FOLDER_LIMIT_REACHED"]) {
    const rejected = {
      ...valid,
      ok: false,
      code,
      activeFolder: null,
      folders: [],
    };
    assert.deepEqual(
      client.parseResponse(Buffer.from(`${JSON.stringify(rejected)}\n`), REQUEST_ID),
      rejected,
    );
  }
  assert.throws(() => client.parseResponse(Buffer.alloc(client.MAX_RESPONSE_BYTES + 1, 1), REQUEST_ID), {
    code: "TARGET_CONTROL_RESPONSE_INVALID",
  });
});

test("target-control client keeps the response half of a delayed Unix socket open", {
  skip: process.platform !== "linux",
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-target-socket-"));
  const socketPath = path.join(temporary, "request.sock");
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const requestValue = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      setTimeout(() => socket.end(`${JSON.stringify({
        format: client.RESPONSE_FORMAT,
        schemaVersion: client.SCHEMA_VERSION,
        requestId: requestValue.requestId,
        ok: true,
        code: "TARGET_FOLDERS_LISTED",
        generatedAt: "2026-07-30T18:00:00.000Z",
        activeFolder: null,
        folders: [],
        createdFolder: null,
        retryAfterSeconds: null,
        migrationMode: null,
        recoverySetState: null,
        fallbackPreserved: false,
      })}\n`), 25);
    });
  });
  try {
    fs.chmodSync(temporary, 0o755);
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    fs.chmodSync(socketPath, 0o660);
    const result = await client.requestOffsiteTargetControl("list-managed-folders", {}, {
      allowNonLinux: true,
      socketPath,
      requireRootOwner: false,
      expectedGid: process.getgid(),
      timeoutMs: 3000,
    });
    assert.equal(result.code, "TARGET_FOLDERS_LISTED");
    assert.deepEqual(result.folders, []);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("target-control broker waits for output flush and handles an early peer close", async () => {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.toString("utf8");
      setImmediate(callback);
    },
  });
  await broker.writeStandardOutput({ ok: true }, output);
  assert.equal(written, '{"ok":true}\n');

  const closedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      const error = new Error("closed");
      error.code = "EPIPE";
      callback(error);
    },
  });
  await assert.rejects(
    broker.writeStandardOutput({ ok: false }, closedOutput),
    { name: "OffsiteTargetBrokerError", code: "TARGET_CONTROL_FAILED" },
  );
});

test("default rclone runner drops privileges and removes its transient password copy", () => {
  const files = fixture();
  const config = broker.readRootConfig(optionsFor(files));
  const calls = [];
  try {
    const result = broker.defaultRunRclone(["lsjson", "internal-drive:Grabenplaner-Offsite"], config, optionsFor(files, {
      platform: "linux",
      identitySpawnSync(command, args) {
        return { status: 0, stdout: args[0] === "-u" ? "1001\n" : "1002\n" };
      },
      chownSync() {},
      chmodSync(target, mode) {
        fs.chmodSync(target, mode);
      },
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        return {
          isDirectory: () => stat.isDirectory(),
          isSymbolicLink: () => stat.isSymbolicLink(),
          mode: (stat.mode & ~0o7777) | 0o700,
          uid: 0,
          gid: 0,
        };
      },
      rcloneSpawnSync(command, args, spawnOptions) {
        calls.push({ command, args, spawnOptions });
        const credentialEntry = args.find((entry) => entry.startsWith("CREDENTIALS_DIRECTORY="));
        const credentialDirectory = credentialEntry.slice("CREDENTIALS_DIRECTORY=".length);
        assert.equal(fs.readFileSync(path.join(credentialDirectory, "rclone-config-password"), "utf8"), "this-is-a-private-test-password\n");
        return { status: 0, stdout: "[]", stderr: "" };
      },
    }));
    assert.equal(result.status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/sbin/runuser");
    assert.deepEqual(calls[0].args.slice(0, 4), [
      "--user",
      "grabenplaner-offsite",
      "--",
      "/usr/bin/env",
    ]);
    assert.equal(calls[0].args.includes("this-is-a-private-test-password"), false);
    assert.deepEqual(
      fs.readdirSync(files.runtimeRoot).filter((entry) => entry.startsWith("credentials.")),
      [],
    );
  } finally {
    config.password.fill(0);
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});

test("credential cleanup reclaims only the validated temp directory before removal", () => {
  const files = fixture();
  const temporary = fs.mkdtempSync(path.join(files.runtimeRoot, "credentials."));
  const secret = path.join(temporary, "rclone-config-password");
  fs.writeFileSync(secret, "temporary-secret\n", { mode: 0o400 });
  const calls = [];
  try {
    broker.safeRemoveCredentials(temporary, files.runtimeRoot, {
      platform: "linux",
      chownSync(target, uid, gid) {
        calls.push({ action: "chown", target, uid, gid });
      },
      chmodSync(target, mode) {
        calls.push({ action: "chmod", target, mode });
        fs.chmodSync(target, mode);
      },
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        return {
          isDirectory: () => stat.isDirectory(),
          isSymbolicLink: () => stat.isSymbolicLink(),
          mode: (stat.mode & ~0o7777) | 0o700,
          uid: 0,
          gid: 0,
        };
      },
    });
    assert.deepEqual(calls, [
      { action: "chown", target: temporary, uid: 0, gid: 0 },
      { action: "chmod", target: temporary, mode: 0o700 },
    ]);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    fs.rmSync(files.temporary, { recursive: true, force: true });
  }
});
