"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function regular(file) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Eine isolierte Wiederherstellungspruefung ist fehlgeschlagen.");
  return String(result.stdout || "");
}

function main() {
  const [stageArg, stageHelperArg, backupVerifierArg, amuModuleArg, environmentFileArg] = process.argv.slice(2);
  const stage = path.resolve(stageArg || "");
  const stageHelper = path.resolve(stageHelperArg || "");
  const backupVerifier = path.resolve(backupVerifierArg || "");
  const amuModule = path.resolve(amuModuleArg || "");
  if (!path.isAbsolute(stageArg || "") || stage === path.parse(stage).root) throw new Error("Der Restore-Testpfad ist ungueltig.");
  for (const helper of [stageHelper, backupVerifier, amuModule]) if (!regular(helper)) throw new Error("Ein Restore-Pruefmodul fehlt.");
  const environmentFile = path.resolve(environmentFileArg || "");
  if (!regular(environmentFile)) throw new Error("Die geschuetzte Wiederherstellungskonfiguration fehlt.");
  const environmentStat = fs.lstatSync(environmentFile);
  if (environmentFile !== "/etc/grabenplaner/grabenplaner.env" || environmentStat.uid !== 0 || (environmentStat.mode & 0o077) !== 0
    || environmentStat.size < 2 || environmentStat.size > 64 * 1024) throw new Error("Die Wiederherstellungskonfiguration ist unzulaessig.");
  const values = new Map();
  for (const line of fs.readFileSync(environmentFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(GRABENPLANER_AMU_KEY_ID|GRABENPLANER_AMU_KEY)=([^\s]+)$/);
    if (!match) continue;
    if (values.has(match[1])) throw new Error("Die Wiederherstellungskonfiguration enthaelt doppelte Schluesselwerte.");
    values.set(match[1], match[2]);
  }
  const keyId = values.get("GRABENPLANER_AMU_KEY_ID") || "";
  const encryptionKey = values.get("GRABENPLANER_AMU_KEY") || "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !/^[A-Za-z0-9+/_=-]{32,256}$/.test(encryptionKey)) {
    throw new Error("Die AMU-Wiederherstellungsschluessel fehlen oder sind ungueltig.");
  }
  const stageOutput = JSON.parse(runNode(stageHelper, ["verify", stage]));
  for (const target of [stageOutput.database, stageOutput.documents, stageOutput.commitMarker]) {
    const resolved = path.resolve(String(target || ""));
    if (!resolved.startsWith(`${stage}${path.sep}`)) throw new Error("Ein Restore-Ergebnis verlaesst den isolierten Testordner.");
  }
  runNode(backupVerifier, [stageOutput.database, stageOutput.documents, amuModule, stageOutput.commitMarker]);
  const { validateEncryptionKeyForStorage } = require(amuModule);
  validateEncryptionKeyForStorage({
    sourceDirectory: stageOutput.documents,
    encryptionKeys: { [keyId]: encryptionKey },
    activeKeyId: keyId,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, verified: true })}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write("Isolierte Wiederherstellungspruefung fehlgeschlagen.\n");
  process.exitCode = 1;
}
