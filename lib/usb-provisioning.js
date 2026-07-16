"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const USB_VOLUME_LABEL = "Grabenplaner";
const USB_SELECTION_TOKEN_VERSION = 1;
const DEFAULT_SELECTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const MIN_USB_SIZE_BYTES = 256 * 1024 * 1024;
const MIN_USB_FREE_RESERVE_BYTES = 64 * 1024 * 1024;
const HASH_MANIFEST_FORMAT = "grabenplaner-usb-hash-manifest";
const HASH_MANIFEST_RELATIVE_PATH = "app/data/usb-installation-manifest.json";
const REQUIRED_PORTABLE_DIRECTORIES = Object.freeze(["app", "Backups", "PDF-Exporte"]);
const DEFAULT_PORTABLE_DIRECTORIES = Object.freeze([
  "lib",
  "public",
  "node_modules",
  "runtime",
  "server-tools",
  "docs",
]);
const DEFAULT_PORTABLE_FILES = Object.freeze([
  "server.js",
  "backup.js",
  "package.json",
  "Dienstplan starten.cmd",
  "Backup erstellen.cmd",
]);
const PORTABLE_DOCUMENT_FILES = Object.freeze([
  "README.md",
  "LICENSE.md",
  "SECURITY.md",
  "SERVERBETRIEB.md",
  "USB-HINWEISE.txt",
  "VERSIONS-LOG.md",
  "CODESPACES.md",
]);

class UsbProvisioningError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "UsbProvisioningError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function usbError(code, message, details) {
  return new UsbProvisioningError(code, message, details);
}

function normalizeDriveLetter(value) {
  const match = String(value || "").trim().match(/^([a-z]):?(?:[\\/])?$/i);
  return match ? `${match[1].toUpperCase()}:` : "";
}

function driveLetterFromPath(value) {
  const match = String(value || "").trim().match(/^([a-z]):[\\/]/i);
  return match ? `${match[1].toUpperCase()}:` : "";
}

function driveRoot(value) {
  const letter = normalizeDriveLetter(value);
  if (!letter) throw usbError("USB_DRIVE_INVALID", "Der Laufwerksbuchstabe ist ungueltig.");
  return `${letter}\\`;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(1|true|yes)$/i.test(String(value || "").trim());
}

function normalizeHostAddress(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "")
    .split("%", 1)[0]
    .toLowerCase();
}

function isLoopbackHostAddress(value) {
  const address = normalizeHostAddress(value);
  if (address === "localhost" || address === "::1") return true;
  return net.isIP(address) === 4 && address.split(".")[0] === "127";
}

function evaluateUsbProvisioningAccess({
  platform = process.platform,
  operationMode = "local",
  deploymentKind = "local",
  requestPresent = false,
  socketAddress = "",
  clientAddress = "",
  proxyChainPresent = false,
} = {}) {
  const result = {
    available: false,
    hostCapable: false,
    localConsole: false,
    localOnly: true,
    requiresElevation: false,
    targetOperationMode: "local",
    currentOperationMode: String(operationMode || "local"),
    reasonCode: "",
    reason: "",
  };
  if (platform !== "win32") {
    return {
      ...result,
      reasonCode: "USB_WINDOWS_REQUIRED",
      reason: "Die Vorbereitung und Formatierung sind nur an einem Windows-Host verfügbar.",
    };
  }
  if (!["local", "lan", "server"].includes(result.currentOperationMode)
      || !["local", "production"].includes(String(deploymentKind || "local"))) {
    return {
      ...result,
      reasonCode: "USB_DEPLOYMENT_UNSUPPORTED",
      reason: "Der USB-Stick-Assistent ist in dieser Test- oder Entwicklungsumgebung nicht verfügbar.",
    };
  }
  const hostCapable = true;
  const localConsole = requestPresent
    && isLoopbackHostAddress(socketAddress)
    && isLoopbackHostAddress(clientAddress || socketAddress)
    && (result.currentOperationMode !== "server" || proxyChainPresent);
  if (!localConsole) {
    return {
      ...result,
      hostCapable,
      reasonCode: "USB_HOST_CONSOLE_REQUIRED",
      reason: "Aus Sicherheitsgründen können nur USB-Sticks verwendet werden, die direkt am Windows-Host angeschlossen sind. USB-Sticks an einem entfernten PC, Tablet oder Smartphone sind nicht erreichbar.",
    };
  }
  return {
    ...result,
    available: true,
    hostCapable,
    localConsole: true,
  };
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function rawField(input, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(input || {}, name)) return input[name];
    const actual = Object.keys(input || {}).find((key) => key.toLowerCase() === String(name).toLowerCase());
    if (actual) return input[actual];
  }
  return undefined;
}

function normalizeWindowsVolume(input = {}) {
  const driveLetter = normalizeDriveLetter(rawField(input, "driveLetter", "DriveLetter", "deviceId", "DeviceID"));
  const driveType = finiteInteger(rawField(input, "driveType", "DriveType"), -1);
  const busType = String(rawField(input, "busType", "BusType") || "").trim();
  const interfaceType = String(rawField(input, "interfaceType", "InterfaceType") || "").trim();
  const pnpDeviceId = String(rawField(input, "pnpDeviceId", "PnpDeviceId", "PNPDeviceID") || "").trim();
  const mediaType = String(rawField(input, "mediaType", "MediaType") || "").trim();
  const sizeBytes = Math.max(0, finiteInteger(rawField(input, "sizeBytes", "SizeBytes", "size", "Size"), 0));
  const freeBytes = Math.max(0, finiteInteger(rawField(input, "freeBytes", "FreeBytes", "sizeRemaining", "SizeRemaining"), 0));
  return {
    driveLetter,
    root: driveLetter ? driveRoot(driveLetter) : "",
    driveType,
    driveTypeName: String(rawField(input, "driveTypeName", "DriveTypeName") || "").trim(),
    busType,
    interfaceType,
    pnpDeviceId,
    mediaType,
    volumeId: String(rawField(input, "volumeId", "VolumeId", "uniqueId", "UniqueId") || "").trim(),
    volumeSerialNumber: String(rawField(input, "volumeSerialNumber", "VolumeSerialNumber") || "").trim().toUpperCase(),
    label: String(rawField(input, "label", "Label", "fileSystemLabel", "FileSystemLabel") || "").trim(),
    fileSystem: String(rawField(input, "fileSystem", "FileSystem") || "").trim().toUpperCase(),
    diskNumber: finiteInteger(rawField(input, "diskNumber", "DiskNumber"), -1),
    partitionNumber: finiteInteger(rawField(input, "partitionNumber", "PartitionNumber"), -1),
    diskUniqueId: String(rawField(input, "diskUniqueId", "DiskUniqueId") || "").trim(),
    diskSerialNumber: String(rawField(input, "diskSerialNumber", "DiskSerialNumber", "serialNumber", "SerialNumber") || "").trim(),
    diskFriendlyName: String(rawField(input, "diskFriendlyName", "DiskFriendlyName", "friendlyName", "FriendlyName") || "").trim(),
    partitionCount: Math.max(0, finiteInteger(rawField(input, "partitionCount", "PartitionCount", "numberOfPartitions", "NumberOfPartitions"), 0)),
    sizeBytes,
    freeBytes,
    isBoot: normalizeBoolean(rawField(input, "isBoot", "IsBoot")),
    isSystem: normalizeBoolean(rawField(input, "isSystem", "IsSystem")),
    isReadOnly: normalizeBoolean(rawField(input, "isReadOnly", "IsReadOnly")),
    isOffline: normalizeBoolean(rawField(input, "isOffline", "IsOffline")),
    containsPageFile: normalizeBoolean(rawField(input, "containsPageFile", "ContainsPageFile")),
    healthStatus: String(rawField(input, "healthStatus", "HealthStatus") || "").trim(),
  };
}

function usbEvidence(volume) {
  // The destructive path below revalidates Get-Disk.BusType as USB. Keep the
  // discovery rule equally strict so a stale USB-looking PNP string can never
  // make an internal SATA/SCSI disk selectable.
  return String(volume.busType).toUpperCase() === "USB";
}

function removableEvidence(volume) {
  // Format-Volume is permitted only for a Win32 removable logical volume.
  // Friendly-name/media strings are display metadata, not safety evidence.
  return volume.driveType === 2;
}

function excludedDriveLetters({ appPath = "", dataPath = "", excludedDriveLetters = [], systemDrive = process.env.SystemDrive || "C:" } = {}) {
  return new Set([
    driveLetterFromPath(appPath),
    driveLetterFromPath(dataPath),
    normalizeDriveLetter(systemDrive),
    ...excludedDriveLetters.map(normalizeDriveLetter),
  ].filter(Boolean));
}

function classifyUsbVolume(input, context = {}) {
  const volume = normalizeWindowsVolume(input);
  const reasons = [];
  const excluded = excludedDriveLetters(context);
  if (!volume.driveLetter) reasons.push("invalid-drive-letter");
  if (!usbEvidence(volume)) reasons.push("not-usb");
  if (!removableEvidence(volume)) reasons.push("not-removable");
  if (volume.isBoot) reasons.push("boot-volume");
  if (volume.isSystem) reasons.push("system-volume");
  if (volume.containsPageFile) reasons.push("pagefile-volume");
  if (volume.isReadOnly) reasons.push("read-only");
  if (volume.isOffline) reasons.push("offline");
  if (excluded.has(volume.driveLetter)) reasons.push("excluded-drive");
  if (volume.sizeBytes < (context.minimumSizeBytes ?? MIN_USB_SIZE_BYTES)) reasons.push("too-small");
  if (volume.diskNumber < 0 || volume.partitionNumber < 0) reasons.push("missing-disk-identity");
  if (!volume.volumeId && !volume.volumeSerialNumber) reasons.push("missing-volume-identity");
  if (volume.partitionCount > 1 && context.allowMultiPartition !== true) reasons.push("multiple-partitions");
  return { eligible: reasons.length === 0, reasons, volume };
}

function classifyUsbVolumes(volumes, context = {}) {
  const classified = (Array.isArray(volumes) ? volumes : []).map((volume) => classifyUsbVolume(volume, context));
  return {
    candidates: classified.filter((entry) => entry.eligible).map((entry) => entry.volume),
    rejected: classified.filter((entry) => !entry.eligible).map((entry) => ({ ...entry.volume, reasons: entry.reasons })),
  };
}

const ENUMERATE_USB_VOLUMES_POWERSHELL = String.raw`
& {
  $ErrorActionPreference = 'Stop'
  $results = @()
  $pageFiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)
  foreach ($volume in @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter })) {
    $letter = ([string]$volume.DriveLetter).Trim().ToUpperInvariant()
    if ($letter -notmatch '^[A-Z]$') { continue }
    try {
      $deviceId = "$($letter):"
      $partition = Get-Partition -DriveLetter $letter -ErrorAction Stop
      $disk = Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
      $logical = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='{0}'" -f $deviceId) -ErrorAction SilentlyContinue
      $diskDrive = Get-CimInstance Win32_DiskDrive -Filter ("Index={0}" -f $partition.DiskNumber) -ErrorAction SilentlyContinue
      $containsPageFile = @($pageFiles | Where-Object {
        $pageFileName = [string]$_.Name
        $pageFileName.Length -ge 2 -and $pageFileName.Substring(0, 2).ToUpperInvariant() -eq $deviceId
      }).Count -gt 0
      $results += [PSCustomObject]@{
        DriveLetter = $deviceId
        DriveType = [int]$logical.DriveType
        DriveTypeName = [string]$volume.DriveType
        BusType = [string]$disk.BusType
        InterfaceType = [string]$diskDrive.InterfaceType
        PnpDeviceId = [string]$diskDrive.PNPDeviceID
        MediaType = [string]$diskDrive.MediaType
        VolumeId = [string]$volume.UniqueId
        VolumeSerialNumber = [string]$logical.VolumeSerialNumber
        Label = [string]$volume.FileSystemLabel
        FileSystem = [string]$volume.FileSystem
        DiskNumber = [int]$partition.DiskNumber
        PartitionNumber = [int]$partition.PartitionNumber
        DiskUniqueId = [string]$disk.UniqueId
        DiskSerialNumber = [string]$disk.SerialNumber
        DiskFriendlyName = [string]$disk.FriendlyName
        PartitionCount = [int]$disk.NumberOfPartitions
        SizeBytes = [Int64]$volume.Size
        FreeBytes = [Int64]$volume.SizeRemaining
        IsBoot = [bool]($partition.IsBoot -or $disk.IsBoot)
        IsSystem = [bool]($partition.IsSystem -or $disk.IsSystem -or ("$($letter):" -eq $env:SystemDrive))
        IsReadOnly = [bool]$disk.IsReadOnly
        IsOffline = [bool]$disk.IsOffline
        ContainsPageFile = [bool]$containsPageFile
        HealthStatus = [string]$volume.HealthStatus
      }
    } catch {
      continue
    }
  }
  ConvertTo-Json -InputObject @($results) -Compress -Depth 4
}`.trim();

const FORMAT_USB_VOLUME_POWERSHELL = String.raw`
& {
  param(
    [string]$DriveLetter,
    [int]$ExpectedDiskNumber,
    [int]$ExpectedPartitionNumber,
    [string]$ExpectedDiskUniqueId,
    [string]$ExpectedDiskSerialNumber,
    [string]$ExpectedVolumeId,
    [string]$ExpectedVolumeSerialNumber,
    [string]$ExcludedLettersCsv
  )
  $ErrorActionPreference = 'Stop'
  $letter = $DriveLetter.Trim().TrimEnd(':').ToUpperInvariant()
  if ($letter -notmatch '^[A-Z]$') { throw 'Ungueltiger Laufwerksbuchstabe.' }
  $deviceId = "$($letter):"
  $excluded = @($ExcludedLettersCsv.Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
  if ($excluded -contains $deviceId) { throw 'Das ausgewaehlte Laufwerk ist geschuetzt.' }
  $volume = Get-Volume -DriveLetter $letter -ErrorAction Stop
  $partition = Get-Partition -DriveLetter $letter -ErrorAction Stop
  $disk = Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
  $logical = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='{0}'" -f $deviceId) -ErrorAction SilentlyContinue
  $containsPageFile = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | Where-Object {
    $pageFileName = [string]$_.Name
    $pageFileName.Length -ge 2 -and $pageFileName.Substring(0, 2).ToUpperInvariant() -eq $deviceId
  }).Count -gt 0
  if ([int]$partition.DiskNumber -ne $ExpectedDiskNumber -or [int]$partition.PartitionNumber -ne $ExpectedPartitionNumber) { throw 'Die Laufwerkszuordnung hat sich geaendert.' }
  if ($ExpectedDiskUniqueId -and ([string]$disk.UniqueId).Trim() -ne $ExpectedDiskUniqueId.Trim()) { throw 'Die Datentraeger-ID hat sich geaendert.' }
  if ($ExpectedDiskSerialNumber -and ([string]$disk.SerialNumber).Trim() -ne $ExpectedDiskSerialNumber.Trim()) { throw 'Die Datentraeger-Seriennummer hat sich geaendert.' }
  if ($ExpectedVolumeId -and ([string]$volume.UniqueId).Trim() -ne $ExpectedVolumeId.Trim()) { throw 'Die Volume-ID hat sich geaendert.' }
  if ($ExpectedVolumeSerialNumber -and ([string]$logical.VolumeSerialNumber).Trim().ToUpperInvariant() -ne $ExpectedVolumeSerialNumber.Trim().ToUpperInvariant()) { throw 'Die Volume-Seriennummer hat sich geaendert.' }
  if ([string]$disk.BusType -ne 'USB' -or [int]$logical.DriveType -ne 2) { throw 'Das Laufwerk ist kein sicher erkannter USB-Wechseldatentraeger.' }
  if ([int]$disk.NumberOfPartitions -ne 1 -or $containsPageFile -or $partition.IsBoot -or $partition.IsSystem -or $disk.IsBoot -or $disk.IsSystem -or $disk.IsOffline -or $disk.IsReadOnly -or $deviceId -eq $env:SystemDrive) { throw 'Das Laufwerk darf nicht formatiert werden.' }
  $formatted = Format-Volume -DriveLetter $letter -FileSystem NTFS -NewFileSystemLabel 'Grabenplaner' -Force -Confirm:$false -ErrorAction Stop
  [PSCustomObject]@{
    DriveLetter = $deviceId
    VolumeId = [string]$formatted.UniqueId
    Label = [string]$formatted.FileSystemLabel
    FileSystem = [string]$formatted.FileSystem
    DiskNumber = [int]$partition.DiskNumber
    PartitionNumber = [int]$partition.PartitionNumber
    DiskUniqueId = [string]$disk.UniqueId
    DiskSerialNumber = [string]$disk.SerialNumber
    SizeBytes = [Int64]$formatted.Size
  } | ConvertTo-Json -Compress -Depth 3
}`.trim();

function defaultExecPowerShell(script, scriptArguments = [], { timeoutMs = 120000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, ...scriptArguments.map(String)],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(usbError("USB_POWERSHELL_FAILED", "Der Windows-Datentraegerbefehl ist fehlgeschlagen.", {
            exitCode: error.code,
            message: String(stderr || error.message || "").trim().slice(0, 2000),
          }));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function parsePowerShellJson(output) {
  const text = String(output?.stdout ?? output ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usbError("USB_POWERSHELL_JSON_INVALID", "Windows lieferte unlesbare Laufwerksinformationen.", { cause: error.message });
  }
}

async function enumerateWindowsVolumes({ platform = process.platform, execPowerShell = defaultExecPowerShell } = {}) {
  if (platform !== "win32") throw usbError("USB_WINDOWS_ONLY", "USB-Sticks koennen nur im lokalen Windows-Betrieb vorbereitet werden.");
  const parsed = parsePowerShellJson(await execPowerShell(ENUMERATE_USB_VOLUMES_POWERSHELL, []));
  return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeWindowsVolume);
}

async function enumerateSafeUsbCandidates(options = {}) {
  const volumes = await enumerateWindowsVolumes(options);
  return classifyUsbVolumes(volumes, options);
}

function selectionIdentity(input) {
  const volume = normalizeWindowsVolume(input);
  return {
    driveLetter: volume.driveLetter,
    volumeId: volume.volumeId,
    volumeSerialNumber: volume.volumeSerialNumber,
    diskNumber: volume.diskNumber,
    partitionNumber: volume.partitionNumber,
    diskUniqueId: volume.diskUniqueId,
    diskSerialNumber: volume.diskSerialNumber,
    sizeBytes: volume.sizeBytes,
    fileSystem: volume.fileSystem,
    label: volume.label,
  };
}

function physicalIdentity(input) {
  const identity = selectionIdentity(input);
  return {
    driveLetter: identity.driveLetter,
    diskNumber: identity.diskNumber,
    partitionNumber: identity.partitionNumber,
    diskUniqueId: identity.diskUniqueId,
    diskSerialNumber: identity.diskSerialNumber,
    sizeBytes: identity.sizeBytes,
  };
}

function canonicalIdentity(identity) {
  return JSON.stringify(identity);
}

function selectionSecretBuffer(secret) {
  const buffer = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ""), "utf8");
  if (buffer.length < 32) throw usbError("USB_TOKEN_SECRET_WEAK", "Der Auswahltoken-Schluessel muss mindestens 32 Byte lang sein.");
  return buffer;
}

function signSelectionPayload(encodedPayload, secret) {
  return crypto.createHmac("sha256", selectionSecretBuffer(secret)).update(encodedPayload).digest("base64url");
}

function createSelectionToken(candidate, secret, {
  now = Date.now(),
  ttlMs = DEFAULT_SELECTION_TOKEN_TTL_MS,
  nonce = crypto.randomUUID(),
  candidateOptions = {},
} = {}) {
  const classified = classifyUsbVolume(candidate, candidateOptions);
  if (!classified.eligible) {
    throw usbError("USB_SELECTION_INVALID", "Der USB-Datentraeger kann nicht ausgewaehlt werden.", { reasons: classified.reasons });
  }
  const payload = {
    version: USB_SELECTION_TOKEN_VERSION,
    issuedAt: Number(now),
    expiresAt: Number(now) + Math.max(1000, Number(ttlMs) || DEFAULT_SELECTION_TOKEN_TTL_MS),
    nonce: String(nonce),
    identity: selectionIdentity(classified.volume),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signSelectionPayload(encoded, secret)}`;
}

function verifyTokenEnvelope(token, secret, { now = Date.now() } = {}) {
  const [encoded, signature, ...remainder] = String(token || "").split(".");
  if (!encoded || !signature || remainder.length) throw usbError("USB_TOKEN_INVALID", "Die USB-Auswahl ist ungueltig.");
  const expected = signSelectionPayload(encoded, secret);
  const suppliedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw usbError("USB_TOKEN_INVALID", "Die USB-Auswahl ist ungueltig.");
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw usbError("USB_TOKEN_INVALID", "Die USB-Auswahl ist ungueltig."); }
  if (payload.version !== USB_SELECTION_TOKEN_VERSION || !payload.identity || !payload.nonce) {
    throw usbError("USB_TOKEN_INVALID", "Die USB-Auswahl ist ungueltig.");
  }
  if (!Number.isFinite(payload.expiresAt) || Number(now) > payload.expiresAt) {
    throw usbError("USB_TOKEN_EXPIRED", "Die USB-Auswahl ist abgelaufen. Bitte den Stick erneut auswaehlen.");
  }
  return payload;
}

function verifySelectionToken(token, currentCandidate, secret, options = {}) {
  const payload = verifyTokenEnvelope(token, secret, options);
  if (canonicalIdentity(payload.identity) !== canonicalIdentity(selectionIdentity(currentCandidate))) {
    throw usbError("USB_SELECTION_CHANGED", "Der ausgewaehlte USB-Datentraeger hat sich geaendert.");
  }
  return payload;
}

function assertSamePhysicalDevice(before, after) {
  if (canonicalIdentity(physicalIdentity(before)) !== canonicalIdentity(physicalIdentity(after))) {
    throw usbError("USB_PHYSICAL_DEVICE_CHANGED", "Nach der Formatierung wurde ein anderer Datentraeger erkannt.");
  }
  return true;
}

function assertFormattedVolumeMounted(formatted, observed) {
  assertSamePhysicalDevice(formatted, observed);
  const expected = normalizeWindowsVolume(formatted);
  const current = normalizeWindowsVolume(observed);
  if (expected.volumeId && current.volumeId && expected.volumeId !== current.volumeId) {
    throw usbError("USB_FORMATTED_VOLUME_CHANGED", "Nach der Formatierung wurde ein anderes Volume erkannt.");
  }
  if (expected.volumeSerialNumber && current.volumeSerialNumber
    && expected.volumeSerialNumber !== current.volumeSerialNumber) {
    throw usbError("USB_FORMATTED_VOLUME_CHANGED", "Nach der Formatierung wurde eine andere Volume-Seriennummer erkannt.");
  }
  if (current.fileSystem !== "NTFS" || current.label.toLowerCase() !== USB_VOLUME_LABEL.toLowerCase()) {
    throw usbError("USB_FORMAT_RESULT_INVALID", "Das formatierte Volume ist nicht als NTFS-Grabenplaner-Stick eingebunden.");
  }
  return true;
}

function portableCapacityRequirement(manifest, {
  minimumReserveBytes = MIN_USB_FREE_RESERVE_BYTES,
  reserveRatio = 0.1,
} = {}) {
  const contentBytes = (manifest?.files || []).reduce(
    (total, entry) => total + Math.max(0, Number(entry?.size || 0)),
    0,
  );
  const reserveBytes = Math.max(
    Number(minimumReserveBytes) || 0,
    Math.ceil(contentBytes * Math.max(0, Number(reserveRatio) || 0)),
  );
  return { contentBytes, reserveBytes, requiredBytes: contentBytes + reserveBytes };
}

function assertPortableCapacity(manifest, volume, options = {}) {
  const requirement = portableCapacityRequirement(manifest, options);
  const availableBytes = Math.max(0, Number(normalizeWindowsVolume(volume).sizeBytes || 0));
  if (availableBytes < requirement.requiredBytes) {
    throw usbError("USB_CAPACITY_INSUFFICIENT", "Der USB-Stick ist fuer die vorbereitete Installation zu klein.", {
      availableBytes,
      ...requirement,
    });
  }
  return requirement;
}

function expectedFormatConfirmation(driveLetter) {
  const letter = normalizeDriveLetter(driveLetter);
  if (!letter) throw usbError("USB_DRIVE_INVALID", "Der Laufwerksbuchstabe ist ungueltig.");
  return `FORMATIEREN ${letter}`;
}

function assertFormatConfirmation(value, driveLetter) {
  const expected = expectedFormatConfirmation(driveLetter);
  if (String(value || "") !== expected) {
    throw usbError("USB_CONFIRMATION_INVALID", `Bitte exakt \"${expected}\" eingeben.`);
  }
  return true;
}

async function formatUsbVolume(candidate, {
  execPowerShell = defaultExecPowerShell,
  appPath = "",
  dataPath = "",
  excludedDriveLetters: additionalExcluded = [],
} = {}) {
  const volume = normalizeWindowsVolume(candidate);
  const classification = classifyUsbVolume(volume, { appPath, dataPath, excludedDriveLetters: additionalExcluded });
  if (!classification.eligible) {
    throw usbError("USB_VOLUME_NOT_ELIGIBLE", "Der ausgewaehlte Datentraeger darf nicht formatiert werden.", { reasons: classification.reasons });
  }
  const excluded = [...excludedDriveLetters({ appPath, dataPath, excludedDriveLetters: additionalExcluded })].join(",");
  const result = parsePowerShellJson(await execPowerShell(FORMAT_USB_VOLUME_POWERSHELL, [
    volume.driveLetter,
    volume.diskNumber,
    volume.partitionNumber,
    volume.diskUniqueId,
    volume.diskSerialNumber,
    volume.volumeId,
    volume.volumeSerialNumber,
    excluded,
  ], { timeoutMs: 10 * 60 * 1000 }));
  const rawFormatted = Array.isArray(result) ? result[0] : result;
  if (!rawFormatted || typeof rawFormatted !== "object") {
    throw usbError("USB_FORMAT_RESULT_INVALID", "Windows lieferte nach der Formatierung keine gueltigen Laufwerksdaten.");
  }
  const formatted = normalizeWindowsVolume(rawFormatted);
  if (
    formatted.driveLetter !== volume.driveLetter
    || formatted.diskNumber !== volume.diskNumber
    || formatted.partitionNumber !== volume.partitionNumber
    || formatted.diskUniqueId !== volume.diskUniqueId
    || formatted.diskSerialNumber !== volume.diskSerialNumber
  ) {
    throw usbError("USB_FORMAT_RESULT_CHANGED", "Windows meldete nach der Formatierung einen anderen Datentraeger.");
  }
  return normalizeWindowsVolume({
    ...volume,
    driveLetter: formatted.driveLetter,
    volumeId: formatted.volumeId,
    volumeSerialNumber: formatted.volumeSerialNumber,
    diskNumber: formatted.diskNumber,
    partitionNumber: formatted.partitionNumber,
    diskUniqueId: formatted.diskUniqueId,
    diskSerialNumber: formatted.diskSerialNumber,
    sizeBytes: formatted.sizeBytes,
    label: USB_VOLUME_LABEL,
    fileSystem: "NTFS",
  });
}

function safeResolveWithin(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relativePath);
  const prefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
  if (resolved !== absoluteRoot && !resolved.startsWith(prefix)) {
    throw usbError("USB_PATH_ESCAPE", "Ein Installationspfad verlaesst den vorgesehenen Zielordner.");
  }
  return resolved;
}

function copyPath(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw usbError("USB_SOURCE_LINK_REJECTED", "Symbolische Verknuepfungen werden nicht auf den USB-Stick uebernommen.");
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyPath(path.join(source, entry), path.join(target, entry));
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function copyPortableApplication(sourceAppDirectory, targetAppDirectory, {
  directories = DEFAULT_PORTABLE_DIRECTORIES,
  files = DEFAULT_PORTABLE_FILES,
  includeRootDocuments = true,
} = {}) {
  const sourceRoot = path.resolve(sourceAppDirectory);
  const targetRoot = path.resolve(targetAppDirectory);
  if (!fs.existsSync(path.join(sourceRoot, "server.js")) || !fs.existsSync(path.join(sourceRoot, "package.json"))) {
    throw usbError("USB_SOURCE_APP_INVALID", "Die Grabenplaner-Quelldateien sind unvollstaendig.");
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const entry of [...directories, ...files]) {
    const source = safeResolveWithin(sourceRoot, entry);
    if (!fs.existsSync(source)) continue;
    copyPath(source, safeResolveWithin(targetRoot, entry));
  }
  for (const entry of fs.readdirSync(sourceRoot)) {
    if (!/^Grabenplaner v.+ Beta starten\.cmd$/i.test(entry)) continue;
    copyPath(safeResolveWithin(sourceRoot, entry), safeResolveWithin(targetRoot, entry));
  }
  if (includeRootDocuments) {
    const docs = path.join(targetRoot, "docs");
    fs.mkdirSync(docs, { recursive: true });
    for (const fileName of PORTABLE_DOCUMENT_FILES) {
      const source = path.join(sourceRoot, fileName);
      if (fs.existsSync(source) && fs.lstatSync(source).isFile()) fs.copyFileSync(source, path.join(docs, fileName));
    }
  }
  return targetRoot;
}

function portableRootLauncher() {
  return "@echo off\r\ncd /d \"%~dp0app\"\r\ncall \"Dienstplan starten.cmd\"\r\n";
}

function walkRegularFiles(root, current = root) {
  const result = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw usbError("USB_STAGE_LINK_REJECTED", "Die USB-Installationsstufe enthaelt eine symbolische Verknuepfung.");
    if (stat.isDirectory()) result.push(...walkRegularFiles(root, absolute));
    else if (stat.isFile()) result.push(absolute);
  }
  return result;
}

function relativePortablePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function buildHashManifest(rootDirectory, {
  manifestRelativePath = HASH_MANIFEST_RELATIVE_PATH,
  createdAt = new Date().toISOString(),
  metadata = {},
} = {}) {
  const root = path.resolve(rootDirectory);
  const manifestPath = String(manifestRelativePath).split(path.sep).join("/");
  const files = walkRegularFiles(root)
    .map((filePath) => ({ filePath, relativePath: relativePortablePath(root, filePath) }))
    .filter((entry) => entry.relativePath !== manifestPath)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"))
    .map((entry) => ({
      path: entry.relativePath,
      size: fs.statSync(entry.filePath).size,
      sha256: hashFile(entry.filePath),
    }));
  return {
    format: HASH_MANIFEST_FORMAT,
    version: 1,
    createdAt,
    metadata,
    files,
  };
}

function writeHashManifest(rootDirectory, options = {}) {
  const relativePath = options.manifestRelativePath || HASH_MANIFEST_RELATIVE_PATH;
  const manifest = buildHashManifest(rootDirectory, { ...options, manifestRelativePath: relativePath });
  const manifestPath = safeResolveWithin(rootDirectory, relativePath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

function readHashManifest(rootDirectory, manifestRelativePath = HASH_MANIFEST_RELATIVE_PATH) {
  const manifestPath = safeResolveWithin(rootDirectory, manifestRelativePath);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw usbError("USB_MANIFEST_INVALID", "Das USB-Hashmanifest ist unlesbar.", { cause: error.message }); }
  if (manifest?.format !== HASH_MANIFEST_FORMAT || manifest?.version !== 1 || !Array.isArray(manifest.files)) {
    throw usbError("USB_MANIFEST_INVALID", "Das USB-Hashmanifest ist ungueltig.");
  }
  return manifest;
}

function assertPortableLayout(rootDirectory) {
  const root = path.resolve(rootDirectory);
  for (const directory of REQUIRED_PORTABLE_DIRECTORIES) {
    const target = safeResolveWithin(root, directory);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw usbError("USB_LAYOUT_INCOMPLETE", `Der portable Ordner \"${directory}\" fehlt.`);
    }
  }
  const launcher = safeResolveWithin(root, "Grabenplaner starten.cmd");
  if (!fs.existsSync(launcher) || !fs.statSync(launcher).isFile()) {
    throw usbError("USB_LAYOUT_INCOMPLETE", "Die Startdatei fehlt.");
  }
  return true;
}

function verifyHashManifest(rootDirectory, manifestOrOptions = undefined) {
  const options = manifestOrOptions && manifestOrOptions.format === HASH_MANIFEST_FORMAT
    ? { manifest: manifestOrOptions }
    : (manifestOrOptions || {});
  const manifest = options.manifest || readHashManifest(rootDirectory, options.manifestRelativePath);
  const failures = [];
  const expectedPaths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) {
      failures.push({ path: String(entry?.path || ""), reason: "invalid-entry" });
      continue;
    }
    if (expectedPaths.has(entry.path)) {
      failures.push({ path: entry.path, reason: "duplicate-entry" });
      continue;
    }
    expectedPaths.add(entry.path);
    let filePath;
    try { filePath = safeResolveWithin(rootDirectory, entry.path); }
    catch { failures.push({ path: entry.path, reason: "path-escape" }); continue; }
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      failures.push({ path: entry.path, reason: "missing" });
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size !== Number(entry.size)) failures.push({ path: entry.path, reason: "size" });
    else if (hashFile(filePath) !== String(entry.sha256).toLowerCase()) failures.push({ path: entry.path, reason: "sha256" });
  }
  const ignoredWindowsRootEntries = new Set(["System Volume Information", "$RECYCLE.BIN"]);
  const actualPaths = [];
  for (const entry of fs.readdirSync(path.resolve(rootDirectory), { withFileTypes: true })) {
    if (ignoredWindowsRootEntries.has(entry.name)) continue;
    const absolute = path.join(path.resolve(rootDirectory), entry.name);
    if (entry.isDirectory()) actualPaths.push(...walkRegularFiles(rootDirectory, absolute));
    else if (entry.isFile()) actualPaths.push(absolute);
    else if (entry.isSymbolicLink()) failures.push({ path: entry.name, reason: "symbolic-link" });
  }
  const manifestPath = String(options.manifestRelativePath || HASH_MANIFEST_RELATIVE_PATH).split(path.sep).join("/");
  for (const filePath of actualPaths) {
    const relativePath = relativePortablePath(path.resolve(rootDirectory), filePath);
    if (relativePath !== manifestPath && !expectedPaths.has(relativePath)) {
      failures.push({ path: relativePath, reason: "unexpected" });
    }
  }
  if (failures.length) throw usbError("USB_HASH_VERIFICATION_FAILED", "Die USB-Dateipruefung ist fehlgeschlagen.", { failures });
  return { ok: true, checked: manifest.files.length, manifest };
}

async function stagePortableInstallation({
  sourceAppDirectory,
  stagingParent = os.tmpdir(),
  prepareApp,
  generateFirstStepsPdf,
  firstStepsPdfBuffer,
  firstStepsPdfPath,
  manifestMetadata = {},
  copyOptions = {},
} = {}) {
  if (!sourceAppDirectory) throw usbError("USB_SOURCE_APP_REQUIRED", "Der Grabenplaner-Quellordner fehlt.");
  const stageRoot = fs.mkdtempSync(path.join(path.resolve(stagingParent), "grabenplaner-usb-stage-"));
  const appDirectory = path.join(stageRoot, "app");
  try {
    copyPortableApplication(sourceAppDirectory, appDirectory, copyOptions);
    fs.mkdirSync(path.join(stageRoot, "Backups"), { recursive: true });
    fs.mkdirSync(path.join(stageRoot, "PDF-Exporte"), { recursive: true });
    fs.mkdirSync(path.join(appDirectory, "data"), { recursive: true });
    fs.mkdirSync(path.join(appDirectory, "backups"), { recursive: true });
    fs.writeFileSync(path.join(stageRoot, "Grabenplaner starten.cmd"), portableRootLauncher(), "utf8");
    if (typeof prepareApp === "function") await prepareApp({ stageRoot, appDirectory });
    const firstStepsTarget = path.join(stageRoot, "Erste Schritte.pdf");
    if (typeof generateFirstStepsPdf === "function") {
      const result = await generateFirstStepsPdf({ stageRoot, appDirectory, targetPath: firstStepsTarget });
      if (Buffer.isBuffer(result)) fs.writeFileSync(firstStepsTarget, result);
    } else if (Buffer.isBuffer(firstStepsPdfBuffer)) {
      fs.writeFileSync(firstStepsTarget, firstStepsPdfBuffer);
    } else if (firstStepsPdfPath) {
      fs.copyFileSync(path.resolve(firstStepsPdfPath), firstStepsTarget);
    }
    assertPortableLayout(stageRoot);
    const { manifest, manifestPath } = writeHashManifest(stageRoot, { metadata: manifestMetadata });
    verifyHashManifest(stageRoot, manifest);
    return { stageRoot, appDirectory, manifest, manifestPath };
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function copyStageToVolume(stageRoot, targetRoot) {
  const normalizedTarget = path.resolve(targetRoot);
  const expectedRoot = driveRoot(driveLetterFromPath(normalizedTarget));
  if (path.resolve(expectedRoot).toLowerCase() !== normalizedTarget.toLowerCase()) {
    throw usbError("USB_TARGET_ROOT_INVALID", "Das USB-Ziel muss das Stammverzeichnis des ausgewaehlten Laufwerks sein.");
  }
  for (const entry of fs.readdirSync(stageRoot)) {
    copyPath(path.join(stageRoot, entry), path.join(normalizedTarget, entry));
  }
  return normalizedTarget;
}

function hidePortableAppDirectory(appDirectory, { execFile = childProcess.execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFile("attrib.exe", ["+H", "+S", path.resolve(appDirectory)], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(usbError("USB_HIDE_APP_FAILED", "Der interne App-Ordner konnte nicht ausgeblendet werden.", {
          message: String(stderr || error.message || "").trim().slice(0, 1000),
        }));
        return;
      }
      resolve(true);
    });
  });
}

async function provisionUsbStick({
  stage,
  selectionToken,
  tokenSecret,
  confirmation,
  enumerateCandidates = enumerateSafeUsbCandidates,
  formatVolume = formatUsbVolume,
  copyStage = copyStageToVolume,
  hideApp = hidePortableAppDirectory,
  consumeToken = () => {},
  targetRootForVolume = (volume) => volume.root,
  now = Date.now(),
  candidateOptions = {},
} = {}) {
  if (!stage?.stageRoot || !stage?.manifest) throw usbError("USB_STAGE_REQUIRED", "Die vorbereitete USB-Installationsstufe fehlt.");
  assertPortableLayout(stage.stageRoot);
  verifyHashManifest(stage.stageRoot, stage.manifest);
  const tokenPayload = verifyTokenEnvelope(selectionToken, tokenSecret, { now });
  const enumeration = await enumerateCandidates(candidateOptions);
  const candidates = Array.isArray(enumeration) ? enumeration : enumeration.candidates;
  const current = (candidates || []).find((candidate) => normalizeDriveLetter(candidate.driveLetter) === tokenPayload.identity.driveLetter);
  if (!current) throw usbError("USB_SELECTION_NOT_FOUND", "Der ausgewaehlte USB-Stick ist nicht mehr verfuegbar.");
  verifySelectionToken(selectionToken, current, tokenSecret, { now });
  assertFormatConfirmation(confirmation, current.driveLetter);
  const capacity = assertPortableCapacity(stage.manifest, current);
  await consumeToken(tokenPayload);
  const formatted = await formatVolume(current, candidateOptions);
  assertSamePhysicalDevice(current, formatted);
  const formattedEnumeration = await enumerateCandidates(candidateOptions);
  const formattedCandidates = Array.isArray(formattedEnumeration) ? formattedEnumeration : formattedEnumeration.candidates;
  const mounted = (formattedCandidates || []).find(
    (candidate) => normalizeDriveLetter(candidate.driveLetter) === formatted.driveLetter,
  );
  if (!mounted) throw usbError("USB_FORMATTED_VOLUME_NOT_FOUND", "Der formatierte USB-Stick ist nicht mehr verfuegbar.");
  assertSamePhysicalDevice(current, mounted);
  assertFormattedVolumeMounted(formatted, mounted);
  const targetRoot = path.resolve(await targetRootForVolume(mounted));
  await copyStage(stage.stageRoot, targetRoot, mounted);
  assertPortableLayout(targetRoot);
  const verification = verifyHashManifest(targetRoot, stage.manifest);
  const finalEnumeration = await enumerateCandidates(candidateOptions);
  const finalCandidates = Array.isArray(finalEnumeration) ? finalEnumeration : finalEnumeration.candidates;
  const finalVolume = (finalCandidates || []).find(
    (candidate) => normalizeDriveLetter(candidate.driveLetter) === formatted.driveLetter,
  );
  if (!finalVolume) throw usbError("USB_FINAL_VOLUME_NOT_FOUND", "Der USB-Stick wurde waehrend der Abschlusspruefung entfernt.");
  assertFormattedVolumeMounted(mounted, finalVolume);
  await hideApp(path.join(targetRoot, "app"));
  return {
    ok: true,
    driveLetter: formatted.driveLetter,
    root: targetRoot,
    label: USB_VOLUME_LABEL,
    fileSystem: "NTFS",
    capacity,
    verification,
  };
}

module.exports = {
  DEFAULT_SELECTION_TOKEN_TTL_MS,
  ENUMERATE_USB_VOLUMES_POWERSHELL,
  FORMAT_USB_VOLUME_POWERSHELL,
  HASH_MANIFEST_FORMAT,
  HASH_MANIFEST_RELATIVE_PATH,
  MIN_USB_FREE_RESERVE_BYTES,
  MIN_USB_SIZE_BYTES,
  REQUIRED_PORTABLE_DIRECTORIES,
  USB_SELECTION_TOKEN_VERSION,
  USB_VOLUME_LABEL,
  UsbProvisioningError,
  assertFormatConfirmation,
  assertFormattedVolumeMounted,
  assertPortableLayout,
  assertPortableCapacity,
  assertSamePhysicalDevice,
  buildHashManifest,
  classifyUsbVolume,
  classifyUsbVolumes,
  copyPortableApplication,
  copyStageToVolume,
  createSelectionToken,
  defaultExecPowerShell,
  driveLetterFromPath,
  driveRoot,
  enumerateSafeUsbCandidates,
  enumerateWindowsVolumes,
  expectedFormatConfirmation,
  evaluateUsbProvisioningAccess,
  excludedDriveLetters,
  formatUsbVolume,
  hidePortableAppDirectory,
  isLoopbackHostAddress,
  normalizeDriveLetter,
  normalizeWindowsVolume,
  parsePowerShellJson,
  physicalIdentity,
  portableCapacityRequirement,
  portableRootLauncher,
  provisionUsbStick,
  readHashManifest,
  safeResolveWithin,
  selectionIdentity,
  stagePortableInstallation,
  verifyHashManifest,
  verifySelectionToken,
  verifyTokenEnvelope,
  writeHashManifest,
};
