"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource } = require("../test-support/learning-workspace-ui");

async function loadFor({ portalEnabled, permissions, statusFailure = false }) {
  const calls = [];
  const state = { portalSession: { user: { permissions } }, brandingKits: ["previous-account-kit"],
    locationId: "18", vacationYear: 2026, weekStart: "2026-08-10" };
  const context = vm.createContext({ state, Promise, encodeURIComponent,
    syncXoffiImport() {}, syncSettingsSaveScopes() {}, setDefaultContext() {}, render() {},
    restoreRememberedOverallContext() {}, settingsConfirmationReadToken: () => ({ key: "current" }),
    settingsSaveKey: () => "current", applyLoadedSchedule() {}, acknowledgeSettingsRead() {},
    enrichLoadedSchedule: async () => {}, contextQuery: () => "&location=18",
    canReadManagerRequests: () => false, canReadLoanManagement: () => false,
    canManageBranchOrders: () => false, showToast: message => assert.fail(message),
    api: async url => {
      calls.push(url);
      if (url === "/api/portal/v1/status") {
        if (statusFailure) throw new Error("transient status read failure");
        return { portalEnabled, installationFeatures: { vacation: false } };
      }
      if (url === "/api/locations") return [];
      if (url === "/api/portal/v1/roles") return { roles: [], catalog: [] };
      if (url.startsWith("/api/branding/kits")) return ["authorized-kit"];
      return [];
    },
  });
  vm.runInContext("let loadAllGeneration=0; let planningPeriodController=null;\n" + functionSource("loadAll"), context);
  await context.loadAll();
  return { calls, state };
}

test("planning bootstrap skips protected branding management reads and clears inherited kits without a read grant", async () => {
  const { calls, state } = await loadFor({ portalEnabled: true, permissions: ["branding:write"] });
  assert.equal(calls.some(url => url.startsWith("/api/branding/kits")), false);
  assert.deepEqual(Array.from(state.brandingKits), []);
  assert.ok(calls.includes("/api/employees"));
});

test("an explicit branding read grant retains the management kit request", async () => {
  const { calls, state } = await loadFor({ portalEnabled: true, permissions: ["branding:read"] });
  assert.equal(calls.filter(url => url.startsWith("/api/branding/kits")).length, 1);
  assert.deepEqual(state.brandingKits, ["authorized-kit"]);
});

test("local installations retain their branding kit request", async () => {
  const { calls } = await loadFor({ portalEnabled: false, permissions: [] });
  assert.equal(calls.filter(url => url.startsWith("/api/branding/kits")).length, 1);
});

test("an unknown portal status never implies a branding read grant", async () => {
  const { calls, state } = await loadFor({ portalEnabled: true, permissions: [], statusFailure: true });
  assert.equal(state.portalStatus, null);
  assert.equal(calls.some(url => url.startsWith("/api/branding/kits")), false);
  assert.deepEqual(Array.from(state.brandingKits), []);
  assert.ok(calls.includes("/api/employees"));
});
