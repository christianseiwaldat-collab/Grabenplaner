"use strict";

const fs = require("node:fs");
const path = require("node:path");

function main() {
  const [backupDirectory, keepRaw, verifierModule, amuModule] = process.argv.slice(2);
  const rawBackupDirectory = String(backupDirectory || "").trim();
  const root = rawBackupDirectory ? path.resolve(rawBackupDirectory) : "";
  const keep = Number(keepRaw);
  if (!rawBackupDirectory || !path.isAbsolute(root) || !Number.isSafeInteger(keep) || keep < 1 || keep > 1000
    || !String(verifierModule || "").trim() || !String(amuModule || "").trim()) {
    throw new Error("Parameter fuer die Backup-Aufbewahrung sind ungueltig.");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Das Backupverzeichnis ist unzulaessig.");
  const { verifyBackup } = require(path.resolve(verifierModule));
  const { planDailyBackups } = require(path.join(path.dirname(path.resolve(amuModule)), 'backup-retention.js'));
  if (typeof verifyBackup !== "function") throw new Error("Der vertrauenswuerdige Backup-Pruefer fehlt.");
  const candidates = fs.readdirSync(root).filter((name) => /^dienstplan-[0-9A-Za-z._-]+\.complete\.json$/.test(name)).map((name) => {
    const markerPath = path.join(root, name);
    try {
      const stat = fs.lstatSync(markerPath);
      return stat.isFile() && !stat.isSymbolicLink() ? { name, markerPath, modifiedMs: stat.mtimeMs } : null;
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.modifiedMs - left.modifiedMs);

  const valid = [];
  for (const candidate of candidates) {
    const snapshot = candidate.name.slice(0, -".complete.json".length);
    const databasePath = path.join(root, `${snapshot}.db`);
    const protectedDirectory = path.join(root, `${snapshot}.amu`);
    try {
      verifyBackup(databasePath, protectedDirectory, amuModule, candidate.markerPath);
      const marker = JSON.parse(fs.readFileSync(candidate.markerPath, 'utf8'));
      valid.push({ ...candidate, databasePath, protectedDirectory, committedAt: marker.committedAt });
    } catch {}
  }

  let removed = 0;
  const failures = [];
  const plan = planDailyBackups(valid.map(b => ({ id: b.name, time: b.committedAt })), { days: keep });
  for (const backup of valid.filter(b => plan.removeIds.includes(b.name))) {
    try {
      for (const target of [backup.markerPath, backup.databasePath, backup.protectedDirectory]) {
        if (path.dirname(fs.realpathSync(target)) !== fs.realpathSync(root)) throw new Error('BACKUP_RETENTION_DELETE_SCOPE_INVALID');
      }
      verifyBackup(backup.databasePath, backup.protectedDirectory, amuModule, backup.markerPath);
      fs.rmSync(backup.markerPath, { force: true });
      fs.rmSync(backup.databasePath, { force: true });
      fs.rmSync(backup.protectedDirectory, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failures.push(`${backup.name}: ${error?.message || "Loeschen fehlgeschlagen"}`);
    }
  }
  if (failures.length) throw new Error(`Backup-Aufbewahrung unvollstaendig: ${failures.join("; ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, valid: valid.length, retained: valid.length - removed, removed })}\n`);
}

try {
  main();
} catch (error) {
  console.error(error?.message || "Backup-Aufbewahrung fehlgeschlagen.");
  process.exitCode = 1;
}
