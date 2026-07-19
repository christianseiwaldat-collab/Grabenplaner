"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || "");
const manifestPath = path.join(root, "grabenplaner-server-manifest.json");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeRelativePath(value) {
  const relative = String(value || "");
  if (!relative || relative.includes("\\") || relative.startsWith("/") || relative.includes("\0")) return false;
  const parts = relative.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function isAllowedRuntimePath(relative) {
  const topLevelFiles = new Set([
    "server.js", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "README.md", "LICENSE.md", "SECURITY.md", "SERVERBETRIEB.md",
  ]);
  return topLevelFiles.has(relative)
    || relative.startsWith("lib/")
    || relative.startsWith("public/")
    || relative.startsWith("server-tools/");
}

function isForbiddenRuntimePath(relative) {
  const normalized = relative.toLowerCase();
  const top = normalized.split("/", 1)[0];
  if ([".git", ".github", ".devcontainer", "backups", "data", "demo", "docs", "node_modules", "output", "release", "runtime", "scripts", "test", "tmp", "usb-backups"].includes(top)) return true;
  if (/(^|\/)(\.env($|\.)|\.npmrc$|\.pnpm-store($|\/)|__pycache__($|\/))/.test(normalized)) return true;
  if (/\.(db|sqlite|sqlite3|amu|pfx|p12|pem|key|crt)$/.test(normalized)) return true;
  if (/(^|\/)(branding-kits?|customer-branding|kundenbranding)(\/|$)/.test(normalized)) return true;
  return /(lamprechter|photo-?straub|foto-?straub|united-?camera)/.test(normalized);
}

function walk(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Symbolische Links sind im Serverpaket nicht erlaubt: ${relative}`);
    if (stat.isDirectory()) files.push(...walk(target, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unzulaessiger Dateityp im Serverpaket: ${relative}`);
  }
  return files;
}

function assertMinimumNode(range) {
  const match = String(range || "").match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("minimumNode im Paketmanifest ist ungueltig.");
  const required = match.slice(1).map(Number);
  const current = process.versions.node.split(".").slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return;
    if (current[index] < required[index]) throw new Error(`Node.js ${range} wird benoetigt; installiert ist ${process.versions.node}.`);
  }
}

function main() {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Der Paket-Stagingordner ist ungueltig.");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Das Paketmanifest fehlt oder ist unzulaessig.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  if (manifest.format !== "grabenplaner-server-package" || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Das Serverpaket-Manifest wird nicht unterstuetzt.");
  }
  if (manifest.platform !== "linux" || manifest.architecture !== "x64" || manifest.dependenciesMode !== "source-install") {
    throw new Error("Das Paket ist nicht fuer den unterstuetzten Linux-x64-Quellinstallationsmodus bestimmt.");
  }
  if (manifest.nodeRuntimeIncluded !== false || manifest.nodeRuntimeSha256 !== null) {
    throw new Error("Linux-Serverpakete duerfen keine fremde Node-Runtime enthalten.");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(String(manifest.packageManager || ""))) {
    throw new Error("Die pnpm-Version im Paketmanifest fehlt oder ist ungueltig.");
  }
  if (manifest.minimumNode !== ">=22.13.0" || manifest.packageManager !== "pnpm@11.7.0") {
    throw new Error("Die freigegebenen Node-/pnpm-Laufzeitvorgaben stimmen nicht.");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(String(manifest.sourceCommit || "")) || !Number.isFinite(Date.parse(String(manifest.createdAt || "")))) {
    throw new Error("Quellcommit oder Erstellzeitpunkt im Paketmanifest ist ungueltig.");
  }
  assertMinimumNode(manifest.minimumNode);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  if (String(manifest.appVersion || "") !== String(metadata.version || "")) {
    throw new Error("Manifest-Version und package.json-Version stimmen nicht ueberein.");
  }
  if (metadata.packageManager !== manifest.packageManager) throw new Error("package.json und Manifest fordern unterschiedliche pnpm-Versionen.");

  const required = [
    "server.js",
    "package.json",
    "pnpm-lock.yaml",
    "lib/database-lock.js",
    "lib/amu-storage.js",
    "server-tools/linux/backup-grabenplaner.sh",
    "server-tools/linux/stop-grabenplaner-server.sh",
    "server-tools/linux/test-grabenplaner-server.sh",
    "server-tools/linux/update-grabenplaner-server.sh",
    "server-tools/linux/uninstall-grabenplaner-server.sh",
    "server-tools/linux/lib/common.sh",
    "server-tools/linux/lib/backup-snapshot.js",
    "server-tools/linux/lib/hold-database-lock.js",
    "server-tools/linux/lib/restore-backup.js",
    "server-tools/linux/lib/verify-backup.js",
    "server-tools/linux/lib/verify-install-tree.js",
    "server-tools/linux/lib/verify-package.js",
  ];
  const expected = new Map();
  for (const raw of manifest.files) {
    const relative = String(raw?.path || "");
    if (!safeRelativePath(relative) || expected.has(relative)) throw new Error(`Doppelter oder ungueltiger Manifestpfad: ${relative || "(leer)"}`);
    if (!isAllowedRuntimePath(relative) || isForbiddenRuntimePath(relative)) throw new Error(`Nicht freigegebener Inhalt im Serverpaket: ${relative}`);
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Manifestpfad verlaesst die Paketwurzel: ${relative}`);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Manifestdatei fehlt oder ist unzulaessig: ${relative}`);
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || stat.size !== raw.bytes
      || !/^[0-9a-f]{64}$/i.test(String(raw.sha256 || ""))
      || sha256File(target) !== String(raw.sha256).toLowerCase()) {
      throw new Error(`Manifestpruefung fehlgeschlagen: ${relative}`);
    }
    expected.set(relative, true);
  }
  for (const relative of required) {
    if (!expected.has(relative)) throw new Error(`Pflichtdatei fehlt im Serverpaket: ${relative}`);
  }
  const actual = walk(root).filter((relative) => relative !== "grabenplaner-server-manifest.json");
  if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) {
    throw new Error("Das Serverpaket enthaelt nicht im Manifest erfasste oder fehlende Dateien.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    appVersion: manifest.appVersion,
    packageManager: manifest.packageManager,
    manifestSha256: sha256File(manifestPath),
    fileCount: expected.size,
  })}\n`);
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Paketpruefung fehlgeschlagen.");
  process.exitCode = 1;
}
