"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const serverFile = path.resolve(__dirname, "../server.js");
const serverSource = fs.readFileSync(serverFile, "utf8");
const hookStart = serverSource.indexOf("// Optional installation-private workspaces");
const hookEnd = serverSource.indexOf('app.get("/api/portal/v1/private-workspaces",', hookStart);
assert.ok(hookStart >= 0 && hookEnd > hookStart);
const hookSource = serverSource.slice(hookStart, hookEnd) + "\nmodule.exports = privateWorkspaces;";
const privateVariables = ["GRABENPLANER_PRIVATE_WORKSPACE_MODULE", "GRABENPLANER_PRIVATE_WORKSPACE_DATA_DIR", "GRABENPLANER_PRIVATE_IMAGE_KEY_FILE"];
const modulePath = path.resolve(__dirname, "../../synthetic-external/module.cjs");

function runHook({ deploymentKind = "production", environment = {}, missing = false } = {}) {
  const calls = [];
  const mounted = { list: () => [] };
  const context = {
    module: { exports: {} }, __dirname: path.dirname(serverFile), path, deploymentKind,
    process: { env: environment }, app: {}, integrationSecretVault: {},
    requireEmployeePortalSession() {}, assertPortalCsrf() {},
    fs: {
      lstatSync(file) {
        calls.push(["stat", file]);
        if (missing) throw Object.assign(new Error("synthetic absent external module"), { code: "ENOENT" });
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      realpathSync: file => file,
    },
    require(file) {
      calls.push(["require", file]);
      return { mount(app, options) {
        calls.push(["mount", app, options]);
        return mounted;
      } };
    },
  };
  vm.runInNewContext(hookSource, context, { filename: serverFile });
  return { calls, result: context.module.exports, mounted };
}

for (const [name, deploymentKind, isolation] of [
  ["recovery smoke", "recovery-smoke", {}],
  ["PostgreSQL rehearsal", "production", { GRABENPLANER_POSTGRESQL_REHEARSAL: "paired-restore" }],
  ["managed qualification restore root", "production", { GRABENPLANER_RESTORE_ROOT: "/run/synthetic-qualification" }],
]) test(name + " never stats, imports or mounts a configured external module", () => {
  const environment = { ...Object.fromEntries(privateVariables.map(key => [key, "/missing/private/" + key])), ...isolation };
  const result = runHook({ deploymentKind, environment, missing: true });
  assert.equal(result.result, null);
  assert.deepEqual(result.calls, []);
});

for (const deploymentKind of ["production", "local"]) test(deploymentKind + " retains the authenticated external mount outside qualification", () => {
  const result = runHook({ deploymentKind, environment: {
    GRABENPLANER_PRIVATE_WORKSPACE_MODULE: modulePath,
    GRABENPLANER_POSTGRESQL_REHEARSAL: "  ", GRABENPLANER_RESTORE_ROOT: "",
  } });
  assert.equal(result.result, result.mounted);
  assert.deepEqual(result.calls.map(call => call[0]), ["stat", "require", "mount"]);
  assert.equal(result.calls[1][1], modulePath);
  assert.equal(result.calls[2][2].applicationDirectory, path.dirname(serverFile));
  assert.equal(typeof result.calls[2][2].requireActor, "function");
  assert.equal(typeof result.calls[2][2].assertCsrf, "function");
});

test("an unconfigured installation performs no external file access", () => {
  const result = runHook();
  assert.equal(result.result, null);
  assert.deepEqual(result.calls, []);
});

test("a missing configured production module retains its startup failure", () => {
  assert.throws(() => runHook({ environment: { GRABENPLANER_PRIVATE_WORKSPACE_MODULE: modulePath }, missing: true }), { code: "ENOENT" });
});

const smokeFile = path.resolve(__dirname, "../server-tools/linux/recovery/lib/postgresql-application-smoke.js");
const smokeSource = fs.readFileSync(smokeFile, "utf8");
const smokeRequire = createRequire(smokeFile);

for (const managed of [false, true]) test((managed ? "managed" : "paired restore") + " qualification removes inherited private settings before requiring the server", async () => {
  const root = managed ? "/run/gp-postgresql-activation-qualification" : "/synthetic-restored/application";
  const reachedServer = new Error("synthetic require boundary");
  const environment = Object.fromEntries(privateVariables.map(key => [key, "/synthetic/private/" + key]));
  const encryption = ["GRABENPLANER_INTEGRATION_KEY=synthetic-vault-key", "GRABENPLANER_AMU_KEY_ID=synthetic-document-key",
    ...privateVariables.map(key => key + "=/must-not-import/" + key)].join("\n");
  let captured;
  const context = {
    module: { exports: {} },
    process: { env: environment, platform: "linux", memoryUsage: () => ({ heapUsed: 0, rss: 0 }) },
    require(name) {
      if (name === "node:fs") return {
        appendFileSync() {}, mkdirSync() {}, existsSync: () => false,
        readFileSync(file) { assert.equal(file, root + "/source-encryption.env"); return encryption; },
      };
      if (name === "node:os") return { userInfo: () => ({ username: "grabenplaner" }), networkInterfaces: () => ({ loopback: [{ internal: true }] }) };
      if (name === "./postgresql-smoke-diagnostics") return { smokeDiagnostics: () => ({ step() {} }) };
      if (name === "../../../../server") { captured = { ...environment }; throw reachedServer; }
      return smokeRequire(name);
    },
  };
  vm.runInNewContext(smokeSource, context, { filename: smokeFile });
  await assert.rejects(context.module.exports.qualifyHttp({ root, config: {}, managed }), error => error === reachedServer);
  for (const key of privateVariables) assert.equal(Object.hasOwn(captured, key), false, key);
  assert.equal(captured.GRABENPLANER_INTEGRATION_KEY, "synthetic-vault-key");
  assert.equal(captured.GRABENPLANER_AMU_KEY_ID, "synthetic-document-key");
  assert.equal(captured.GRABENPLANER_RESTORE_ROOT, root);
  assert.equal(captured.GRABENPLANER_DEPLOYMENT_KIND, managed ? "production" : "recovery-smoke");
});
