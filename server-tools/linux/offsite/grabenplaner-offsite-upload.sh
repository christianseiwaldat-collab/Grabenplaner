#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

# BEGIN_UPLOAD_EVIDENCE_HELPERS
# Kept inside this already pinned module artifact. No new executable or
# artifact-set capability is introduced by the compatible module13 refresh.
offsite_upload_evidence_helper() {
  "$OFFSITE_NODE" - "$@" <<'NODE'
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const LIMIT = 256 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
function redact(value) {
  return String(value || "").split(/\r?\n/).map((line) =>
    /authorization|\bbearer\b|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|credential|\bsecret\b/i.test(line)
      ? "[sensitive diagnostic line omitted]" : line.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
  ).join("\n");
}
function directory(file, mode = null) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error("unsafe directory");
  const st = fs.lstatSync(file);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== "win32"
    && (st.uid !== 0 || (mode !== null && (st.mode & 0o7777) !== mode)))) throw new Error("unsafe directory");
  return st;
}
function privateWrite(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function diagnosticText(value, limit = LIMIT) {
  return redact(Buffer.from(String(value || "")).subarray(0, limit).toString("utf8"));
}
function transientFailure(result) {
  const text = String(result.stderr || "");
  // Authentication, binding/configuration, missing-repository and integrity
  // failures must never become a successful retry of some different object.
  if (/wrong password|invalid[_ -]grant|unauthorized|permission denied|access denied|repository.*(?:does not exist|not found)|invalid.*(?:config|credential)|hash mismatch|checksum|corrupt|\b401\b/i.test(text)) return false;
  if (/forbidden|\b403\b/i.test(text) && !/userRateLimitExceeded|rateLimitExceeded/i.test(text)) return false;
  if (result.status === 124 || (result.status === 137 && result.elapsedMs >= 120000)) return true;
  return /timed?\s*out|timeout|deadline exceeded|connection (?:reset|refused|closed)|network is unreachable|temporary failure|unexpected EOF|error talking HTTP to rclone:.*EOF|TLS handshake|dial tcp|i\/o timeout|too many requests|rateLimitExceeded|userRateLimitExceeded|backendError|(?:HTTP|status(?: code)?|response).*\b(?:429|500|502|503|504)\b/i.test(text);
}
function confirmSnapshot(args) {
  const [common, credentials, expected, host, stage, operation, attemptText] = args;
  const attempt = Number(attemptText);
  if (!HASH.test(expected) || !/^grabenplaner-[a-f0-9]{32}$/.test(host)
    || stage !== "/var/lib/grabenplaner-offsite/staging/current" || !Number.isInteger(attempt)
    || attempt < 1 || attempt > 3) throw new Error("invalid confirmation arguments");
  directory(operation, 0o700);
  const start = Date.now();
  // An independent process group bounds the provider/Restic subtree, including
  // its repository-lock wait. Retrying confirmation never invokes backup.
  const result = childProcess.spawnSync("/usr/bin/timeout", ["--signal=TERM", "--kill-after=5s", "120s",
    "/bin/bash", "-c", 'set -Eeuo pipefail; source "$1"; offsite_restic "$2" snapshots --json "$3"',
    "grabenplaner-snapshot-confirm", common, credentials, expected],
  { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 130000, killSignal: "SIGTERM" });
  result.elapsedMs = Date.now() - start;
  let state = "rejected", reason = "command-failed";
  if (result.error) reason = result.error.code === "ENOBUFS" ? "response-limit" : "command-unavailable";
  else if (result.status !== 0) {
    if (transientFailure(result)) { state = "retryable"; reason = "temporary-transport"; }
  } else {
    let values;
    try { values = JSON.parse(result.stdout); } catch { reason = "invalid-response"; }
    if (Array.isArray(values) && values.length === 0) { state = "retryable"; reason = "temporarily-absent"; }
    else if (Array.isArray(values) && values.length === 1) {
      const item = values[0];
      if (item && String(item.id || "").toLowerCase() === expected && item.hostname === host
        && Array.isArray(item.paths) && item.paths.length === 1 && item.paths[0] === stage
        && Array.isArray(item.tags) && item.tags.length === 2
        && [...item.tags].sort().join("\0") === ["daily", "grabenplaner-offsite"].join("\0")
        && Number.isFinite(Date.parse(String(item.time || "")))) { state = "confirmed"; reason = "exact-identity"; }
      else reason = "identity-mismatch";
    } else if (values !== undefined) reason = "ambiguous-response";
  }
  const prefix = path.join(operation, `snapshot-confirm-${attempt}`);
  privateWrite(`${prefix}.out`, diagnosticText(result.stdout));
  privateWrite(`${prefix}.error`, diagnosticText(result.stderr, 64 * 1024));
  privateWrite(`${prefix}.result.json`, JSON.stringify({ state, reason, expectedSnapshotId: expected,
    attempt, exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null, elapsedMs: result.elapsedMs }, null, 2) + "\n");
  return state === "confirmed" ? 0 : state === "retryable" ? 75 : 1;
}
function readDiagnostic(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (process.platform !== "win32" && before.uid !== 0)) throw new Error("unsafe diagnostic");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error("diagnostic changed");
    const bytes = Buffer.alloc(Math.min(before.size, limit));
    const count = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, before.size - bytes.length));
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("diagnostic changed");
    const text = redact(bytes.subarray(0, count).toString("utf8"));
    return { originalBytes: before.size, truncated: before.size > count, text,
      sha256: crypto.createHash("sha256").update(text).digest("hex") };
  } finally { fs.closeSync(fd); }
}
function retainFailure(args) {
  const [stateRoot, operation, phase, errorCode, exitText, snapshot, attemptText] = args;
  const exitCode = Number(exitText), attempts = Number(attemptText);
  const phases = new Set(["repository-identity", "backup", "snapshot-id", "snapshot-confirmation", "repository-check", "retention-preview", "retention-verify", "retention", "post-check", "status-success"]);
  if (!phases.has(phase) || !/^[A-Z_]{1,64}$/.test(errorCode) || !Number.isInteger(exitCode)
    || exitCode < 1 || exitCode > 255 || !Number.isInteger(attempts) || attempts < 0 || attempts > 3
    || (snapshot && !HASH.test(snapshot))) throw new Error("invalid failure metadata");
  directory(stateRoot);
  directory(operation, 0o700);
  if (path.dirname(operation) !== stateRoot || !/^\.upload\.[A-Za-z0-9]{8}$/.test(path.basename(operation))) throw new Error("unexpected operation root");
  const root = path.join(stateRoot, "upload-failures");
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  directory(root, 0o700);
  const allowed = /^(?:backup\.(?:jsonl|error)|snapshot-confirm-[123]\.(?:out|error|result\.json)|(?:check|post-check|forget-dry|forget)\.(?:out|json|error))$/;
  const files = [];
  let remaining = TOTAL_LIMIT;
  for (const name of fs.readdirSync(operation).filter((name) => allowed.test(name)).sort()) {
    if (remaining <= 0) break;
    const record = readDiagnostic(path.join(operation, name), Math.min(LIMIT, remaining));
    remaining -= Buffer.byteLength(record.text);
    files.push({ name, ...record });
  }
  const record = { format: "grabenplaner-offsite-upload-failure", schemaVersion: 1,
    createdAt: new Date().toISOString(), phase, errorCode, exitCode, snapshotId: snapshot || null,
    confirmationAttempts: attempts, retention: { days: 30, maximumRecords: 20,
      maximumSourceBytes: TOTAL_LIMIT, maximumFileBytes: LIMIT }, files };
  const name = `failure-${record.createdAt.replace(/[-:.]/g, "")}-${crypto.randomUUID()}.json`;
  const target = path.join(root, name), temporary = path.join(root, `.${crypto.randomUUID()}.partial`);
  try {
    privateWrite(temporary, JSON.stringify(record, null, 2) + "\n");
    // Exclusive atomic publication; no existing evidence may be overwritten.
    fs.linkSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  pruneEvidence(stateRoot, target);
  return 0;
}
function pruneEvidence(stateRoot, protectedTarget = null) {
  directory(stateRoot);
  const root = path.join(stateRoot, "upload-failures");
  if (!fs.existsSync(root)) return 0;
  directory(root, 0o700);
  const ownName = /^failure-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json$/;
  const old = [];
  for (const item of fs.readdirSync(root).filter((item) => ownName.test(item))) {
    const full = path.join(root, item), st = fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16 * 1024 * 1024
      || (process.platform !== "win32" && (st.uid !== 0 || (st.mode & 0o7777) !== 0o600))) continue;
    let value;
    try { value = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (value?.format !== "grabenplaner-offsite-upload-failure" || value.schemaVersion !== 1 || !Number.isFinite(Date.parse(value.createdAt))) continue;
    old.push({ file: full, at: Date.parse(value.createdAt) });
  }
  old.sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
  const keep = new Set(protectedTarget ? [protectedTarget] : []);
  for (const item of old) if (keep.size < 20 && item.at >= Date.now() - 30 * 86400000) keep.add(item.file);
  for (const item of old) if (!keep.has(item.file)) fs.unlinkSync(item.file);
  return 0;
}
if (!globalThis.GP_OFFSITE_HELPER_TEST) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    process.exitCode = mode === "confirm" ? confirmSnapshot(args) : mode === "retain" ? retainFailure(args)
      : mode === "prune" && args.length === 1 ? pruneEvidence(args[0]) : 1;
  } catch {
    process.stderr.write("Der private Offsite-Pruefnachweis konnte nicht sicher verarbeitet werden.\n");
    process.exitCode = 1;
  }
}
if (typeof module !== "undefined") module.exports = { redact, transientFailure, confirmSnapshot, retainFailure, pruneEvidence };
NODE
}

offsite_confirm_uploaded_snapshot() {
  local confirmation_status
  for confirmation_attempt in 1 2 3; do
    if offsite_upload_evidence_helper confirm "$SCRIPT_DIR/lib/offsite-common.sh" "$uploader_credentials" \
      "$snapshot_id" "$installation_host" "$OFFSITE_STAGE_CURRENT" "$operation_root" "$confirmation_attempt"; then
      return 0
    else
      confirmation_status=$?
    fi
    # Only a classified transient failure or temporary absence is retried.
    (( confirmation_status == 75 && confirmation_attempt < 3 )) || return 1
    offsite_warn "Die exakte Snapshot-Bestaetigung wird nach einem voruebergehenden Fehler begrenzt wiederholt (Versuch $confirmation_attempt/3)."
    if (( confirmation_attempt == 1 )); then sleep 5; else sleep 15; fi
  done
  return 1
}
# END_UPLOAD_EVIDENCE_HELPERS

credentials_source=""
lock_already_held=0
while (($#)); do
  case "$1" in
    --credentials-source) credentials_source="${2:?Wert fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
offsite_require_root
for command_name in awk flock mktemp rm runuser sha256sum stat timeout sleep; do offsite_require_command "$command_name"; done
offsite_assert_runtime_binaries
[[ -d "$OFFSITE_STAGE_CURRENT" && ! -L "$OFFSITE_STAGE_CURRENT" ]] \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
"$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$OFFSITE_STAGE_CURRENT" >/dev/null 2>&1 \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."

if [[ -n "$credentials_source" ]]; then
  [[ "$credentials_source" == "$OFFSITE_CONFIG_ROOT" && "$lock_already_held" -eq 1 ]] \
    || offsite_die "Direkte Credentials sind nur fuer den bereits gesperrten Update-Hook erlaubt."
  system_credentials="$OFFSITE_CONFIG_ROOT"
else
  system_credentials="$(offsite_credentials_directory)"
fi
uploader_credentials="$(offsite_make_uploader_credentials "$system_credentials")"
offsite_assert_persistent_rclone_config
installation_host="$(offsite_installation_host "$uploader_credentials")"
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .upload.XXXXXXXX)"
chmod 0700 -- "$operation_root"
phase="repository-identity"
failure_code="REPOSITORY_ID_MISMATCH"
snapshot_id=""
confirmation_attempt=0
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    offsite_upload_evidence_helper retain "$OFFSITE_STATE_ROOT" "$operation_root" "$phase" "$failure_code" \
      "$result" "$snapshot_id" "$confirmation_attempt" \
      || offsite_warn "Der private Upload-Fehlerbeleg konnte nicht sicher aufbewahrt werden."
  else
    offsite_upload_evidence_helper prune "$OFFSITE_STATE_ROOT" \
      || offsite_warn "Die privaten Upload-Fehlerbelege konnten nicht planmaessig bereinigt werden."
  fi
  rm -rf --one-file-system -- "$operation_root" 2>/dev/null || true
  offsite_remove_uploader_credentials "$uploader_credentials" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT

if (( lock_already_held == 1 )); then
  offsite_assert_inherited_repository_lock
else
  offsite_acquire_repository_lock
fi
offsite_status attempt >/dev/null
repository_config="$operation_root/repository-config.json"
if ! offsite_verify_repository_identity "$uploader_credentials" "$repository_config"; then
  offsite_fixed_failure REPOSITORY_ID_MISMATCH "Das Offsite-Repository stimmt nicht mit der eingerichteten Identitaet ueberein."
fi

backup_output="$operation_root/backup.jsonl"
backup_error="$operation_root/backup.error"
phase="backup"
failure_code="UPLOAD_FAILED"
if ! offsite_restic "$uploader_credentials" backup --json --host "$installation_host" --tag grabenplaner-offsite --tag daily \
  -- "$OFFSITE_STAGE_CURRENT" >"$backup_output" 2>"$backup_error"; then
  offsite_fixed_failure UPLOAD_FAILED "Die verschluesselte Offsite-Sicherung konnte nicht uebertragen werden."
fi
phase="snapshot-id"
failure_code="SNAPSHOT_VERIFY_FAILED"
snapshot_id="$("$OFFSITE_NODE" - "$backup_output" <<'NODE'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean);
let snapshot = "";
for (const line of lines) {
  let value;
  try { value = JSON.parse(line); } catch { continue; }
  if (value.message_type === "summary" && /^[a-f0-9]{64}$/i.test(String(value.snapshot_id || ""))) snapshot = String(value.snapshot_id).toLowerCase();
}
if (!snapshot) process.exit(1);
process.stdout.write(snapshot);
NODE
)" || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."
[[ "$snapshot_id" =~ ^[a-f0-9]{64}$ ]] \
  || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."

phase="snapshot-confirmation"
offsite_confirm_uploaded_snapshot \
  || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."

phase="repository-check"
failure_code="REPOSITORY_CHECK_FAILED"
if ! offsite_restic "$uploader_credentials" check >"$operation_root/check.out" 2>"$operation_root/check.error"; then
  offsite_fixed_failure REPOSITORY_CHECK_FAILED "Die Offsite-Repository-Pruefung ist fehlgeschlagen."
fi

retention=(--host "$installation_host" --tag grabenplaner-offsite --path "$OFFSITE_STAGE_CURRENT" \
  --keep-daily "$OFFSITE_RETENTION_DAILY" --keep-weekly "$OFFSITE_RETENTION_WEEKLY" --keep-monthly "$OFFSITE_RETENTION_MONTHLY")
phase="retention-preview"
failure_code="RETENTION_FAILED"
if ! offsite_restic "$uploader_credentials" forget --json --dry-run "${retention[@]}" >"$operation_root/forget-dry.json" 2>"$operation_root/forget-dry.error"; then
  offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
fi
phase="retention-verify"
"$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/offsite-retention-verify.js" \
  "$operation_root/forget-dry.json" "$snapshot_id" "$installation_host" "$OFFSITE_STAGE_CURRENT" >/dev/null 2>&1 \
  || offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
phase="retention"
if ! offsite_restic "$uploader_credentials" forget --prune "${retention[@]}" >"$operation_root/forget.out" 2>"$operation_root/forget.error"; then
  offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
fi
phase="post-check"
failure_code="REPOSITORY_CHECK_FAILED"
if ! offsite_restic "$uploader_credentials" check >"$operation_root/post-check.out" 2>"$operation_root/post-check.error"; then
  offsite_fixed_failure REPOSITORY_CHECK_FAILED "Die Offsite-Repository-Pruefung ist fehlgeschlagen."
fi

phase="status-success"
offsite_status success --snapshot "$snapshot_id" >/dev/null
rm -rf --one-file-system -- "$OFFSITE_STAGE_CURRENT"
offsite_info "Offsite-Sicherung, Repository-Pruefung und Aufbewahrung 14/8/12 wurden bestaetigt."
