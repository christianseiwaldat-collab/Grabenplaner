"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ENUMERATE_USB_VOLUMES_POWERSHELL,
  FORMAT_USB_VOLUME_POWERSHELL,
  USB_VOLUME_LABEL,
  assertFormatConfirmation,
  classifyUsbVolumes,
  createSelectionToken,
  enumerateWindowsVolumes,
  expectedFormatConfirmation,
  formatUsbVolume,
  provisionUsbStick,
  stagePortableInstallation,
  verifyHashManifest,
  verifySelectionToken,
} = require("../lib/usb-provisioning");

const TOKEN_SECRET = "usb-provisioning-test-secret-32-bytes-minimum";

function safeCandidate(overrides = {}) {
  return {
    driveLetter: "E:",
    driveType: 2,
    driveTypeName: "Removable",
    busType: "USB",
    interfaceType: "USB",
    pnpDeviceId: "USBSTOR\\DISK&VEN_TEST",
    mediaType: "Removable Media",
    volumeId: "\\\\?\\Volume{safe-test-volume}\\",
    volumeSerialNumber: "A1B2C3D4",
    label: "ALTER STICK",
    fileSystem: "FAT32",
    diskNumber: 7,
    partitionNumber: 1,
    diskUniqueId: "disk-unique-test-7",
    diskSerialNumber: "USB-SERIAL-7",
    diskFriendlyName: "Test USB Stick",
    partitionCount: 1,
    sizeBytes: 16 * 1024 * 1024 * 1024,
    freeBytes: 12 * 1024 * 1024 * 1024,
    isBoot: false,
    isSystem: false,
    isReadOnly: false,
    isOffline: false,
    containsPageFile: false,
    ...overrides,
  };
}

function createPortableSource(root) {
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "server.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "grabenplaner", version: "0.61.1-beta" }));
  fs.writeFileSync(path.join(root, "Dienstplan starten.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(root, "Grabenplaner v0.61.1 Beta starten.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(root, "public", "index.html"), "<!doctype html><title>Grabenplaner</title>");
  fs.writeFileSync(path.join(root, "lib", "core.js"), "module.exports = true;\n");
  fs.writeFileSync(path.join(root, "runtime", "node.exe"), "test-runtime");
  fs.writeFileSync(path.join(root, "data", "sensitive.db"), "must-not-be-copied");
  fs.writeFileSync(path.join(root, "release", "old.zip"), "must-not-be-copied");
  fs.writeFileSync(path.join(root, ".git", "config"), "must-not-be-copied");
}

function copyDirectoryContents(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true, force: true });
  }
}

test("v0.61.1 USB: PowerShell arbeitet im aktuellen Benutzerkontext und ohne Elevation", () => {
  for (const script of [ENUMERATE_USB_VOLUMES_POWERSHELL, FORMAT_USB_VOLUME_POWERSHELL]) {
    assert.doesNotMatch(script, /\bRunAs\b|Verb\s+RunAs|\bdiskpart\b|Register-ScheduledTask|New-Service/i);
  }
  assert.match(ENUMERATE_USB_VOLUMES_POWERSHELL, /Get-Volume/);
  assert.match(ENUMERATE_USB_VOLUMES_POWERSHELL, /Get-Partition/);
  assert.match(ENUMERATE_USB_VOLUMES_POWERSHELL, /Get-Disk/);
  assert.match(FORMAT_USB_VOLUME_POWERSHELL, /Format-Volume/);
  assert.match(FORMAT_USB_VOLUME_POWERSHELL, /-FileSystem NTFS/);
  assert.match(FORMAT_USB_VOLUME_POWERSHELL, /-NewFileSystemLabel 'Grabenplaner'/);
});

test("v0.61.1 USB: Enumeration ist injizierbar und benoetigt im Test kein echtes PowerShell", async () => {
  let called = 0;
  const volumes = await enumerateWindowsVolumes({
    platform: "win32",
    execPowerShell: async (script, args) => {
      called += 1;
      assert.equal(script, ENUMERATE_USB_VOLUMES_POWERSHELL);
      assert.deepEqual(args, []);
      return { stdout: JSON.stringify([safeCandidate()]), stderr: "" };
    },
  });
  assert.equal(called, 1);
  assert.equal(volumes[0].driveLetter, "E:");
  assert.equal(volumes[0].diskNumber, 7);
});

test("v0.61.1 USB: Kandidatenfilter schliesst System-, App-, Daten- und unsichere Laufwerke aus", () => {
  const valid = safeCandidate();
  const system = safeCandidate({ driveLetter: "C:", isSystem: true, diskNumber: 0, diskUniqueId: "system" });
  const appDrive = safeCandidate({ driveLetter: "D:", diskNumber: 4, diskUniqueId: "app" });
  const dataDrive = safeCandidate({ driveLetter: "F:", diskNumber: 5, diskUniqueId: "data" });
  const internal = safeCandidate({ driveLetter: "G:", driveType: 3, driveTypeName: "Fixed", busType: "SATA", interfaceType: "SCSI", diskNumber: 6 });
  const readOnly = safeCandidate({ driveLetter: "H:", isReadOnly: true, diskNumber: 8 });
  const multipart = safeCandidate({ driveLetter: "I:", partitionCount: 2, diskNumber: 9 });
  const result = classifyUsbVolumes([valid, system, appDrive, dataDrive, internal, readOnly, multipart], {
    appPath: "D:\\Grabenplaner\\app",
    dataPath: "F:\\Grabenplaner-Daten",
    systemDrive: "C:",
  });
  assert.deepEqual(result.candidates.map((item) => item.driveLetter), ["E:"]);
  const rejected = Object.fromEntries(result.rejected.map((item) => [item.driveLetter, item.reasons]));
  assert.ok(rejected["C:"].includes("system-volume"));
  assert.ok(rejected["D:"].includes("excluded-drive"));
  assert.ok(rejected["F:"].includes("excluded-drive"));
  assert.ok(rejected["G:"].includes("not-usb"));
  assert.ok(rejected["H:"].includes("read-only"));
  assert.ok(rejected["I:"].includes("multiple-partitions"));
});

test("v0.61.1 USB: HMAC-Auswahltoken ist befristet, manipulationssicher und an die Laufwerksidentitaet gebunden", () => {
  const candidate = safeCandidate();
  const token = createSelectionToken(candidate, TOKEN_SECRET, { now: 1_000, ttlMs: 10_000, nonce: "fixed-test-nonce" });
  assert.equal(verifySelectionToken(token, candidate, TOKEN_SECRET, { now: 5_000 }).identity.driveLetter, "E:");

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifySelectionToken(tampered, candidate, TOKEN_SECRET, { now: 5_000 }), { code: "USB_TOKEN_INVALID" });
  assert.throws(() => verifySelectionToken(token, candidate, TOKEN_SECRET, { now: 12_000 }), { code: "USB_TOKEN_EXPIRED" });
  assert.throws(
    () => verifySelectionToken(token, safeCandidate({ volumeSerialNumber: "CHANGED" }), TOKEN_SECRET, { now: 5_000 }),
    { code: "USB_SELECTION_CHANGED" },
  );
});

test("v0.61.1 USB: Formatierbestaetigung muss exakt zum Laufwerk passen", () => {
  assert.equal(expectedFormatConfirmation("e"), "FORMATIEREN E:");
  assert.equal(assertFormatConfirmation("FORMATIEREN E:", "E:"), true);
  assert.throws(() => assertFormatConfirmation(" FORMATIEREN E:", "E:"), { code: "USB_CONFIRMATION_INVALID" });
  assert.throws(() => assertFormatConfirmation("formatieren E:", "E:"), { code: "USB_CONFIRMATION_INVALID" });
  assert.throws(() => assertFormatConfirmation("FORMATIEREN F:", "E:"), { code: "USB_CONFIRMATION_INVALID" });
});

test("v0.61.1 USB: Format-Volume wird nur ueber den injizierten aktuellen PowerShell-Helfer aufgerufen", async () => {
  const candidate = safeCandidate();
  let invocation;
  const formatted = await formatUsbVolume(candidate, {
    appPath: "D:\\Grabenplaner\\app",
    dataPath: "D:\\Grabenplaner\\app\\data",
    execPowerShell: async (script, args, options) => {
      invocation = { script, args, options };
      return {
        stdout: JSON.stringify({
          ...candidate,
          volumeId: "\\\\?\\Volume{formatted-test-volume}\\",
          volumeSerialNumber: "FFEEDDCC",
          label: USB_VOLUME_LABEL,
          fileSystem: "NTFS",
        }),
      };
    },
  });
  assert.equal(invocation.script, FORMAT_USB_VOLUME_POWERSHELL);
  assert.equal(invocation.args[0], "E:");
  assert.match(invocation.args.at(-1), /C:|D:/);
  assert.ok(invocation.options.timeoutMs >= 600_000);
  assert.equal(formatted.label, USB_VOLUME_LABEL);
  assert.equal(formatted.fileSystem, "NTFS");
  await assert.rejects(
    formatUsbVolume(candidate, {
      execPowerShell: async () => ({ stdout: JSON.stringify({ ...candidate, diskSerialNumber: "OTHER-USB" }) }),
    }),
    { code: "USB_FORMAT_RESULT_CHANGED" },
  );
});

test("v0.61.1 USB: Installationsstufe entsteht vor dem Formatieren mit minimalem Root und Hashmanifest", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-stage-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const stages = path.join(temp, "stages");
  fs.mkdirSync(stages);
  createPortableSource(source);
  const stage = await stagePortableInstallation({
    sourceAppDirectory: source,
    stagingParent: stages,
    firstStepsPdfBuffer: Buffer.from("%PDF-1.4\n% test\n"),
    prepareApp: async ({ appDirectory }) => {
      fs.writeFileSync(path.join(appDirectory, "data", "dienstplan.db"), "fresh-demo-db");
    },
    manifestMetadata: { profile: "planung-und-urlaub" },
  });

  assert.ok(fs.existsSync(path.join(stage.stageRoot, "app")));
  assert.ok(fs.existsSync(path.join(stage.stageRoot, "Backups")));
  assert.ok(fs.existsSync(path.join(stage.stageRoot, "PDF-Exporte")));
  assert.ok(fs.existsSync(path.join(stage.stageRoot, "Grabenplaner starten.cmd")));
  assert.ok(fs.existsSync(path.join(stage.stageRoot, "Erste Schritte.pdf")));
  assert.ok(fs.existsSync(path.join(stage.stageRoot, "app", "data", "dienstplan.db")));
  assert.equal(fs.existsSync(path.join(stage.stageRoot, "app", "data", "sensitive.db")), false);
  assert.equal(fs.existsSync(path.join(stage.stageRoot, "app", "release", "old.zip")), false);
  assert.equal(fs.existsSync(path.join(stage.stageRoot, "app", ".git")), false);
  assert.equal(verifyHashManifest(stage.stageRoot, stage.manifest).ok, true);

  fs.writeFileSync(path.join(stage.stageRoot, "app", "unexpected.exe"), "not-in-manifest");
  assert.throws(() => verifyHashManifest(stage.stageRoot, stage.manifest), { code: "USB_HASH_VERIFICATION_FAILED" });
  fs.rmSync(path.join(stage.stageRoot, "app", "unexpected.exe"));
  fs.writeFileSync(path.join(stage.stageRoot, "app", "server.js"), "tampered");
  assert.throws(() => verifyHashManifest(stage.stageRoot, stage.manifest), { code: "USB_HASH_VERIFICATION_FAILED" });
});

test("v0.61.1 USB: Provisionierung revalidiert vor Formatierung und nutzt in Tests nur Mocks", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-provision-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const stages = path.join(temp, "stages");
  const target = path.join(temp, "virtual-usb");
  fs.mkdirSync(stages);
  fs.mkdirSync(target);
  createPortableSource(source);
  const stage = await stagePortableInstallation({ sourceAppDirectory: source, stagingParent: stages });
  const selected = safeCandidate();
  const formatted = safeCandidate({
    volumeId: "\\\\?\\Volume{new-formatted-volume}\\",
    volumeSerialNumber: "NEW12345",
    label: USB_VOLUME_LABEL,
    fileSystem: "NTFS",
  });
  const token = createSelectionToken(selected, TOKEN_SECRET, { now: 1000, ttlMs: 10000, nonce: "provision-test" });
  const calls = [];
  let enumerationCount = 0;

  const result = await provisionUsbStick({
    stage,
    selectionToken: token,
    tokenSecret: TOKEN_SECRET,
    confirmation: "FORMATIEREN E:",
    now: 2000,
    enumerateCandidates: async () => {
      enumerationCount += 1;
      calls.push("enumerate");
      return { candidates: [enumerationCount === 1 ? selected : formatted], rejected: [] };
    },
    consumeToken: async (payload) => {
      calls.push(`consume:${payload.nonce}`);
    },
    formatVolume: async () => {
      calls.push("format-mock");
      return formatted;
    },
    targetRootForVolume: async () => target,
    copyStage: async (stageRoot, targetRoot) => {
      calls.push("copy-mock");
      copyDirectoryContents(stageRoot, targetRoot);
    },
    hideApp: async (appDirectory) => {
      calls.push("hide-mock");
      assert.equal(appDirectory, path.join(target, "app"));
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.verification.ok, true);
  assert.deepEqual(calls, [
    "enumerate",
    "consume:provision-test",
    "format-mock",
    "enumerate",
    "copy-mock",
    "enumerate",
    "hide-mock",
  ]);
  assert.ok(fs.existsSync(path.join(target, "Grabenplaner starten.cmd")));
});

test("v0.61.1 USB: zu kleiner Datentraeger stoppt garantiert vor dem Formatieren", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-capacity-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const stages = path.join(temp, "stages");
  fs.mkdirSync(stages);
  createPortableSource(source);
  const stage = await stagePortableInstallation({ sourceAppDirectory: source, stagingParent: stages });
  const candidate = safeCandidate({ sizeBytes: 1, freeBytes: 1 });
  let formatCalls = 0;
  await assert.rejects(
    provisionUsbStick({
      stage,
      selectionToken: createSelectionToken(candidate, TOKEN_SECRET, {
        now: 1000,
        ttlMs: 10000,
        candidateOptions: { minimumSizeBytes: 0 },
      }),
      tokenSecret: TOKEN_SECRET,
      confirmation: "FORMATIEREN E:",
      now: 2000,
      enumerateCandidates: async () => ({ candidates: [candidate], rejected: [] }),
      formatVolume: async () => { formatCalls += 1; return candidate; },
    }),
    { code: "USB_CAPACITY_INSUFFICIENT" },
  );
  assert.equal(formatCalls, 0);
});

test("v0.61.1 USB: Datentraegerwechsel nach Formatierung stoppt vor dem Kopieren", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-swap-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const stages = path.join(temp, "stages");
  fs.mkdirSync(stages);
  createPortableSource(source);
  const stage = await stagePortableInstallation({ sourceAppDirectory: source, stagingParent: stages });
  const candidate = safeCandidate();
  const formatted = safeCandidate({
    volumeId: "\\\\?\\Volume{formatted-volume}\\",
    volumeSerialNumber: "FORMATTED",
    label: USB_VOLUME_LABEL,
    fileSystem: "NTFS",
  });
  const swapped = safeCandidate({
    diskUniqueId: "another-disk",
    diskSerialNumber: "ANOTHER-USB",
    volumeId: "\\\\?\\Volume{swapped-volume}\\",
    volumeSerialNumber: "SWAPPED",
    label: USB_VOLUME_LABEL,
    fileSystem: "NTFS",
  });
  let enumerationCount = 0;
  let copyCalls = 0;
  await assert.rejects(
    provisionUsbStick({
      stage,
      selectionToken: createSelectionToken(candidate, TOKEN_SECRET, { now: 1000, ttlMs: 10000 }),
      tokenSecret: TOKEN_SECRET,
      confirmation: "FORMATIEREN E:",
      now: 2000,
      enumerateCandidates: async () => {
        enumerationCount += 1;
        return { candidates: [enumerationCount === 1 ? candidate : swapped], rejected: [] };
      },
      formatVolume: async () => formatted,
      copyStage: async () => { copyCalls += 1; },
    }),
    { code: "USB_PHYSICAL_DEVICE_CHANGED" },
  );
  assert.equal(copyCalls, 0);
});

test("v0.61.1 USB: Manipulierte Stage stoppt garantiert vor dem Formatier-Helfer", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-preformat-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const stages = path.join(temp, "stages");
  fs.mkdirSync(stages);
  createPortableSource(source);
  const stage = await stagePortableInstallation({ sourceAppDirectory: source, stagingParent: stages });
  fs.writeFileSync(path.join(stage.stageRoot, "app", "server.js"), "changed-after-staging");
  const candidate = safeCandidate();
  let formatCalls = 0;
  await assert.rejects(
    provisionUsbStick({
      stage,
      selectionToken: createSelectionToken(candidate, TOKEN_SECRET, { now: 1000, ttlMs: 10000 }),
      tokenSecret: TOKEN_SECRET,
      confirmation: "FORMATIEREN E:",
      now: 2000,
      enumerateCandidates: async () => ({ candidates: [candidate], rejected: [] }),
      formatVolume: async () => { formatCalls += 1; return candidate; },
    }),
    { code: "USB_HASH_VERIFICATION_FAILED" },
  );
  assert.equal(formatCalls, 0);
});
