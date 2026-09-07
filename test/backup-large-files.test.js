"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { sha256File, HASH_BUFFER_BYTES } = require("../lib/file-integrity");
const { createAmuStorage, readAndVerifyBackup, syncEncryptedFilesBackup,
  verifyBackupReferences, restoreEncryptedFilesBackup } = require("../lib/amu-storage");

function instrument(overrides) {
  const source = fs.readFileSync(path.join(__dirname, "../lib/file-integrity.js"), "utf8");
  const context = { module: { exports: {} }, Buffer, require: name => name === "node:fs" ? { ...fs, ...overrides } : require(name) };
  vm.runInNewContext(source, context);
  return context.module.exports.sha256File;
}

test("large-file hash is exact, bounded to 1 MiB and closes descriptors", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-large-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "sample.db"), bytes = crypto.randomBytes(3 * HASH_BUFFER_BYTES + 17);
  fs.writeFileSync(file, bytes);
  let calls = 0, closed = 0;
  const hash = instrument({
    readFileSync() { assert.fail("whole-file read prohibited"); },
    readSync(fd, buffer, offset, count, position) {
      assert.ok(buffer.length <= HASH_BUFFER_BYTES);
      calls += 1;
      // Short reads are valid, not EOF.
      return fs.readSync(fd, buffer, offset, Math.min(count, 32771), position);
    },
    closeSync(fd) { closed += 1; return fs.closeSync(fd); },
  });
  assert.equal(hash(file), crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.ok(calls > 4);
  assert.equal(closed, 1);
  fs.writeFileSync(file, Buffer.alloc(0));
  assert.equal(sha256File(file), crypto.createHash("sha256").digest("hex"));
  assert.throws(() => sha256File(root), /regulaere/);
});

test("large-file hash fails closed for truncation, same-size mutation and read failure", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-hash-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "sample.db");
  for (const kind of ["truncate", "mutate", "read-error"]) {
    fs.writeFileSync(file, Buffer.alloc(2 * HASH_BUFFER_BYTES, 7));
    let closed = 0, changed = false;
    const hash = instrument({
      readSync(fd, buffer, offset, count, position) {
        if (kind === "read-error") throw new Error("injected read error");
        if (!changed) {
          changed = true;
          if (kind === "truncate") fs.truncateSync(file, 0);
          else fs.utimesSync(file, new Date(), new Date(Date.now() - 60000));
        }
        return fs.readSync(fd, buffer, offset, count, position);
      },
      closeSync(fd) { closed += 1; return fs.closeSync(fd); },
    });
    assert.throws(() => hash(file), /unerwartet|veraendert|injected/);
    assert.equal(closed, 1);
  }
});

test("protected backup reference verification and restore do not retain all file contents", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-document-stream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), backup = path.join(root, "backup"), target = path.join(root, "restored");
  const keys = { test: crypto.randomBytes(32) };
  const storage = createAmuStorage({ rootDirectory: source, encryptionKeys: keys, activeKeyId: "test",
    scanner: async () => ({ available: true, clean: true, engine: "test" }) });
  const saved = await storage.saveBuffer({ buffer: Buffer.from("%PDF-1.7\nsynthetic backup test"), originalName: "synthetic.pdf" });
  syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: backup });
  const result = verifyBackupReferences({ backupDirectory: backup, requiredStorageKeys: [saved.storageKey] });
  assert.equal(Object.hasOwn(result.verified[0], "content"), false);
  assert.ok(Buffer.isBuffer(readAndVerifyBackup(backup).verified[0].content), "legacy content API remains available");
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.ok(!String(file).includes(`${path.sep}blobs${path.sep}`), "no whole blob read in backup verification/restore");
    return read(file, ...args);
  };
  try {
    verifyBackupReferences({ backupDirectory: backup, requiredStorageKeys: [saved.storageKey] });
    assert.equal(restoreEncryptedFilesBackup({ backupDirectory: backup, targetDirectory: target }).fileCount, 1);
  } finally { fs.readFileSync = read; }
  assert.equal(sha256File(path.join(backup, "blobs", saved.storageKey)), sha256File(path.join(target, "blobs", saved.storageKey)));
});

test("all SQLite backup hash entrypoints and Offsite restart use large-data-safe contracts", () => {
  const root = path.resolve(__dirname, "..");
  for (const file of ["backup.js", "lib/backup-commit.js", "server-tools/linux/lib/backup-snapshot.js",
    "server-tools/linux/lib/verify-backup.js", "server-tools/linux/lib/restore-backup.js", "server-tools/linux/backup-grabenplaner.sh"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /file-integrity/, file);
    assert.doesNotMatch(source, /createHash\("sha256"\)\.update\(fs\.readFileSync/, file);
  }
  const stage = fs.readFileSync(path.join(root, "server-tools/linux/offsite/lib/offsite-stage.js"), "utf8");
  assert.match(stage, /Buffer\.allocUnsafe\(1024 \* 1024\)/);
  assert.doesNotMatch(stage, /createHash\("sha256"\)\.update\(fs\.readFileSync/);
  const prepare = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-prepare.sh"), "utf8");
  assert.match(prepare, /gp_wait_ready "\$internal_ready_url" 1500/);
});
