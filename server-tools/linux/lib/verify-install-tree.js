"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || "");
const rootPrefix = `${root}${path.sep}`;
let files = 0;
let directories = 0;
let symlinks = 0;

function visit(directory) {
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      let resolved;
      try { resolved = fs.realpathSync(target); }
      catch { throw new Error(`Defekter symbolischer Link im Installationsbaum: ${path.relative(root, target)}`); }
      if (resolved !== root && !resolved.startsWith(rootPrefix)) {
        throw new Error(`Symbolischer Link verlaesst den Installationsbaum: ${path.relative(root, target)}`);
      }
    } else if (stat.isDirectory()) {
      directories += 1;
      visit(target);
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) {
        throw new Error(`Hardlink im Installationsbaum ist nicht erlaubt: ${path.relative(root, target)}`);
      }
      files += 1;
    } else {
      throw new Error(`Unzulaessiger Dateityp im Installationsbaum: ${path.relative(root, target)}`);
    }
  }
}

try {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Installationswurzel ist unzulaessig.");
  visit(root);
  process.stdout.write(`${JSON.stringify({ ok: true, files, directories, symlinks })}\n`);
} catch (error) {
  console.error(error?.message || "Installationsbaum-Pruefung fehlgeschlagen.");
  process.exitCode = 1;
}
