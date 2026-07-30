"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BACKUP_BUNDLE_DATABASE_FORMATS,
  BACKUP_BUNDLE_FORMAT,
  BACKUP_BUNDLE_METHODS,
  BACKUP_BUNDLE_SCHEMA_VERSION,
  BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS,
  computeBackupBundleHash,
  listBackupBundles,
  pruneBackupBundles,
  readBackupBundle,
  verifyBackupBundle,
  writeBackupBundleCommitMarker,
} = require("../lib/backup-bundle");
const {
  writeBackupCommitMarker,
} = require("../lib/backup-commit");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-bundle-v2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sumTreeBytes(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const candidate = path.join(current, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) stack.push(candidate);
      else total += stat.size;
    }
  }
  return total;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function fixtureOptions(root, {
  snapshotId,
  providerId = "postgresql",
  createdAt = "2026-07-30T10:00:00.000Z",
  verifiedAt = createdAt,
  appVersion = "0.87.0-beta",
  databaseContent = `database:${snapshotId}:${providerId}`,
  documents = [
    {
      storageKey: "00/00000000-0000-4000-8000-000000000001.amu",
      content: "protected-document-1",
    },
    {
      storageKey: "11/11111111-1111-4111-8111-111111111111.amu",
      content: "protected-document-2",
    },
  ],
} = {}) {
  assert.ok(snapshotId, "Die Test-Snapshotkennung fehlt.");
  const databaseFileName = `${snapshotId}.${providerId === "sqlite" ? "db" : "pgdump"}`;
  const databasePath = path.join(root, databaseFileName);
  fs.writeFileSync(databasePath, databaseContent);

  const directoryName = `${snapshotId}.documents`;
  const protectedDirectory = path.join(root, directoryName);
  fs.mkdirSync(path.join(protectedDirectory, "blobs"), { recursive: true });
  const keyCheckContent = Buffer.from(`key-check:${snapshotId}`, "utf8");
  fs.writeFileSync(path.join(protectedDirectory, "key-check.amu"), keyCheckContent);

  const manifestFiles = documents.map(({ storageKey, content }) => {
    const buffer = Buffer.from(content, "utf8");
    const target = path.join(protectedDirectory, "blobs", ...storageKey.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    return {
      storageKey,
      byteSize: buffer.length,
      sha256: sha256(buffer),
    };
  });
  const manifest = {
    format: "grabenplaner-amu-backup",
    version: 1,
    createdAt,
    database: {
      fileName: databaseFileName,
      sha256: sha256File(databasePath),
    },
    snapshot: {
      providerId,
      method: BACKUP_BUNDLE_METHODS[providerId],
      snapshotId,
      sourceEvidenceFingerprint: sha256(`source:${snapshotId}:${providerId}`),
      referenceCount: manifestFiles.length,
    },
    keyCheck: {
      fileName: "key-check.amu",
      byteSize: keyCheckContent.length,
      sha256: sha256(keyCheckContent),
    },
    files: manifestFiles,
  };
  const manifestPath = path.join(protectedDirectory, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const options = {
    backupDirectory: root,
    format: BACKUP_BUNDLE_FORMAT,
    schemaVersion: BACKUP_BUNDLE_SCHEMA_VERSION,
    providerId,
    method: BACKUP_BUNDLE_METHODS[providerId],
    snapshotId,
    createdAt,
    appVersion,
    database: {
      fileName: databaseFileName,
      sha256: sha256File(databasePath),
      bytes: fs.statSync(databasePath).size,
      format: BACKUP_BUNDLE_DATABASE_FORMATS[providerId],
      toolMajor: providerId === "sqlite" ? 3 : 17,
    },
    protectedDocuments: {
      directoryName,
      manifestFileName: "manifest.json",
      manifestSha256: sha256File(manifestPath),
      manifestBytes: fs.statSync(manifestPath).size,
      files: manifestFiles.length,
      bytes: sumTreeBytes(protectedDirectory),
    },
    verification: {
      status: "verified",
      verifiedAt,
      checks: Object.fromEntries(
        BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS.map((key) => [key, true]),
      ),
    },
  };
  return {
    databasePath,
    manifest,
    manifestPath,
    options,
    protectedDirectory,
  };
}

function createCommittedFixture(t, root, settings) {
  const fixture = fixtureOptions(root, settings);
  const markerPath = writeBackupBundleCommitMarker(fixture.options);
  return {
    ...fixture,
    markerPath,
    marker: JSON.parse(fs.readFileSync(markerPath, "utf8")),
  };
}

function createLegacyV1Fixture(root, snapshot = "dienstplan-legacy-20260730") {
  const databasePath = path.join(root, `${snapshot}.db`);
  const protectedDirectory = path.join(root, `${snapshot}.amu`);
  fs.writeFileSync(databasePath, "legacy-sqlite-database");
  fs.mkdirSync(protectedDirectory);
  const databaseSha256 = sha256File(databasePath);
  fs.writeFileSync(path.join(protectedDirectory, "manifest.json"), `${JSON.stringify({
    database: {
      fileName: path.basename(databasePath),
      sha256: databaseSha256,
    },
    files: [],
  })}\n`);
  const markerPath = writeBackupCommitMarker({
    backupDirectory: root,
    snapshot,
    databaseSha256,
    protectedFiles: 0,
    committedAt: "2026-07-29T09:00:00.000Z",
  });
  return { databasePath, markerPath, protectedDirectory };
}

test("Backup-Bundle v2 roundtrip is canonical, exact and provider-filterable", (t) => {
  const root = createRoot(t);
  const postgresql = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T100000Z",
    providerId: "postgresql",
  });
  const sqlite = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T110000Z",
    providerId: "sqlite",
    createdAt: "2026-07-30T11:00:00.000Z",
  });

  const read = readBackupBundle(root, postgresql.markerPath);
  assert.equal(read.committed, true);
  assert.equal(read.verified, true);
  assert.equal(read.providerId, "postgresql");
  assert.equal(read.method, "postgresql-pg-dump-custom");
  assert.equal(read.bundleHash, computeBackupBundleHash(read.marker));
  assert.deepEqual(read.sourceEvidence, {
    fingerprint: sha256(`source:${postgresql.options.snapshotId}:postgresql`),
    referenceCount: 2,
  });
  assert.deepEqual(Object.keys(read.marker), [
    "format",
    "schemaVersion",
    "providerId",
    "method",
    "snapshotId",
    "createdAt",
    "appVersion",
    "database",
    "protectedDocuments",
    "verification",
    "bundleHash",
  ]);
  assert.deepEqual(Object.keys(read.marker.database), [
    "fileName",
    "sha256",
    "bytes",
    "format",
    "toolMajor",
  ]);
  assert.deepEqual(Object.keys(read.marker.protectedDocuments), [
    "directoryName",
    "manifestFileName",
    "manifestSha256",
    "manifestBytes",
    "files",
    "bytes",
  ]);

  const reordered = Object.fromEntries(Object.entries(clone(read.marker)).reverse());
  reordered.database = Object.fromEntries(Object.entries(reordered.database).reverse());
  reordered.protectedDocuments = Object.fromEntries(
    Object.entries(reordered.protectedDocuments).reverse(),
  );
  assert.equal(computeBackupBundleHash(reordered), read.bundleHash);
  assert.doesNotMatch(JSON.stringify(read.marker), /password|secret|databaseUrl|hostName|roleName/i);

  assert.deepEqual(
    listBackupBundles(root).map((bundle) => bundle.snapshotId),
    [sqlite.options.snapshotId, postgresql.options.snapshotId],
  );
  assert.deepEqual(
    listBackupBundles(root, { providerId: "sqlite" }).map((bundle) => bundle.snapshotId),
    [sqlite.options.snapshotId],
  );
  assert.deepEqual(
    listBackupBundles(root, { method: "postgresql-pg-dump-custom" })
      .map((bundle) => bundle.snapshotId),
    [postgresql.options.snapshotId],
  );
  assert.equal(
    fs.readdirSync(root).some((name) => name.includes(".partial-")),
    false,
  );
});

test("database, protected-file and marker tampering invalidate a bundle", (t) => {
  const root = createRoot(t);
  const databaseTamper = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T120000Z",
  });
  fs.appendFileSync(databaseTamper.databasePath, "-tampered");
  assert.throws(
    () => verifyBackupBundle(root, databaseTamper.markerPath),
    expectCode("BACKUP_BUNDLE_COMPONENT_MISMATCH"),
  );

  const manifestBindingTamper = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T121500Z",
  });
  const wrongManifest = clone(manifestBindingTamper.manifest);
  wrongManifest.database.sha256 = "f".repeat(64);
  fs.writeFileSync(
    manifestBindingTamper.manifestPath,
    `${JSON.stringify(wrongManifest, null, 2)}\n`,
  );
  const markerForManifest = clone(manifestBindingTamper.marker);
  markerForManifest.protectedDocuments.manifestSha256 = sha256File(
    manifestBindingTamper.manifestPath,
  );
  markerForManifest.protectedDocuments.manifestBytes = fs.statSync(
    manifestBindingTamper.manifestPath,
  ).size;
  markerForManifest.protectedDocuments.bytes = sumTreeBytes(
    manifestBindingTamper.protectedDirectory,
  );
  markerForManifest.bundleHash = computeBackupBundleHash(markerForManifest);
  fs.writeFileSync(
    manifestBindingTamper.markerPath,
    `${JSON.stringify(markerForManifest, null, 2)}\n`,
  );
  assert.throws(
    () => verifyBackupBundle(root, manifestBindingTamper.markerPath),
    expectCode("BACKUP_BUNDLE_COMPONENT_MISMATCH"),
  );

  const protectedTamper = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T121000Z",
  });
  const protectedFile = path.join(
    protectedTamper.protectedDirectory,
    "blobs",
    ...protectedTamper.manifest.files[0].storageKey.split("/"),
  );
  const original = fs.readFileSync(protectedFile);
  fs.writeFileSync(protectedFile, Buffer.alloc(original.length, 0x78));
  assert.throws(
    () => verifyBackupBundle(root, protectedTamper.markerPath),
    expectCode("BACKUP_BUNDLE_COMPONENT_MISMATCH"),
  );

  const markerTamper = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T122000Z",
  });
  const marker = clone(markerTamper.marker);
  marker.appVersion = "0.87.1-beta";
  fs.writeFileSync(markerTamper.markerPath, `${JSON.stringify(marker)}\n`);
  assert.throws(
    () => readBackupBundle(root, markerTamper.markerPath),
    expectCode("BACKUP_BUNDLE_HASH_MISMATCH"),
  );

  assert.deepEqual(listBackupBundles(root), []);
});

test("partial markers, links and hard-linked components are never accepted", (t) => {
  const root = createRoot(t);
  const partialSnapshot = "dienstplan-20260730T130000Z";
  fs.writeFileSync(
    path.join(root, `${partialSnapshot}.bundle.complete.json.partial-deadbeef`),
    "{}\n",
  );
  assert.deepEqual(listBackupBundles(root), []);

  const linked = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T131000Z",
  });
  const relocatedDocuments = `${linked.protectedDirectory}-relocated`;
  fs.renameSync(linked.protectedDirectory, relocatedDocuments);
  try {
    fs.symlinkSync(
      relocatedDocuments,
      linked.protectedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Das Testsystem erlaubt keine Verzeichnislinks.");
      return;
    }
    throw error;
  }
  assert.throws(
    () => verifyBackupBundle(root, linked.markerPath),
    expectCode("BACKUP_BUNDLE_FILE_UNSAFE"),
  );

  const hardLinked = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T132000Z",
  });
  fs.linkSync(hardLinked.databasePath, `${hardLinked.databasePath}.second-link`);
  assert.throws(
    () => verifyBackupBundle(root, hardLinked.markerPath),
    expectCode("BACKUP_BUNDLE_FILE_UNSAFE"),
  );
  assert.deepEqual(listBackupBundles(root), []);
});

test("extra, secret and provider-mismatched fields are rejected", (t) => {
  const root = createRoot(t);
  const base = fixtureOptions(root, {
    snapshotId: "dienstplan-20260730T140000Z",
  });

  const topLevelSecret = clone(base.options);
  topLevelSecret.databaseUrl = "postgresql://secret@example.invalid/grabenplaner";
  assert.throws(
    () => writeBackupBundleCommitMarker(topLevelSecret),
    expectCode("BACKUP_BUNDLE_SCHEMA_INVALID"),
  );

  const databaseHost = clone(base.options);
  databaseHost.database.host = "database.internal";
  assert.throws(
    () => writeBackupBundleCommitMarker(databaseHost),
    expectCode("BACKUP_BUNDLE_SCHEMA_INVALID"),
  );

  const verificationSecret = clone(base.options);
  verificationSecret.verification.checks.password = "secret";
  assert.throws(
    () => writeBackupBundleCommitMarker(verificationSecret),
    expectCode("BACKUP_BUNDLE_SCHEMA_INVALID"),
  );

  const wrongMethod = clone(base.options);
  wrongMethod.method = BACKUP_BUNDLE_METHODS.sqlite;
  assert.throws(
    () => writeBackupBundleCommitMarker(wrongMethod),
    expectCode("BACKUP_BUNDLE_PROVIDER_MISMATCH"),
  );

  const wrongFormat = clone(base.options);
  wrongFormat.database.format = BACKUP_BUNDLE_DATABASE_FORMATS.sqlite;
  assert.throws(
    () => writeBackupBundleCommitMarker(wrongFormat),
    expectCode("BACKUP_BUNDLE_PROVIDER_MISMATCH"),
  );

  const committed = writeBackupBundleCommitMarker(base.options);
  assert.throws(
    () => verifyBackupBundle(root, committed, { expectedProviderId: "sqlite" }),
    expectCode("BACKUP_BUNDLE_PROVIDER_MISMATCH"),
  );
  assert.throws(
    () => verifyBackupBundle(root, committed, { unexpected: true }),
    expectCode("BACKUP_BUNDLE_SCHEMA_INVALID"),
  );

  const extraMarkerField = JSON.parse(fs.readFileSync(committed, "utf8"));
  extraMarkerField.role = "backup_admin";
  extraMarkerField.bundleHash = computeBackupBundleHash(extraMarkerField);
  fs.writeFileSync(committed, `${JSON.stringify(extraMarkerField)}\n`);
  assert.throws(
    () => readBackupBundle(root, committed),
    expectCode("BACKUP_BUNDLE_SCHEMA_INVALID"),
  );
});

test("v1 SQLite commits stay separate from v2 bundle discovery and pruning", (t) => {
  const root = createRoot(t);
  const legacy = createLegacyV1Fixture(root);
  const current = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T150000Z",
    providerId: "sqlite",
    createdAt: "2026-07-30T15:00:00.000Z",
  });

  assert.deepEqual(
    listBackupBundles(root).map((bundle) => bundle.snapshotId),
    [current.options.snapshotId],
  );
  assert.deepEqual(pruneBackupBundles(root, 0), { removed: 1, retained: 0 });
  assert.equal(fs.existsSync(current.markerPath), false);
  assert.equal(fs.existsSync(current.databasePath), false);
  assert.equal(fs.existsSync(current.protectedDirectory), false);
  assert.equal(fs.existsSync(legacy.markerPath), true);
  assert.equal(fs.existsSync(legacy.databasePath), true);
  assert.equal(fs.existsSync(legacy.protectedDirectory), true);
});

test("retention uses verified v2 creation order and preserves invalid or partial artifacts", (t) => {
  const root = createRoot(t);
  const oldest = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T160000Z",
    createdAt: "2026-07-30T16:00:00.000Z",
  });
  const middle = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T170000Z",
    createdAt: "2026-07-30T17:00:00.000Z",
  });
  const newest = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T180000Z",
    createdAt: "2026-07-30T18:00:00.000Z",
  });
  const invalid = createCommittedFixture(t, root, {
    snapshotId: "dienstplan-20260730T190000Z",
    createdAt: "2026-07-30T19:00:00.000Z",
  });
  fs.writeFileSync(invalid.databasePath, Buffer.alloc(invalid.options.database.bytes, 0x69));
  const partialPath = path.join(
    root,
    "dienstplan-20260730T200000Z.bundle.complete.json.partial-interrupted",
  );
  fs.writeFileSync(partialPath, "{}\n");
  const legacy = createLegacyV1Fixture(root, "dienstplan-legacy-retention");

  fs.utimesSync(oldest.markerPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));
  fs.utimesSync(newest.markerPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  assert.deepEqual(
    listBackupBundles(root).map((bundle) => bundle.snapshotId),
    [newest.options.snapshotId, middle.options.snapshotId, oldest.options.snapshotId],
  );

  assert.deepEqual(pruneBackupBundles(root, 1), { removed: 2, retained: 1 });
  assert.equal(fs.existsSync(newest.markerPath), true);
  assert.equal(fs.existsSync(middle.markerPath), false);
  assert.equal(fs.existsSync(oldest.markerPath), false);
  assert.equal(fs.existsSync(invalid.markerPath), true);
  assert.equal(fs.existsSync(invalid.databasePath), true);
  assert.equal(fs.existsSync(invalid.protectedDirectory), true);
  assert.equal(fs.existsSync(partialPath), true);
  assert.equal(fs.existsSync(legacy.markerPath), true);
  assert.deepEqual(
    listBackupBundles(root).map((bundle) => bundle.snapshotId),
    [newest.options.snapshotId],
  );
});
