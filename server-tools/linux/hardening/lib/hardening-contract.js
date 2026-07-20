"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "server-tools/linux/hardening/";
const SAFE_PATH_PART = /^[A-Za-z0-9._-]+$/;

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeRelative(value) {
  return typeof value === "string" && value && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== ".." && SAFE_PATH_PART.test(part));
}

function ordinalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const relative of files) {
    const parts = relative.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      directories.add(parts.slice(0, length).join("/"));
    }
  }
  return directories;
}

function assertExactModuleTree(moduleRoot, files) {
  const rootStat = fs.lstatSync(moduleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Die Hardening-Modulwurzel ist kein regulaeres Verzeichnis.");
  }

  const allowedFiles = new Set(files);
  const allowedDirectories = expectedDirectories(allowedFiles);
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Hardening-Modulpfad ist ein symbolischer Link: ${relative}`);
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(relative)) throw new Error(`Nicht manifestiertes Hardening-Verzeichnis: ${relative}`);
        walk(target, relative);
      } else if (stat.isFile()) {
        if (!allowedFiles.has(relative)) throw new Error(`Nicht manifestierte Hardening-Moduldatei: ${relative}`);
      } else {
        throw new Error(`Unzulaessiger Hardening-Modulpfad: ${relative}`);
      }
    }
  };
  walk(moduleRoot);
}

function parseSchema(moduleRoot) {
  const schemaPath = path.join(moduleRoot, "module-schema.json");
  const stat = fs.lstatSync(schemaPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Der Hardening-Modulvertrag fehlt.");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8").replace(/^\uFEFF/, ""));
  if (schema.format !== "grabenplaner-linux-hardening-module-contract" || schema.schemaVersion !== 1
    || schema.moduleVersion !== 1 || schema.activationPolicy !== "explicit-root-two-session"
    || !Array.isArray(schema.managedArtifacts) || schema.managedArtifacts.length < 12 || schema.managedArtifacts.length > 48) {
    throw new Error("Der Hardening-Modulvertrag wird nicht unterstuetzt.");
  }
  return { schema, schemaPath };
}

function moduleContract(moduleRoot) {
  moduleRoot = path.resolve(moduleRoot);
  const { schema, schemaPath } = parseSchema(moduleRoot);
  const files = new Map();
  for (const fullRelative of schema.managedArtifacts) {
    if (!String(fullRelative).startsWith(PREFIX)) throw new Error("Ein Hardening-Modulpfad ist ungueltig.");
    const relative = String(fullRelative).slice(PREFIX.length);
    if (!safeRelative(relative) || files.has(relative)) throw new Error("Ein Hardening-Modulpfad ist ungueltig oder doppelt.");
    const target = path.resolve(moduleRoot, ...relative.split("/"));
    if (!target.startsWith(`${moduleRoot}${path.sep}`)) throw new Error("Ein Hardening-Modulpfad verlaesst die Modulwurzel.");
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`Hardening-Moduldatei fehlt: ${relative}`);
    files.set(relative, digest(target));
  }
  assertExactModuleTree(moduleRoot, files.keys());
  const sortedFiles = [...files].sort(([left], [right]) => ordinalCompare(left, right));
  const fingerprint = crypto.createHash("sha256")
    .update(sortedFiles.map(([name, hash]) => `${PREFIX}${name}\0${hash}\n`).join(""))
    .digest("hex");
  return {
    format: "grabenplaner-linux-hardening-installed-contract",
    schemaVersion: 1,
    moduleVersion: 1,
    schemaSha256: digest(schemaPath),
    fingerprint,
    files: sortedFiles
      .map(([filePath, sha256]) => ({ path: filePath, sha256 })),
  };
}

function verifyInstalled(moduleRoot, receiptPath, options = {}) {
  moduleRoot = path.resolve(moduleRoot);
  receiptPath = path.resolve(receiptPath);
  const skipOwnership = options.skipOwnership === true;
  for (const directory of [path.dirname(moduleRoot), moduleRoot]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (!skipOwnership && stat.uid !== 0) || (stat.mode & 0o022) !== 0) {
      throw new Error("Die installierte Hardening-Modulwurzel ist unsicher.");
    }
  }
  const receiptStat = fs.lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || (!skipOwnership && receiptStat.uid !== 0)
    || receiptStat.nlink !== 1 || (receiptStat.mode & 0o077) !== 0) {
    throw new Error("Der Hardening-Installationsbeleg fehlt oder ist unsicher.");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").replace(/^\uFEFF/, ""));
  const current = moduleContract(moduleRoot);
  if (receipt.format !== current.format || receipt.schemaVersion !== 1 || receipt.moduleVersion !== 1
    || receipt.schemaSha256 !== current.schemaSha256 || receipt.fingerprint !== current.fingerprint
    || JSON.stringify(receipt.files) !== JSON.stringify(current.files)) {
    throw new Error("Das installierte Hardening-Modul stimmt nicht mit seinem Beleg ueberein.");
  }
  for (const item of current.files) {
    const target = path.join(moduleRoot, ...item.path.split("/"));
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (!skipOwnership && stat.uid !== 0)
      || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new Error("Eine installierte Hardening-Moduldatei ist unsicher.");
    }
  }
  return { ok: true, fingerprint: current.fingerprint, files: current.files.length };
}

if (require.main === module) {
  try {
    const [command, first, second] = process.argv.slice(2);
    if (command === "contract") {
      process.stdout.write(`${JSON.stringify(moduleContract(first || ""), null, 2)}\n`);
    } else if (command === "verify-installed") {
      process.stdout.write(`${JSON.stringify(verifyInstalled(first || "", second || ""))}\n`);
    } else {
      throw new Error("Unbekannter Hardening-Vertragsvorgang.");
    }
  } catch (error) {
    process.stderr.write(`${error?.message || "Hardening-Vertragspruefung fehlgeschlagen."}\n`);
    process.exitCode = 1;
  }
}

module.exports = { moduleContract, verifyInstalled };
