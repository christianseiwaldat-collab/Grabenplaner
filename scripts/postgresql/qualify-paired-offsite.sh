#!/usr/bin/env bash
# One-time additive qualification against the already bound offsite repository.
# No retention, no production service stop, and no productive status overwrite.
set -Eeuo pipefail
umask 077
base=/home/gpadmin/grabenplaner-pg-migration-20260912
recovery="$base/recovery-10"
root=/var/lib/grabenplaner-offsite/postgresql-qualification-20260912
source /opt/grabenplaner-offsite/module/lib/offsite-common.sh
offsite_require_root
[[ "$(realpath "$base")" == "$base" && "$(cat "$base/ownership-marker")" == grabenplaner-postgresql-migration-development-v1 ]]
[[ "$(realpath "$recovery")" == "$recovery" && "$(cat "$recovery/ownership-marker")" == grabenplaner-paired-recovery-10-v1 ]]
[[ ! -e "$root" && ! -L "$root" ]]
offsite_assert_runtime_binaries
(( $(df --output=avail -B1 "$recovery" | tail -n 1) > 12884901888 ))
install -d -m 0750 -o root -g "$OFFSITE_GROUP" "$root" "$root/stage" "$root/stage/backup"
printf '%s\n' grabenplaner-postgresql-offsite-qualification-v1 >"$root/ownership-marker"
chmod 0600 "$root/ownership-marker"
cp -a --no-preserve=ownership -- "$recovery/postgresql-block10.pair" "$recovery/postgresql-block10.pair.complete.json" "$root/stage/backup/"
install -m 0600 -- "$recovery/offsite-result.json" "$root/backup-result.json"
install -m 0600 -- "$base/qualification/server-tools/linux/offsite/lib/offsite-stage.js" "$root/stage-helper.js"
find "$root/stage" -xdev -type d -exec chown "root:$OFFSITE_GROUP" {} + -exec chmod 0750 {} +
find "$root/stage" -xdev -type f -exec chown "root:$OFFSITE_GROUP" {} + -exec chmod 0440 {} +
"$OFFSITE_NODE" "$root/stage-helper.js" create "$root/stage" "$root/backup-result.json" >"$root/stage-created.json"
chown "root:$OFFSITE_GROUP" "$root/stage/offsite-stage-manifest.json"
chmod 0440 "$root/stage/offsite-stage-manifest.json"
"$OFFSITE_NODE" "$root/stage-helper.js" verify-result "$root/stage" "$root/backup-result.json" >"$root/stage-verified.json"
credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
trap 'offsite_remove_uploader_credentials "$credentials"' EXIT
offsite_acquire_repository_lock
offsite_verify_repository_identity "$credentials" "$root/repository-identity.json"
installation_host="$(offsite_installation_host "$credentials")"
offsite_assurance_history inspect >"$root/existing-assurance.json"
offsite_restic "$credentials" backup --json --host "$installation_host" --tag postgresql-migration-qualification --tag paired-block10 -- "$root/stage" >"$root/upload.jsonl" 2>"$root/upload.error"
snapshot_id="$("$OFFSITE_NODE" - "$root/upload.jsonl" <<'NODE'
const fs=require('node:fs');const rows=fs.readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));const summary=rows.filter(r=>r.message_type==='summary');if(summary.length!==1||!/^[a-f0-9]{8,64}$/.test(summary[0].snapshot_id))throw new Error('Snapshot receipt missing');process.stdout.write(summary[0].snapshot_id);
NODE
)"
offsite_restic "$credentials" snapshots --json "$snapshot_id" >"$root/snapshots.json" 2>"$root/snapshots.error"
"$OFFSITE_NODE" - "$root/snapshots.json" "$root/stage" "$installation_host" <<'NODE'
const fs=require('node:fs'),[file,stage,host]=process.argv.slice(2),rows=JSON.parse(fs.readFileSync(file,'utf8'));if(rows.length!==1||rows[0].hostname!==host||JSON.stringify(rows[0].paths)!==JSON.stringify([stage])||!rows[0].tags.includes('paired-block10')||rows[0].tags.includes('grabenplaner-offsite'))throw new Error('Unexpected offsite scope');
NODE
install -d -m 0700 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" "$root/restored"
offsite_restic "$credentials" restore "$snapshot_id" --target "$root/restored" --verify >"$root/restore.out" 2>"$root/restore.error"
restored="$root/restored$root/stage"
[[ "$(realpath "$restored")" == "$restored" ]]
"$OFFSITE_NODE" "$root/stage-helper.js" verify "$restored" >"$root/restored-verified.json"
"$OFFSITE_NODE" - "$root" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),root=process.argv[2];
const snapshot=JSON.parse(fs.readFileSync(root+'/snapshots.json','utf8'))[0];
const result=JSON.parse(fs.readFileSync(root+'/restored-verified.json','utf8'));
const history=JSON.parse(fs.readFileSync(root+'/existing-assurance.json','utf8'));
const terminal=history.events.filter(e=>['full-assurance-passed','full-assurance-failed'].includes(e.payload.eventType)).slice(-3).map(e=>e.payload);
const receipt={checkedAt:new Date().toISOString(),offsiteRoundTrip:true,snapshotId:snapshot.id,manifestSha256:result.manifestSha256,retentionChanged:false,productionStatusChanged:false,previousAssurance:{verified:history.ok,lastTerminalEvents:terminal},productActivation:false};
fs.writeFileSync(root+'/return-receipt.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(receipt));
NODE
[[ ! -e "$recovery/offsite-return" ]]
install -d -m 0700 -o gpadmin -g gpadmin "$recovery/offsite-return"
cp -a --no-preserve=ownership -- "$restored/backup/postgresql-block10.pair" "$restored/backup/postgresql-block10.pair.complete.json" "$root/return-receipt.json" "$recovery/offsite-return/"
find "$recovery/offsite-return" -xdev -type d -exec chown gpadmin:gpadmin {} + -exec chmod 0700 {} +
find "$recovery/offsite-return" -xdev -type f -exec chown gpadmin:gpadmin {} + -exec chmod 0600 {} +
