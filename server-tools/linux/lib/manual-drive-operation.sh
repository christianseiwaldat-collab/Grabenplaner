#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH
readonly APP=/opt/grabenplaner/app
readonly CONTROL="$APP/server-tools/linux/lib/manual-drive-control.js"
readonly JOBS=/var/lib/grabenplaner-offsite/manual-backups/jobs
readonly COMMON=/opt/grabenplaner-offsite/module/lib/offsite-common.sh
[[ "$EUID" == 0 ]] || exit 1
source "$COMMON"
action="${1:-}"
id="${2:-}"
(( $# <= 2 )) || exit 1
[[ "$action" == list || "$action" == probe || "$action" == work ]] || exit 1
if [[ "$action" == work ]]; then [[ "$id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || exit 1; else [[ -z "$id" ]] || exit 1; fi
offsite_assert_runtime_binaries
offsite_prepare_run_root
# The same lock order as prepare/Assurance. Nonblocking requests report busy;
# accepted workers may wait boundedly if a scheduled task won the intervening race.
if [[ "$action" == work ]]; then
  offsite_acquire_maintenance_lock_with_wait 300
  offsite_acquire_repository_lock
else
  for lock in "$OFFSITE_MAINTENANCE_LOCK" "$OFFSITE_REPOSITORY_LOCK"; do
    [[ -f "$lock" && ! -L "$lock" && "$(stat -c %h "$lock")" == 1 ]] || exit 1
  done
  exec 9<>"$OFFSITE_MAINTENANCE_LOCK"
  flock --nonblock 9 || exit 75
  exec 8<>"$OFFSITE_REPOSITORY_LOCK"
  flock --nonblock 8 || exit 75
fi
if [[ "$action" == probe ]]; then exit 0; fi
credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
temp="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" manual-drive.XXXXXXXX)"
cleanup() {
  local result=$?
  trap - EXIT
  offsite_remove_uploader_credentials "$credentials" >/dev/null 2>&1 || true
  # Only this fixed mktemp directory, never a client-selected object.
  [[ "$temp" == "$OFFSITE_RUN_ROOT/manual-drive."* && -d "$temp" && ! -L "$temp" ]] && rm -rf --one-file-system -- "$temp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
offsite_assert_dedicated_rclone_oauth "$credentials"
offsite_verify_repository_identity "$credentials" "$temp/repository.json" || exit 1
host="$(offsite_installation_host "$credentials")"
list_snapshots() { offsite_restic "$credentials" snapshots --json >"$temp/snapshots.json" 2>"$temp/list.error"; }
if [[ "$action" == list ]]; then
  list_snapshots
  "$OFFSITE_NODE" - "$temp/snapshots.json" "$temp/repository.json" "$host" <<'NODE'
const fs=require('node:fs');const [snapshots,repository,host]=process.argv.slice(2);
process.stdout.write(JSON.stringify({binding:{repositoryId:JSON.parse(fs.readFileSync(repository)).id,host},snapshots:JSON.parse(fs.readFileSync(snapshots))})+'\n');
NODE
  exit 0
fi
readarray -t intent < <("$OFFSITE_NODE" - "$JOBS/$id.json" "$id" "$temp/repository.json" "$host" <<'NODE'
const fs=require('node:fs'),P=require('/opt/grabenplaner/app/lib/manual-drive-backups');const [file,id,repository,host]=process.argv.slice(2),s=fs.lstatSync(file);
if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||(s.mode&0o777)!==0o600||s.size>4096)process.exit(1);
const value=JSON.parse(fs.readFileSync(file));P.operation(value.operation);if(value.operation.requestId!==id||value.operation.state!=='running'||value.binding?.host!==host||value.binding?.repositoryId!==JSON.parse(fs.readFileSync(repository)).id)process.exit(1);
process.stdout.write(value.operation.action+'\n'+(value.operation.snapshotId||'')+'\n');
NODE
)
(( ${#intent[@]} == 2 )) || exit 1
kind="${intent[0]}"
snapshot="${intent[1]}"
if [[ "$kind" == create ]]; then
  # Never re-label an old staging point as a new manual backup.
  [[ ! -e "$OFFSITE_STAGE_CURRENT" && ! -L "$OFFSITE_STAGE_CURRENT" ]] || exit 75
  "$OFFSITE_NODE" "$CONTROL" phase "$id" preparing
  "$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh" --lock-already-held --repository-lock-already-held >"$temp/prepare.out" 2>"$temp/prepare.error"
  "$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$OFFSITE_STAGE_CURRENT" >"$temp/stage-proof.json"
  # Capture/staging and the normal app restart have finished. Match the
  # ordinary prepare→upload boundary; remote transfer needs only the repo lock.
  flock --unlock 9
  exec 9>&-
  "$OFFSITE_NODE" "$CONTROL" phase "$id" uploading
  offsite_restic "$credentials" backup --json --host "$host" --tag grabenplaner-offsite --tag manual-admin-ui --tag "gp-manual-$id" -- "$OFFSITE_STAGE_CURRENT" >"$temp/backup.jsonl" 2>"$temp/backup.error"
  snapshot="$("$OFFSITE_NODE" - "$temp/backup.jsonl" <<'NODE'
const fs=require('node:fs');let id=null;for(const line of fs.readFileSync(process.argv[2],'utf8').trim().split('\n')){const v=JSON.parse(line);if(v.message_type==='summary'&&/^[a-f0-9]{64}$/.test(v.snapshot_id||''))id=v.snapshot_id;}if(!id)process.exit(1);process.stdout.write(id);
NODE
)"
  "$OFFSITE_NODE" "$CONTROL" phase "$id" confirming
  list_snapshots
  "$OFFSITE_NODE" - "$temp/snapshots.json" "$host" "$snapshot" "$id" <<'NODE'
const fs=require('node:fs'),P=require('/opt/grabenplaner/app/lib/manual-drive-backups');const [file,host,id,request]=process.argv.slice(2),all=JSON.parse(fs.readFileSync(file)),selected=all.filter(v=>v.id===id);
if(selected.length!==1||!selected[0].tags?.includes('gp-manual-'+request)||!P.snapshots(selected,host).some(v=>v.snapshotId===id&&v.manual))process.exit(1);
NODE
  # Exact verified stage, only after independent remote confirmation. No
  # restic forget/prune/check/restore/Assurance is part of manual creation.
  "$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$OFFSITE_STAGE_CURRENT" >/dev/null
  rm -rf --one-file-system -- "$OFFSITE_STAGE_CURRENT"
elif [[ "$kind" == delete ]]; then
  [[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] || exit 1
  list_snapshots
  "$OFFSITE_NODE" - "$temp/snapshots.json" "$host" "$snapshot" <<'NODE'
const fs=require('node:fs'),P=require('/opt/grabenplaner/app/lib/manual-drive-backups');const [file,host,id]=process.argv.slice(2),rows=P.snapshots(JSON.parse(fs.readFileSync(file)),host),index=rows.findIndex(v=>v.snapshotId===id);
if(index<1||!rows[index].manual)process.exit(1);
NODE
  "$OFFSITE_NODE" "$CONTROL" phase "$id" deleting
  # Full exact identifier only; never retention selectors, recursive Drive
  # deletion, repository unlock, or prune. Other snapshots stay intact.
  offsite_restic "$credentials" forget "$snapshot" >"$temp/forget.out" 2>"$temp/forget.error"
  cp -- "$temp/snapshots.json" "$temp/before.json"
  list_snapshots
  "$OFFSITE_NODE" - "$temp/before.json" "$temp/snapshots.json" "$snapshot" <<'NODE'
const fs=require('node:fs');const [before,after,id]=process.argv.slice(2),a=JSON.parse(fs.readFileSync(before)),b=JSON.parse(fs.readFileSync(after));
if(b.some(v=>v.id===id)||a.length!==b.length+1||a.filter(v=>v.id!==id).some(v=>!b.some(w=>w.id===v.id)))process.exit(1);
NODE
else exit 1; fi
printf '{"snapshotId":"%s"}\n' "$snapshot"
