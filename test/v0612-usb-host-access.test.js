"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateUsbProvisioningAccess,
  isLoopbackHostAddress,
} = require("../lib/usb-provisioning");

test("v0.61.2 USB-Zugriff: Loopback-Adressen werden eindeutig erkannt", () => {
  for (const address of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::1%1",
  ]) {
    assert.equal(isLoopbackHostAddress(address), true, `${address} muss als Loopback gelten`);
  }

  for (const address of [
    "",
    "0.0.0.0",
    "192.168.0.10",
    "203.0.113.44",
    "::",
    "fe80::1",
    "::ffff:192.168.0.10",
  ]) {
    assert.equal(isLoopbackHostAddress(address), false, `${address || "leere Adresse"} darf nicht als Loopback gelten`);
  }
});

const accessScenarios = [
  {
    name: "Lokalbetrieb am Windows-Host ist erlaubt",
    input: {
      platform: "win32",
      operationMode: "local",
      deploymentKind: "local",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "127.0.0.1",
    },
    expected: { available: true, hostCapable: true, reasonCode: "" },
  },
  {
    name: "LAN-Betrieb am Windows-Host ist erlaubt",
    input: {
      platform: "win32",
      operationMode: "lan",
      deploymentKind: "local",
      requestPresent: true,
      socketAddress: "::ffff:127.0.0.1",
      clientAddress: "::1",
    },
    expected: { available: true, hostCapable: true, reasonCode: "" },
  },
  {
    name: "entfernter LAN-Client bleibt gesperrt",
    input: {
      platform: "win32",
      operationMode: "lan",
      deploymentKind: "local",
      requestPresent: true,
      socketAddress: "192.168.0.55",
      clientAddress: "192.168.0.55",
    },
    expected: { available: false, hostCapable: true, reasonCode: "USB_HOST_CONSOLE_REQUIRED" },
  },
  {
    name: "HTTPS-Server am Host hinter dem Reverse Proxy ist erlaubt",
    input: {
      platform: "win32",
      operationMode: "server",
      deploymentKind: "production",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "127.0.0.1",
      proxyChainPresent: true,
    },
    expected: { available: true, hostCapable: true, reasonCode: "" },
  },
  {
    name: "entfernter HTTPS-Client bleibt trotz lokalem Proxy-Socket gesperrt",
    input: {
      platform: "win32",
      operationMode: "server",
      deploymentKind: "production",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "203.0.113.44",
      proxyChainPresent: true,
    },
    expected: { available: false, hostCapable: true, reasonCode: "USB_HOST_CONSOLE_REQUIRED" },
  },
  {
    name: "HTTPS-Server ohne nachgewiesene Proxy-Kette bleibt gesperrt",
    input: {
      platform: "win32",
      operationMode: "server",
      deploymentKind: "production",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "127.0.0.1",
      proxyChainPresent: false,
    },
    expected: { available: false, hostCapable: true, reasonCode: "USB_HOST_CONSOLE_REQUIRED" },
  },
  {
    name: "Nicht-Windows-Hosts bleiben gesperrt",
    input: {
      platform: "linux",
      operationMode: "local",
      deploymentKind: "local",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "127.0.0.1",
    },
    expected: { available: false, hostCapable: false, reasonCode: "USB_WINDOWS_REQUIRED" },
  },
  {
    name: "Codespaces-Testbetrieb bleibt auch mit Windows- und Loopback-Werten gesperrt",
    input: {
      platform: "win32",
      operationMode: "server",
      deploymentKind: "codespaces-test",
      requestPresent: true,
      socketAddress: "127.0.0.1",
      clientAddress: "127.0.0.1",
      proxyChainPresent: true,
    },
    expected: { available: false, hostCapable: false, reasonCode: "USB_DEPLOYMENT_UNSUPPORTED" },
  },
];

for (const scenario of accessScenarios) {
  test(`v0.61.2 USB-Zugriff: ${scenario.name}`, () => {
    const result = evaluateUsbProvisioningAccess(scenario.input);

    assert.equal(result.available, scenario.expected.available);
    assert.equal(result.hostCapable, scenario.expected.hostCapable);
    assert.equal(result.localConsole, scenario.expected.available);
    assert.equal(result.reasonCode, scenario.expected.reasonCode);
    assert.equal(result.localOnly, true);
    assert.equal(result.requiresElevation, false);
    assert.equal(result.currentOperationMode, scenario.input.operationMode);
    assert.equal(result.targetOperationMode, "local");
  });
}
