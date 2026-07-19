"use strict";

const fs = require("node:fs");

try {
  const [file, snapshotId, expectedHost, expectedPath] = process.argv.slice(2);
  if (!/^[a-f0-9]{64}$/.test(String(snapshotId || "")) || !/^grabenplaner-[a-f0-9]{32}$/.test(String(expectedHost || ""))
    || expectedPath !== "/var/lib/grabenplaner-offsite/staging/current") throw new Error("Retentionparameter ungueltig.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16 * 1024 * 1024) {
    throw new Error("Retentionvorschau ungueltig.");
  }
  const groups = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(groups) || groups.length !== 1) throw new Error("Unerwartete Retentiongruppen.");
  const group = groups[0];
  if (!group || !Array.isArray(group.keep) || (group.remove !== null && !Array.isArray(group.remove))) throw new Error("Retentionlisten fehlen.");
  const remove = group.remove === null ? [] : group.remove;
  if (group.host !== undefined && String(group.host) !== expectedHost) throw new Error("Falsche Retentiongruppe.");
  if (Array.isArray(group.paths) && !group.paths.includes(expectedPath)) throw new Error("Falscher Retentionpfad.");
  for (const list of [group.keep, remove]) {
    if (list.some((entry) => !/^[a-f0-9]{64}$/i.test(String(entry?.id || "")))) throw new Error("Ungueltige Snapshotkennung.");
  }
  const kept = group.keep.filter((entry) => String(entry.id).toLowerCase() === snapshotId).length;
  const removed = remove.some((entry) => String(entry.id).toLowerCase() === snapshotId);
  if (kept !== 1 || removed) throw new Error("Der neue Snapshot wuerde nicht sicher behalten.");
  process.stdout.write(`${JSON.stringify({ ok: true, kept: true })}\n`);
} catch (error) {
  process.stderr.write("Die Restic-Aufbewahrungsvorschau ist nicht sicher bestaetigt.\n");
  process.exitCode = 1;
}
