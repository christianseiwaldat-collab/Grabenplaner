"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT_MODULE_VERSION = 3;
const SUPPORTED_INSTALLED_MODULE_VERSIONS = new Set([1, 2, CURRENT_MODULE_VERSION]);

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeRelative(value) {
  return typeof value === "string" && value && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function moduleContract(sourceRoot) {
  const schemaPath = path.join(sourceRoot, "module-schema.json");
  const stat = fs.lstatSync(schemaPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Der Offsite-Modulvertrag fehlt.");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8").replace(/^\uFEFF/, ""));
  if (schema.format !== "grabenplaner-linux-offsite-module-contract" || schema.schemaVersion !== 1
    || schema.moduleVersion !== CURRENT_MODULE_VERSION || schema.activationPolicy !== "explicit-root-setup"
    || !Array.isArray(schema.managedArtifacts) || schema.managedArtifacts.length < 15 || schema.managedArtifacts.length > 64) {
    throw new Error("Der Offsite-Modulvertrag wird nicht unterstuetzt.");
  }
  const prefix = "server-tools/linux/offsite/";
  const files = new Map();
  for (const fullRelative of schema.managedArtifacts) {
    if (!String(fullRelative).startsWith(prefix)) throw new Error("Ein Offsite-Modulpfad ist ungueltig.");
    const relative = fullRelative.slice(prefix.length);
    if (!safeRelative(relative) || files.has(relative)) throw new Error("Ein Offsite-Modulpfad ist ungueltig oder doppelt.");
    const target = path.resolve(sourceRoot, ...relative.split("/"));
    if (!target.startsWith(`${sourceRoot}${path.sep}`)) throw new Error("Ein Offsite-Modulpfad verlaesst die Modulwurzel.");
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`Offsite-Moduldatei fehlt: ${relative}`);
    files.set(relative, digest(target));
  }
  const fingerprint = crypto.createHash("sha256")
    .update([...files].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `server-tools/linux/offsite/${name}\0${hash}\n`).join(""))
    .digest("hex");
  return {
    schemaSha256: digest(schemaPath),
    fingerprint,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, sha256]) => ({ path: filePath, sha256 })),
  };
}

function verifyInstalled(moduleRoot, receiptPath) {
  for (const directory of [path.dirname(moduleRoot), moduleRoot]) {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== 0 || (directoryStat.mode & 0o022) !== 0) {
      throw new Error("Die installierte Modulwurzel ist unsicher.");
    }
  }
  const receiptStat = fs.lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error("Der Installationsbeleg fehlt.");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").replace(/^\uFEFF/, ""));
  if (receipt.format !== "grabenplaner-linux-offsite-installed-contract" || receipt.schemaVersion !== 1
    || !SUPPORTED_INSTALLED_MODULE_VERSIONS.has(receipt.moduleVersion)
    || !Array.isArray(receipt.files) || !/^[a-f0-9]{64}$/.test(String(receipt.fingerprint || ""))
    || !/^[a-f0-9]{64}$/.test(String(receipt.schemaSha256 || ""))) {
    throw new Error("Der Installationsbeleg ist ungueltig.");
  }
  const schemaPath = path.join(moduleRoot, "module-schema.json");
  const schemaStat = fs.lstatSync(schemaPath);
  if (!schemaStat.isFile() || schemaStat.isSymbolicLink() || digest(schemaPath) !== receipt.schemaSha256) {
    throw new Error("Der installierte Modulvertrag stimmt nicht mit dem Installationsbeleg ueberein.");
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8").replace(/^\uFEFF/, ""));
  if (schema.format !== "grabenplaner-linux-offsite-module-contract" || schema.schemaVersion !== 1
    || schema.moduleVersion !== receipt.moduleVersion || !SUPPORTED_INSTALLED_MODULE_VERSIONS.has(schema.moduleVersion)
    || schema.activationPolicy !== "explicit-root-setup" || !Array.isArray(schema.managedArtifacts)) {
    throw new Error("Der installierte Modulvertrag wird nicht unterstuetzt.");
  }
  const prefix = "server-tools/linux/offsite/";
  const expected = new Set(schema.managedArtifacts.map((relative) => {
    if (!String(relative).startsWith(prefix) || !safeRelative(String(relative).slice(prefix.length))) {
      throw new Error("Der installierte Modulvertrag enthaelt einen ungueltigen Pfad.");
    }
    return String(relative).slice(prefix.length);
  }));
  if (expected.size !== schema.managedArtifacts.length || expected.size !== receipt.files.length) {
    throw new Error("Installationsbeleg und Modulvertrag enthalten unterschiedliche Dateilisten.");
  }
  const files = new Map();
  for (const item of receipt.files) {
    const relative = String(item?.path || "");
    if (!safeRelative(relative) || files.has(relative) || !/^[a-f0-9]{64}$/.test(String(item?.sha256 || ""))) {
      throw new Error("Der Installationsbeleg enthaelt ungueltige Dateien.");
    }
    if (!expected.has(relative)) throw new Error("Der Installationsbeleg enthaelt eine nicht verwaltete Datei.");
    const target = path.resolve(moduleRoot, ...relative.split("/"));
    if (!target.startsWith(`${moduleRoot}${path.sep}`)) throw new Error("Ein installierter Modulpfad verlaesst die Modulwurzel.");
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.uid !== 0 || targetStat.nlink !== 1
      || (targetStat.mode & 0o022) !== 0 || digest(target) !== item.sha256) {
      throw new Error("Die installierte Offsite-Modulpruefung ist fehlgeschlagen.");
    }
    files.set(relative, item.sha256);
  }
  if ([...expected].some((relative) => !files.has(relative))) throw new Error("Im Installationsbeleg fehlt eine verwaltete Datei.");
  const fingerprint = crypto.createHash("sha256")
    .update([...files].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hash]) => `server-tools/linux/offsite/${name}\0${hash}\n`).join(""))
    .digest("hex");
  if (fingerprint !== receipt.fingerprint) throw new Error("Der installierte Offsite-Fingerprint stimmt nicht.");
  return { ok: true, fingerprint, files: files.size };
}

try {
  const [command, first, second] = process.argv.slice(2);
  if (command === "contract") {
    const result = moduleContract(path.resolve(first || ""));
    process.stdout.write(`${JSON.stringify({ format: "grabenplaner-linux-offsite-installed-contract", schemaVersion: 1, moduleVersion: CURRENT_MODULE_VERSION, ...result }, null, 2)}\n`);
  } else if (command === "verify-installed") {
    process.stdout.write(`${JSON.stringify(verifyInstalled(path.resolve(first || ""), path.resolve(second || "")))}\n`);
  } else {
    throw new Error("Unbekannter Offsite-Vertragsvorgang.");
  }
} catch (error) {
  process.stderr.write(`${error?.message || "Offsite-Vertragspruefung fehlgeschlagen."}\n`);
  process.exitCode = 1;
}
