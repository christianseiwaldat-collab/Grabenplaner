"use strict";

// Opt-in, local-only archive. Existing raw pairs without an authenticated
// receipt are never retention candidates. No vault/master key is provisioned.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { sha256File } = require("./file-integrity");
const { verifyCommittedBackup } = require("./backup-commit");
const { assertRetentionScope, planArchiveRetention, RESERVE_BYTES, LOCAL_BACKUP_RETENTION } = require("./local-backup-policy");

const HASH = /^[a-f0-9]{64}$/;
const NAME = /^dienstplan-[0-9A-Za-z._-]{1,170}$/;
const FORMAT = "grabenplaner-local-archive-v1";
const TIMEOUT_MS = 1500000;
const STATE = ".gp-local-archive";
function fail(code) { throw new Error(`LOCAL_ARCHIVE_${code}`); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function name(value) { if (typeof value !== "string" || !NAME.test(value)) fail("SNAPSHOT_INVALID"); return value; }
function checkedPath(value, kind = "directory") {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.startsWith("\\\\")) fail("LOCAL_PATH_REQUIRED");
  const resolved = path.resolve(value), root = path.parse(resolved).root;
  if (resolved === root) fail("ROOT_PATH_FORBIDDEN");
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || (!st.isDirectory() && current !== resolved)) fail("LINK_OR_SPECIAL_PATH");
  }
  const st = fs.lstatSync(resolved);
  if (kind === "file" ? !st.isFile() || st.nlink !== 1 : !st.isDirectory()) fail("LINK_OR_SPECIAL_PATH");
  return resolved;
}
function checkedTree(directory) {
  checkedPath(directory);
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name), st = fs.lstatSync(target);
    if (st.isSymbolicLink()) fail("LINK_OR_SPECIAL_PATH");
    if (st.isDirectory()) bytes += checkedTree(target);
    else { checkedPath(target, "file"); bytes += st.size; }
  }
  return bytes;
}
function readJson(file, maxBytes = 2 * 1024 ** 2) {
  checkedPath(file, "file");
  if (fs.statSync(file).size > maxBytes) fail("METADATA_TOO_LARGE");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("METADATA_INVALID"); }
}
function syncDirectory(directory) {
  // POSIX durability requires the directory entry as well as file contents.
  // Windows does not expose opening directories for fsync through Node.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeNew(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${canonical(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function publish(file, value, temporaryDirectory = path.dirname(file)) {
  const temporary = path.join(temporaryDirectory, `${path.basename(file)}.partial-${crypto.randomUUID()}`);
  writeNew(temporary, value);
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
function pairNames(snapshot) { return [`${name(snapshot)}.db`, `${snapshot}.amu`, `${snapshot}.complete.json`]; }
function checkedPair(directory, snapshot, verifyPair) {
  if (typeof verifyPair !== "function") fail("PAIR_VERIFIER_REQUIRED");
  checkedPath(directory);
  for (const part of pairNames(snapshot)) {
    if (part.endsWith(".amu")) checkedTree(path.join(directory, part));
    else checkedPath(path.join(directory, part), "file");
  }
  let called = false;
  const pair = verifyCommittedBackup(directory, `${snapshot}.complete.json`, { verifyPair(metadata, marker) {
    const result = verifyPair(metadata, marker); called = true;
    if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("SYNC_VERIFIER_REQUIRED"); }
    if (result === false) fail("PAIR_VERIFICATION_FAILED");
  } });
  if (!called) fail("PAIR_VERIFICATION_FAILED");
  const coupledBytes = fs.statSync(pair.databasePath).size + fs.statSync(pair.markerPath).size + checkedTree(pair.protectedDirectory);
  return { ...pair, coupledBytes };
}

function createLocalBackupArchive({ backupDirectory, binary, binarySha256, vault, minimumFreeBytes = RESERVE_BYTES, expectedStream, verifyBinaryOnConstruction = true, clock = () => new Date() } = {}) {
  // Construction is read-only. Even an unconfigured installation must never
  // silently create an archive, secret, directory, or application master key.
  const root = checkedPath(backupDirectory), state = path.join(root, STATE);
  const repository = path.join(state, "repository"), envelopeFile = path.join(state, "recovery-envelope.json");
  const configFile = path.join(state, "config.json"), receipts = path.join(state, "receipts");
  const retired = path.join(state, "retired"), temporaryDirectory = path.join(state, "temporary");
  const lockFile = path.join(state, "operation.lock");
  const pendingFile = path.join(state, "pending-operation.json");
  if (expectedStream !== undefined && !["app", "external"].includes(expectedStream)) fail("EXPECTED_STREAM_INVALID");
  if (!HASH.test(String(binarySha256 || "")) || !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0
    || typeof verifyBinaryOnConstruction !== "boolean") fail("OPTIONS_INVALID");
  if (!vault || typeof vault.seal !== "function" || typeof vault.useSecretSync !== "function") fail("EXISTING_VAULT_REQUIRED");
  const executable = checkedPath(binary, "file");
  function assertBinary() { checkedPath(executable, "file"); if (sha256File(executable) !== binarySha256) fail("BINARY_HASH_MISMATCH"); }
  // Cached health may omit this initial hash only. Every subprocess, including
  // reads, still validates the trusted binary immediately before execution.
  if (verifyBinaryOnConstruction) assertBinary();
  function free(required = 0) {
    const stat = fs.statfsSync(root);
    if (!Number.isSafeInteger(required) || required < 0 || stat.bavail * stat.bsize < minimumFreeBytes + required) fail("CAPACITY_REQUIRED");
  }
  function context(e) { return { namespace: "local-backup-archive", connectorId: e.archiveId, field: "repository-secret", purpose: "local-backup-recovery" }; }
  function credentials(consumer) {
    const e = readJson(envelopeFile);
    if (e.format !== FORMAT || !/^[a-f0-9-]{36}$/.test(String(e.archiveId)) || !/^gp-[a-z0-9-]{1,80}$/.test(String(e.host))
      || !["app", "external"].includes(e.stream) || typeof e.secretEnvelope !== "string") fail("RECOVERY_ENVELOPE_INVALID");
    let result;
    vault.useSecretSync(e.secretEnvelope, context(e), secret => {
      if (secret.length !== 64) fail("RECOVERY_SECRET_INVALID");
      const sign = payload => crypto.createHmac("sha256", secret.subarray(32)).update(canonical(payload)).digest("hex");
      result = consumer({ e, sign, password: secret.subarray(0, 32).toString("base64") });
    });
    return result;
  }
  function signed(payload, c) { return { payload, authentication: c.sign(payload) }; }
  function authenticate(document, c) {
    if (!document?.payload || !HASH.test(String(document.authentication || ""))
      || !crypto.timingSafeEqual(Buffer.from(document.authentication, "hex"), Buffer.from(c.sign(document.payload), "hex"))) fail("AUTHENTICATION_FAILED");
    return document.payload;
  }
  function config(c) {
    const cfg = authenticate(readJson(configFile), c);
    if (cfg.format !== FORMAT || cfg.archiveId !== c.e.archiveId || cfg.host !== c.e.host || cfg.stream !== c.e.stream
      || !HASH.test(String(cfg.repositoryId || ""))) fail("CONFIGURATION_MISMATCH");
    if (expectedStream !== undefined && cfg.stream !== expectedStream) fail("EXPECTED_STREAM_MISMATCH");
    for (const folder of [state, repository, receipts, retired, temporaryDirectory]) checkedPath(folder);
    const known = new Set(["repository", "recovery-envelope.json", "config.json", "receipts", "retired", "temporary", "operation.lock", "pending-operation.json"]);
    if (fs.readdirSync(state).some(entry => !known.has(entry))) fail("STATE_UNKNOWN_REQUIRES_REVIEW");
    return cfg;
  }
  function run(args, c, cwd = root) {
    assertBinary(); checkedPath(state); checkedPath(repository); checkedPath(cwd);
    // No inherited RESTIC, cloud, SSH, proxy, HOME, config or password-command
    // variables. The executable and repository are trusted absolute local paths.
    const env = { RESTIC_PASSWORD: c.password, GOMAXPROCS: "2", GOMEMLIMIT: "384MiB",
      TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory };
    for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawnSync(executable, ["--repo", repository, "--no-cache", "--retry-lock", "0s", "--compression", "auto", ...args], {
      cwd, env, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 ** 2, encoding: "utf8", shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    env.RESTIC_PASSWORD = "";
    // Child output may contain protected document names. Never attach it to an
    // error, log, or credential/config response.
    if (child.error || child.status !== 0) fail(`${String(args[0]).toUpperCase()}_FAILED`);
    return child.stdout;
  }
  function repositoryIdentity(c, cfg) {
    checkedTree(repository);
    const actual = JSON.parse(run(["cat", "config"], c));
    if (actual.id !== cfg.repositoryId) fail("REPOSITORY_MISMATCH");
  }
  function scoped(payload, cfg) {
    if (payload?.format !== FORMAT || payload.archiveId !== cfg.archiveId || payload.repositoryId !== cfg.repositoryId
      || payload.host !== cfg.host || payload.stream !== cfg.stream) fail("OPERATION_SCOPE_MISMATCH");
    return payload;
  }
  function scope(cfg) { return { format: FORMAT, archiveId: cfg.archiveId, repositoryId: cfg.repositoryId, host: cfg.host, stream: cfg.stream }; }
  function lock(operation, { reconciliation = false } = {}) {
    checkedPath(state);
    return credentials(c => {
      const cfg = config(c), token = crypto.randomUUID(); let fd;
      try { fd = fs.openSync(lockFile, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") fail("LOCKED_REQUIRES_REVIEW"); throw error; }
      const owner = { ...scope(cfg), token, pid: process.pid, machine: os.hostname(),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), createdAt: new Date().toISOString() };
      try {
        fs.writeFileSync(fd, canonical(signed(owner, c))); fs.fsyncSync(fd); syncDirectory(state);
        if (!reconciliation && fs.existsSync(pendingFile)) fail("PENDING_RECONCILIATION_REQUIRED");
        return operation(c, cfg);
      } finally {
        fs.closeSync(fd);
        // No stale lock is ever broken implicitly, including after failed work.
        const actual = scoped(authenticate(readJson(lockFile), c), cfg);
        if (actual.token !== token) fail("LOCK_REPLACED");
        fs.unlinkSync(lockFile); syncDirectory(state);
      }
    });
  }
  function beginPending(payload, c, cfg) {
    writeNew(pendingFile, signed({ ...scope(cfg), operationId: crypto.randomUUID(), startedAt: new Date().toISOString(), ...payload }, c));
  }
  function endPending() { checkedPath(pendingFile, "file"); fs.unlinkSync(pendingFile); syncDirectory(state); }
  function readPending(c, cfg) {
    const j = scoped(authenticate(readJson(pendingFile), c), cfg);
    if (!["archive", "retention"].includes(j.kind) || !/^[a-f0-9-]{36}$/.test(String(j.operationId))
      || !Number.isFinite(Date.parse(j.startedAt)) || !Array.isArray(j.baseline)
      || new Set(j.baseline.map(p => p.id)).size !== j.baseline.length || !Array.isArray(j.baselineReceipts)
      || j.baselineReceipts.length !== j.baseline.length
      || new Set(j.baselineReceipts.map(r => r.snapshot)).size !== j.baseline.length
      || j.baselineReceipts.some(r => !NAME.test(String(r.snapshot)) || !j.baseline.some(p => p.id === r.id))
      || j.baseline.some(p => !HASH.test(String(p.id)) || !Number.isFinite(Date.parse(p.time)))) fail("PENDING_INVALID");
    return j;
  }
  function receiptMetadata(payload) {
    return { snapshot: payload.snapshot, databaseFileName: payload.marker.database.fileName,
      createdAt: payload.marker.committedAt, modifiedAt: payload.marker.committedAt, modifiedMs: Date.parse(payload.marker.committedAt),
      marker: payload.marker, databaseSha256: payload.marker.database.sha256, databaseBytes: payload.marker.database.bytes,
      coupledBytes: payload.coupledBytes, committed: true, verified: true, verificationCached: true,
      archived: true, archiveSnapshotId: payload.archiveSnapshotId };
  }
  function readReceipts(c, cfg, folder = receipts, selectedNames) {
    const found = new Map(), ids = new Set();
    for (const entry of selectedNames || fs.readdirSync(folder)) {
      if (!entry.endsWith(".json") || !NAME.test(entry.slice(0, -5))) fail("RECEIPT_STATE_UNKNOWN");
      const r = authenticate(readJson(path.join(folder, entry)), c);
      if (r.format !== FORMAT || r.snapshot !== entry.slice(0, -5) || r.repositoryId !== cfg.repositoryId
        || r.archiveId !== cfg.archiveId || r.host !== cfg.host || r.stream !== cfg.stream
        || !HASH.test(String(r.archiveSnapshotId)) || !HASH.test(String(r.markerSha256))
        || r.marker?.snapshot !== r.snapshot || r.marker?.database?.fileName !== `${r.snapshot}.db`
        || !HASH.test(String(r.marker?.database?.sha256)) || !Number.isSafeInteger(r.marker?.database?.bytes)
        || r.marker.database.bytes <= 0 || !Number.isSafeInteger(r.coupledBytes) || r.coupledBytes < r.marker.database.bytes
        || r.restoreVerification?.status !== "verified" || !Number.isFinite(Date.parse(r.restoreVerification.verifiedAt))
        || !Number.isFinite(Date.parse(r.marker.committedAt)) || !Number.isFinite(Date.parse(r.archiveTime))) fail("RECEIPT_INVALID");
      if (ids.has(r.archiveSnapshotId)) fail("DUPLICATE_SNAPSHOT_ID");
      ids.add(r.archiveSnapshotId);
      found.set(r.snapshot, r);
    }
    return found;
  }
  function receiptInventory(c, cfg, { cached = false } = {}) {
    const entries = fs.readdirSync(receipts);
    if (cached && entries.length > LOCAL_BACKUP_RETENTION + 1) fail("ACTIVE_RECEIPT_WINDOW_EXCEEDED");
    const active = readReceipts(c, cfg, receipts, entries);
    // Retired audit evidence is kept indefinitely, but ordinary inventory and
    // health must remain bounded by the active window, not lifetime history.
    if ([...active.keys()].some(snapshot => fs.existsSync(path.join(retired, `${snapshot}.json`)))) fail("RETIREMENT_STATE_UNKNOWN");
    return active;
  }
  function baselineReceipts(current) { return [...current.receipts.values()].map(r => ({ snapshot: r.snapshot, id: r.archiveSnapshotId })); }
  function committedPoints(points, receiptValues) {
    const dates = new Map([...receiptValues].map(r => [r.archiveSnapshotId, r.marker.committedAt]));
    return points.map(p => {
      if (!dates.has(p.id)) fail('RETENTION_RECEIPT_MISSING');
      return { ...p, time: dates.get(p.id) };
    });
  }
  function retiredForNames(c, cfg, snapshots) {
    const names = [...new Set(snapshots)].map(snapshot => `${name(snapshot)}.json`).filter(entry => fs.existsSync(path.join(retired, entry)));
    return readReceipts(c, cfg, retired, names);
  }
  function snapshotInventory(c, cfg) {
    repositoryIdentity(c, cfg);
    const points = JSON.parse(run(["snapshots", "--json"], c));
    if (!Array.isArray(points)) fail("INVENTORY_INVALID");
    const ids = new Set();
    for (const point of points) {
      if (!HASH.test(String(point.id)) || ids.has(point.id) || !Number.isFinite(Date.parse(point.time)) || point.hostname !== cfg.host
        || canonical([...(point.tags || [])].sort()) !== canonical(["grabenplaner-local", `stream-${cfg.stream}`].sort())) fail("FOREIGN_SNAPSHOT");
      ids.add(point.id);
    }
    return points;
  }
  function inventory(c, cfg) {
    const points = snapshotInventory(c, cfg), rs = receiptInventory(c, cfg);
    for (const point of points) {
      const receipt = [...rs.values()].find(r => r.archiveSnapshotId === point.id);
      if (!receipt || receipt.archiveTime !== point.time) fail("INVENTORY_RECEIPT_MISMATCH");
    }
    if (points.length !== rs.size) fail("INVENTORY_RECEIPT_MISMATCH");
    return { points, receipts: rs };
  }
  function validateTree(c, id, snapshot) {
    const roots = pairNames(snapshot), seen = new Set();
    const rows = run(["ls", "--json", id], c).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    for (const row of rows) {
      if (row.struct_type === "snapshot") continue;
      if (row.struct_type !== "node") fail("TREE_INVALID");
      const p = row.path;
      if (typeof p !== "string" || !p.startsWith("/") || p.includes("\\") || p.includes("\0")
        || p.split("/").some(part => part === "." || part === "..") || !["file", "dir"].includes(row.type)
        || (row.type === "file" && Number(row.links || 1) !== 1)) fail("TREE_UNSAFE");
      const relative = p.slice(1), top = relative.split("/")[0];
      if (!roots.includes(top) || (top !== `${snapshot}.amu` && relative !== top)
        || (relative === top && row.type !== (top.endsWith(".amu") ? "dir" : "file")) || seen.has(relative)) fail("TREE_SCOPE_MISMATCH");
      seen.add(relative);
    }
    if (roots.some(part => !seen.has(part))) fail("TREE_PAIR_MISSING");
  }
  function removeTemporary(directory) {
    checkedPath(temporaryDirectory);
    if (path.dirname(directory) !== temporaryDirectory || !path.basename(directory).startsWith("restore-")) fail("CLEANUP_SCOPE_INVALID");
    if (!fs.existsSync(directory)) return;
    checkedTree(directory);
    fs.rmSync(directory, { recursive: true });
  }
  function restore(c, r, verifyPair) {
    free(r.coupledBytes); validateTree(c, r.archiveSnapshotId, r.snapshot);
    const target = fs.mkdtempSync(path.join(temporaryDirectory, "restore-"));
    let success = false;
    try {
      run(["restore", r.archiveSnapshotId, "--target", target, "--verify"], c);
      checkedTree(target);
      const pair = checkedPair(target, r.snapshot, verifyPair);
      if (canonical(pair.marker) !== canonical(r.marker) || sha256File(pair.markerPath) !== r.markerSha256
        || pair.coupledBytes !== r.coupledBytes) fail("RESTORED_RECEIPT_MISMATCH");
      success = true;
      return { ...pair, archived: true, archiveSnapshotId: r.archiveSnapshotId, temporaryRoot: target,
        cleanup() { removeTemporary(target); } };
    } finally { if (!success) removeTemporary(target); }
  }
  function configured() {
    if (!fs.existsSync(state)) return false;
    checkedPath(state);
    if (!fs.existsSync(envelopeFile) || !fs.existsSync(configFile)) fail("INITIALIZATION_INCOMPLETE_REQUIRES_REVIEW");
    return credentials(c => { config(c); return true; });
  }
  function initialize({ host, stream, confirmation } = {}) {
    if (confirmation !== "initialize-local-archive") fail("EXPLICIT_INITIALIZATION_REQUIRED");
    assertRetentionScope({ host, stream }); free(); assertBinary(); checkedPath(root);
    if (expectedStream !== undefined && expectedStream !== stream) fail("EXPECTED_STREAM_MISMATCH");
    if (fs.existsSync(state)) fail("ALREADY_EXISTS_REQUIRES_REVIEW");
    const secret = crypto.randomBytes(64);
    const e = { format: FORMAT, archiveId: crypto.randomUUID(), host, stream };
    try {
      // Seal before creating any repository. A missing existing vault key cannot
      // leave an initialized, unrecoverable archive behind.
      e.secretEnvelope = vault.seal(secret, context(e));
      fs.mkdirSync(state, { mode: 0o700 });
      syncDirectory(root);
      writeNew(envelopeFile, e);
      for (const folder of [repository, receipts, retired, temporaryDirectory]) fs.mkdirSync(folder, { mode: 0o700 });
      syncDirectory(state);
      // The durable protected envelope remains on every error, including init
      // success followed by configuration/publication failure.
      return credentials(c => {
        run(["init", "--repository-version", "2"], c);
        const actual = JSON.parse(run(["cat", "config"], c));
        if (!HASH.test(String(actual.id))) fail("REPOSITORY_ID_INVALID");
        const cfg = { format: FORMAT, archiveId: e.archiveId, host, stream, repositoryId: actual.id,
          initializedAt: new Date().toISOString() };
        writeNew(configFile, signed(cfg, c));
        return { configured: true, archiveId: cfg.archiveId, repositoryId: cfg.repositoryId, host, stream, retained: 0 };
      });
    } finally { secret.fill(0); }
  }
  function archivePair(snapshot, { verifyPair } = {}) {
    name(snapshot);
    return lock((c, cfg) => {
      const existing = inventory(c, cfg), pair = checkedPair(root, snapshot, verifyPair);
      if (fs.existsSync(path.join(retired, `${snapshot}.json`))) fail("RETIRED_SNAPSHOT_NAME_REUSED");
      const markerSha256 = sha256File(pair.markerPath);
      if (existing.receipts.has(snapshot)) {
        const prior = existing.receipts.get(snapshot);
        if (prior.markerSha256 !== markerSha256 || canonical(prior.marker) !== canonical(pair.marker)) fail("SNAPSHOT_NAME_REUSED");
        return receiptMetadata(prior);
      }
      if ([...existing.receipts.values()].some(r => Date.parse(r.marker.committedAt) > Date.parse(pair.marker.committedAt))) fail("OLDER_RAW_POINT_CANNOT_DISPLACE_NEWER");
      // One candidate archive plus one independent restore, in addition to the
      // caller's existing raw pair and the permanent free-space reserve.
      free(pair.coupledBytes * 2);
      beginPending({ kind: "archive", snapshot, marker: pair.marker, markerSha256, coupledBytes: pair.coupledBytes,
        baseline: existing.points, baselineReceipts: baselineReceipts(existing) }, c, cfg);
      const rows = run(["backup", "--json", "--force", "--read-concurrency", "1", "--host", cfg.host,
        "--tag", "grabenplaner-local", "--tag", `stream-${cfg.stream}`, "--", ...pairNames(snapshot)], c)
        .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const id = rows.find(row => row.message_type === "summary")?.snapshot_id;
      if (!HASH.test(String(id))) fail("BACKUP_SNAPSHOT_ID_MISSING");
      const all = JSON.parse(run(["snapshots", "--json"], c));
      const point = all.find(p => p.id === id);
      if (!point || all.length !== existing.points.length + 1 || point.hostname !== cfg.host
        || canonical([...(point.tags || [])].sort()) !== canonical(["grabenplaner-local", `stream-${cfg.stream}`].sort())
        || existing.points.some(p => !all.some(q => p.id === q.id))) fail("BACKUP_INVENTORY_CHANGED");
      const r = { format: FORMAT, archiveId: cfg.archiveId, repositoryId: cfg.repositoryId, host: cfg.host, stream: cfg.stream,
        snapshot, archiveSnapshotId: id, archiveTime: point.time, marker: pair.marker, markerSha256, coupledBytes: pair.coupledBytes,
        restoreVerification: { status: "verified", verifiedAt: new Date().toISOString() } };
      const restored = restore(c, r, verifyPair);
      restored.cleanup();
      r.restoreVerification.verifiedAt = new Date().toISOString();
      // Recheck the original pair after restoration, before authenticating it.
      const unchanged = checkedPair(root, snapshot, verifyPair);
      if (sha256File(unchanged.markerPath) !== markerSha256 || canonical(unchanged.marker) !== canonical(pair.marker)) fail("RAW_PAIR_CHANGED");
      publish(path.join(receipts, `${snapshot}.json`), signed(r, c), temporaryDirectory);
      inventory(c, cfg);
      endPending();
      return receiptMetadata(r);
    });
  }
  function listMetadata({ verifyInventory = true } = {}) {
    if (typeof verifyInventory !== "boolean") fail("OPTIONS_INVALID");
    if (!configured()) return [];
    // Cached health is authenticated metadata only: no subprocess, repository
    // traversal, database hash or lock mutation. Races make diagnostics
    // unavailable; a health request must never interrupt an operational lock.
    const metadata = rs => [...rs.values()].map(receiptMetadata)
      .sort((a, b) => b.modifiedMs - a.modifiedMs || a.snapshot.localeCompare(b.snapshot));
    if (verifyInventory) return lock((c, cfg) => metadata(inventory(c, cfg).receipts));
    return credentials(c => {
      const cfg = config(c);
      const assertIdle = () => {
        if (fs.lstatSync(lockFile, { throwIfNoEntry: false })) fail("LOCKED_REQUIRES_REVIEW");
        if (fs.lstatSync(pendingFile, { throwIfNoEntry: false })) fail("PENDING_RECONCILIATION_REQUIRED");
      };
      assertIdle();
      const active = receiptInventory(c, cfg, { cached: true });
      assertIdle();
      // A writer may finish between the two idle checks. Receipt files are
      // immutable; a changed active name set is still a diagnostic race.
      if (canonical(fs.readdirSync(receipts).sort()) !== canonical([...active.keys()].map(s => `${s}.json`).sort())) fail("CACHED_METADATA_CHANGED");
      assertIdle();
      return metadata(active);
    });
  }
  function preflightBackup() {
    // Worker/offline-only: validate BEFORE a producer creates another raw
    // snapshot. Pending/corrupt archives must not accumulate unregistered raw
    // backups on each scheduled retry. No snapshot, receipt or key is changed.
    return lock((c, cfg) => {
      const current = inventory(c, cfg);
      if (current.points.length > LOCAL_BACKUP_RETENTION) fail("RETENTION_COMPLETION_REQUIRED");
      // Check structure here. The complete data read belongs to retention,
      // before any deletion, and is not repeated for the same backup.
      free(); run(["check"], c); free();
      return { ready: true, retained: current.points.length, retention: LOCAL_BACKUP_RETENTION, retentionUnit: 'calendar-days', host: cfg.host, stream: cfg.stream,
        archiveId: cfg.archiveId, repositoryId: cfg.repositoryId };
    });
  }
  function materialize(snapshot, { verifyPair } = {}) {
    name(snapshot);
    return lock((c, cfg) => {
      const r = inventory(c, cfg).receipts.get(snapshot);
      if (!r) fail("SNAPSHOT_NOT_FOUND");
      return restore(c, r, verifyPair);
    });
  }
  function maintainRetention(latestSnapshot, { verifyPair } = {}) {
    name(latestSnapshot);
    return lock((c, cfg) => {
      const current = inventory(c, cfg), latest = current.receipts.get(latestSnapshot);
      if (!latest || current.points.some(p => Date.parse(p.time) > Date.parse(latest.archiveTime))) fail("LATEST_POINT_REQUIRED");
      const rawLatest = checkedPair(root, latestSnapshot, verifyPair);
      if (canonical(rawLatest.marker) !== canonical(latest.marker) || sha256File(rawLatest.markerPath) !== latest.markerSha256) fail("LATEST_RAW_PAIR_MISMATCH");
      // Every authenticated receipt already proves an independent GP restore.
      // The immutable archived bytes are read again below before deletion;
      // restoring that identical pair twice more provides no additional proof.
      const preview = planArchiveRetention({ snapshots: committedPoints(current.points, current.receipts.values()), host: cfg.host, stream: cfg.stream, latestId: latest.archiveSnapshotId, now: clock() });
      const removeIds = current.points.filter(p => !preview.retainedIds.includes(p.id)).map(p => p.id);
      // Preflight every raw deletion candidate before ANY destructive step.
      const rawCandidates = [];
      const namedRaw = fs.readdirSync(root).filter(entry => entry.endsWith(".complete.json") && NAME.test(entry.slice(0, -14)))
        .map(entry => entry.slice(0, -14)).filter(snapshot => !current.receipts.has(snapshot));
      for (const r of [...current.receipts.values(), ...retiredForNames(c, cfg, namedRaw).values()]) {
        if (r.snapshot === latestSnapshot) continue;
        const present = pairNames(r.snapshot).filter(file => fs.existsSync(path.join(root, file)));
        if (!present.length) continue;
        if (present.length !== 3) fail("REGISTERED_RAW_PAIR_INCOMPLETE");
        const pair = checkedPair(root, r.snapshot, verifyPair);
        if (canonical(pair.marker) !== canonical(r.marker) || sha256File(pair.markerPath) !== r.markerSha256) fail("REGISTERED_RAW_PAIR_CHANGED");
        rawCandidates.push({ ...pair, registeredMarkerSha256: r.markerSha256 });
      }
      // Unknown/stale receipts, changed inventory or foreign snapshots abort
      // before forgetting. Apply only the exact IDs in this locked preview.
      const before = inventory(c, cfg);
      if (canonical(before.points) !== canonical(current.points)) fail("RETENTION_INVENTORY_CHANGED");
      beginPending({ kind: "retention", baseline: current.points, baselineReceipts: baselineReceipts(current), removeIds, retainedIds: preview.retainedIds,
        retentionPolicy: preview.policy, retentionAsOf: preview.asOf,
        latestSnapshot, latestId: latest.archiveSnapshotId }, c, cfg);
      // Keep a durable pending operation even if this check fails. Scheduled
      // retries must not accumulate new raw pairs after detecting corruption.
      run(["check", "--read-data"], c);
      if (removeIds.length) {
        run(["forget", "--json", "--", ...removeIds], c);
        const remaining = JSON.parse(run(["snapshots", "--json"], c));
        if (canonical(remaining.map(p => p.id).sort()) !== canonical(preview.retainedIds.slice().sort())) fail("RETENTION_RESULT_MISMATCH");
        for (const r of current.receipts.values()) if (removeIds.includes(r.archiveSnapshotId)) {
          // Keep the authenticated retirement evidence rather than silently
          // erasing receipts. Interrupted operations fail closed next time.
          const source = path.join(receipts, `${r.snapshot}.json`), target = path.join(retired, `${r.snapshot}.json`);
          if (fs.existsSync(target)) fail("RETIREMENT_STATE_UNKNOWN");
          fs.renameSync(source, target);
          syncDirectory(receipts); syncDirectory(retired);
        }
        inventory(c, cfg);
      }
      // Zero repacking: only unreferenced packs are deleted, retained data
      // packs are never rewritten. Also reclaims packs after reconciliation.
      run(["prune", "--max-unused", "0", "--max-repack-size", "0"], c);
      // Recheck all references and pack presence after the index/snapshot
      // mutation before deleting raw fallbacks. The retained pack contents
      // have already passed the complete cryptographic read above.
      run(["check"], c);
      inventory(c, cfg);
      for (const pair of rawCandidates) {
        // Destruction is confined to exact authenticated names in this area.
        // No globs, legacy pairs, current raw pair or foreign directories.
        const rechecked = checkedPair(root, pair.snapshot, verifyPair);
        if (canonical(rechecked.marker) !== canonical(pair.marker)
          || sha256File(rechecked.markerPath) !== pair.registeredMarkerSha256) fail("RAW_DELETE_PAIR_CHANGED");
        if ([pair.markerPath, pair.databasePath, pair.protectedDirectory].some(p => path.dirname(p) !== root)) fail("RAW_DELETE_SCOPE_INVALID");
        fs.unlinkSync(pair.markerPath); fs.unlinkSync(pair.databasePath);
        fs.rmSync(pair.protectedDirectory, { recursive: true });
        syncDirectory(root);
      }
      endPending();
      return { retained: preview.retained, removedArchives: removeIds.length, removedRaw: rawCandidates.length,
        latestRawRetained: latestSnapshot, unregisteredRawRemoved: 0 };
    });
  }
  function inspect({ auditRetired = false } = {}) {
    if (typeof auditRetired !== "boolean") fail("OPTIONS_INVALID");
    if (!configured()) return { configured: false, enabled: false, retention: LOCAL_BACKUP_RETENTION, retentionUnit: 'calendar-days' };
    return lock((c, cfg) => {
      const current = inventory(c, cfg);
      const retiredEvidence = auditRetired ? readReceipts(c, cfg, retired) : null;
      if (retiredEvidence) {
        const activeIds = new Set(current.points.map(p => p.id));
        if ([...retiredEvidence.values()].some(r => activeIds.has(r.archiveSnapshotId))) fail("RETIREMENT_STATE_UNKNOWN");
      }
      return { configured: true, enabled: true, retention: LOCAL_BACKUP_RETENTION, retentionUnit: 'calendar-days', archiveId: cfg.archiveId, repositoryId: cfg.repositoryId,
        host: cfg.host, stream: cfg.stream, recoveryEnvelopePath: envelopeFile, retained: current.points.length,
        archiveBytes: checkedTree(repository), temporaryBytes: checkedTree(temporaryDirectory),
        ...(retiredEvidence ? { retiredAudit: { verified: true, receipts: retiredEvidence.size } } : {}) };
    });
  }
  function reconcile({ confirmation, verifyPair } = {}) {
    if (confirmation !== "reconcile-local-archive") fail("EXPLICIT_RECONCILIATION_REQUIRED");
    if (typeof verifyPair !== "function") fail("PAIR_VERIFIER_REQUIRED");
    return lock((c, cfg) => {
      if (!fs.existsSync(pendingFile)) return { reconciled: false, reason: "no-pending-operation", removedRaw: 0, removedArchives: 0 };
      const j = readPending(c, cfg), points = snapshotInventory(c, cfg), active = readReceipts(c, cfg),
        old = retiredForNames(c, cfg, j.baselineReceipts.map(r => r.snapshot));
      const baseline = new Map(j.baseline.map(p => [p.id, p]));
      if (points.some(p => baseline.has(p.id) && canonical(p) !== canonical(baseline.get(p.id)))) fail("RECONCILIATION_BASELINE_CHANGED");
      if (j.kind === "archive") {
        name(j.snapshot);
        if (j.baseline.some(p => !points.some(q => q.id === p.id))) fail("RECONCILIATION_BASELINE_MISSING");
        const added = points.filter(p => !baseline.has(p.id));
        if (added.length > 1 || old.has(j.snapshot)) fail("RECONCILIATION_FOREIGN_SNAPSHOT");
        if ([...active.values()].some(r => !baseline.has(r.archiveSnapshotId)
          && !(added.length === 1 && r.snapshot === j.snapshot && r.archiveSnapshotId === added[0].id))) fail("RECONCILIATION_RECEIPT_MISMATCH");
        for (const p of j.baseline) {
          const r = [...active.values()].find(r => r.archiveSnapshotId === p.id);
          if (!r || r.archiveTime !== p.time) fail("RECONCILIATION_RECEIPT_MISSING");
        }
        if (!added.length) {
          inventory(c, cfg); endPending();
          return { reconciled: true, kind: j.kind, outcome: "no-snapshot-created", removedRaw: 0, removedArchives: 0 };
        }
        const pair = checkedPair(root, j.snapshot, verifyPair);
        if ([...active.values()].some(r => r.snapshot !== j.snapshot && Date.parse(r.marker.committedAt) > Date.parse(pair.marker.committedAt))) fail("OLDER_RAW_POINT_CANNOT_DISPLACE_NEWER");
        if (canonical(pair.marker) !== canonical(j.marker) || sha256File(pair.markerPath) !== j.markerSha256
          || pair.coupledBytes !== j.coupledBytes) fail("RECONCILIATION_RAW_PAIR_CHANGED");
        const expected = { ...scope(cfg), snapshot: j.snapshot, archiveSnapshotId: added[0].id, archiveTime: added[0].time,
          marker: j.marker, markerSha256: j.markerSha256, coupledBytes: j.coupledBytes };
        const published = active.get(j.snapshot);
        // A crash after durable receipt publication is a legitimate journal
        // state. Authenticate and verify that exact receipt; never replace it
        // merely to stamp a new restoration time during reconciliation.
        if (published && Object.keys(expected).some(key => canonical(published[key]) !== canonical(expected[key]))) fail("RECONCILIATION_RECEIPT_MISMATCH");
        const r = published || { ...expected,
          restoreVerification: { status: "verified", verifiedAt: new Date().toISOString() } };
        const restored = restore(c, r, verifyPair); restored.cleanup();
        const unchanged = checkedPair(root, j.snapshot, verifyPair);
        if (canonical(unchanged.marker) !== canonical(j.marker) || sha256File(unchanged.markerPath) !== j.markerSha256) fail("RECONCILIATION_RAW_PAIR_CHANGED");
        if (!published) {
          r.restoreVerification.verifiedAt = new Date().toISOString();
          publish(path.join(receipts, `${j.snapshot}.json`), signed(r, c), temporaryDirectory);
        }
        inventory(c, cfg); endPending();
        return { reconciled: true, kind: j.kind, outcome: published ? "verified-existing-receipt" : "verified-receipt-published",
          snapshot: j.snapshot, removedRaw: 0, removedArchives: 0 };
      }
      name(j.latestSnapshot);
      if (!Array.isArray(j.removeIds) || !Array.isArray(j.retainedIds) || !HASH.test(String(j.latestId))
        || !j.retainedIds.includes(j.latestId) || new Set([...j.removeIds, ...j.retainedIds]).size !== j.baseline.length
        || canonical([...j.removeIds, ...j.retainedIds].sort()) !== canonical([...baseline.keys()].sort())
        || (j.retentionPolicy === 'daily-calendar-v1'
          ? canonical(j.retainedIds.slice().sort()) !== canonical(planArchiveRetention({ snapshots: committedPoints(j.baseline, [...active.values(), ...old.values()]), host: cfg.host, stream: cfg.stream,
            latestId: j.latestId, now: j.retentionAsOf }).retainedIds.slice().sort())
          : j.retentionPolicy !== undefined || j.retainedIds.length !== Math.min(30, j.baseline.length))
        || points.some(p => !baseline.has(p.id)) || j.retainedIds.some(id => !points.some(p => p.id === id))) fail("RECONCILIATION_RETENTION_INVALID");
      const latest = active.get(j.latestSnapshot);
      if (!latest || latest.archiveSnapshotId !== j.latestId) fail("RECONCILIATION_LATEST_MISSING");
      const presentIds = new Set(points.map(p => p.id)), missing = j.removeIds.filter(id => !presentIds.has(id));
      if ([...active.values()].some(r => !baseline.has(r.archiveSnapshotId))) fail("RECONCILIATION_FOREIGN_RECEIPT");
      const moves = [];
      for (const p of j.baseline) {
        const a = [...active.values()].find(r => r.archiveSnapshotId === p.id), b = [...old.values()].find(r => r.archiveSnapshotId === p.id);
        if (presentIds.has(p.id)) { if (!a || b || a.archiveTime !== p.time) fail("RECONCILIATION_RECEIPT_MISMATCH"); }
        else {
          if (!missing.includes(p.id) || (!!a === !!b) || (a || b).archiveTime !== p.time) fail("RECONCILIATION_RETIREMENT_MISMATCH");
          if (a) moves.push(a);
        }
      }
      // Reconciliation publishes receipts/moves already-retired evidence ONLY;
      // it never forgets a snapshot, prunes packs, or deletes a raw backup.
      run(["check", "--read-data"], c);
      const newestRaw = checkedPair(root, j.latestSnapshot, verifyPair);
      if (canonical(newestRaw.marker) !== canonical(latest.marker) || sha256File(newestRaw.markerPath) !== latest.markerSha256) fail("RECONCILIATION_LATEST_RAW_CHANGED");
      const restored = restore(c, latest, verifyPair); restored.cleanup();
      for (const r of moves) {
        const target = path.join(retired, `${r.snapshot}.json`);
        if (fs.existsSync(target)) fail("RECONCILIATION_RETIREMENT_COLLISION");
        fs.renameSync(path.join(receipts, `${r.snapshot}.json`), target); syncDirectory(receipts); syncDirectory(retired);
      }
      inventory(c, cfg); endPending();
      return { reconciled: true, kind: j.kind, outcome: "retention-receipts-reconciled", retiredReceipts: moves.length,
        remainingArchivePoints: points.length, removedRaw: 0, removedArchives: 0 };
    }, { reconciliation: true });
  }
  function releaseStaleLock({ confirmation, expectedToken } = {}) {
    if (confirmation !== "release-local-archive-lock" || !/^[a-f0-9-]{36}$/.test(String(expectedToken))) fail("EXPLICIT_LOCK_RELEASE_REQUIRED");
    return credentials(c => {
      const cfg = config(c), owner = scoped(authenticate(readJson(lockFile), c), cfg);
      if (owner.token !== expectedToken || owner.machine !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !Number.isFinite(Date.parse(owner.processStartedAt)) || !Number.isFinite(Date.parse(owner.createdAt))
        || Date.parse(owner.processStartedAt) > Date.parse(owner.createdAt)) fail("LOCK_OWNER_UNVERIFIABLE");
      const assertDead = () => {
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") return; fail("LOCK_OWNER_UNVERIFIABLE"); }
        fail("LOCK_OWNER_STILL_RUNNING");
      };
      assertDead();
      const unchanged = scoped(authenticate(readJson(lockFile), c), cfg);
      if (canonical(unchanged) !== canonical(owner)) fail("LOCK_REPLACED");
      assertDead(); fs.unlinkSync(lockFile); syncDirectory(state);
      return { released: true, pendingReconciliationRequired: fs.existsSync(pendingFile), removedRaw: 0, removedArchives: 0 };
    });
  }
  return Object.freeze({ configured, initialize, preflightBackup, archivePair, listMetadata, materialize, maintainRetention, inspect, reconcile, releaseStaleLock });
}

module.exports = { createLocalBackupArchive, TIMEOUT_MS };
