#!/usr/bin/env bash
# One offsite round trip and one isolated application restore of a sealed Core Plus point.
set -euo pipefail
umask 077
mode=${4:-}
[[ $# == 3 || ( $# == 4 && ( $mode == --lock-already-held || $mode == --receipt-only ) ) ]] || exit 2
bundle=$1
source_app=$2
target_app=$3
helper="$(dirname "$(realpath -- "$0")")/lib/core-drive-proof.js"
source /opt/grabenplaner-offsite/module/lib/offsite-common.sh
offsite_require_root
offsite_assert_installed_contract
[[ "$("$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/offsite-contract.js" provider-id "$OFFSITE_INSTALLED_CONTRACT")" == google_drive ]] ||
  offsite_die 'Das gebundene Ziel ist kein Google Drive.'
if [[ "$mode" == --lock-already-held ]]; then
  offsite_assert_inherited_lock "$OFFSITE_MAINTENANCE_LOCK" 9 Wartung
else
  [[ -f "$OFFSITE_MAINTENANCE_LOCK" && ! -L "$OFFSITE_MAINTENANCE_LOCK" && "$(stat -c %u:%g:%a:%h "$OFFSITE_MAINTENANCE_LOCK")" == 0:0:600:1 ]] ||
    offsite_die 'Wartungssperre fehlt oder ist ungueltig.'
  exec 9<>"$OFFSITE_MAINTENANCE_LOCK"
  flock 9
fi
work="$(mktemp -d -- "$OFFSITE_STATE_ROOT/core-drive.XXXXXXXX")"
credentials=''
cleanup() {
  if [[ -n "$credentials" ]]; then offsite_remove_uploader_credentials "$credentials"; fi
  rm -rf --one-file-system -- "$work"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
offsite_info 'Core Plus: pruefe den versiegelten Sicherungspunkt.'
"$OFFSITE_NODE" "$helper" prepare "$source_app" "$target_app" "$bundle" >"$work/context.json"
manifest="$("$OFFSITE_NODE" -p 'require(process.argv[1]).manifestSha256' "$work/context.json")"
[[ "$manifest" =~ ^[a-f0-9]{64}$ ]]
name="$(basename -- "$bundle")"
open_repository() {
  offsite_acquire_repository_lock
  credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
  offsite_verify_repository_identity "$credentials" "$work/repository.json" || offsite_die 'Die Drive-Repositorykennung stimmt nicht.'
  host="$(offsite_installation_host "$credentials")"
}
publish_receipt() {
  local file="$work/receipt.json" receipt_hash remote_id
  receipt_hash="$(sha256sum "$file" | cut -d' ' -f1)"
  select_receipt() {
    offsite_restic "$credentials" snapshots --json --host "$host" --tag "grabenplaner-core-plus-receipt,receipt-$receipt_hash" >"$work/receipts.json" || return 1
    "$OFFSITE_NODE" "$helper" select-receipt "$source_app" "$host" "$receipt_hash" "$work/receipts.json"
  }
  remote_id="$(select_receipt)"
  if [[ -z "$remote_id" ]]; then
    offsite_restic "$credentials" backup --json --host "$host" --tag grabenplaner-core-plus-receipt --tag "receipt-$receipt_hash" \
      --tag "for-$snapshot" --stdin --stdin-filename core-plus-receipt.json <"$file" >"$work/receipt-upload.jsonl"
    remote_id="$(select_receipt)"
  fi
  [[ "$remote_id" =~ ^[a-f0-9]{64}$ ]] || offsite_die 'Der signierte Drive-Beleg ist nicht eindeutig auffindbar.'
  offsite_restic "$credentials" dump "$remote_id" /core-plus-receipt.json >"$work/downloaded-receipt.json"
  cmp --silent -- "$file" "$work/downloaded-receipt.json" || offsite_die 'Der signierte Beleg auf Drive weicht ab.'
  "$OFFSITE_NODE" "$helper" publish "$source_app" "$target_app" "$bundle" "$work" >/dev/null
  offsite_info "Signierter Beleg auf Drive bestaetigt: $remote_id"
}
open_repository
select_snapshot() {
  offsite_restic "$credentials" snapshots --json --host "$host" --tag "grabenplaner-core-plus,core-$manifest" >"$work/list.json" || return 1
  "$OFFSITE_NODE" "$helper" select "$source_app" "$host" "$manifest" "$work/list.json"
}
snapshot="$(select_snapshot)"
if [[ -n "$snapshot" ]]; then
  printf '%s\n' "$snapshot" >"$work/snapshot"
  if "$OFFSITE_NODE" "$helper" reusable "$source_app" "$target_app" "$bundle" "$work" 2>/dev/null; then
    publish_receipt
    offsite_info 'Der signierte Drive-Restore passt bereits zu diesem Punkt und Zielpaket.'
    exit 0
  fi
fi
[[ "$mode" != --receipt-only ]] || offsite_die 'Fuer diesen Punkt und dieses Zielpaket liegt kein signierter Drive-Restore vor.'
# Archive only the verified sealed point and its commit marker.
"$OFFSITE_NODE" "$helper" verify-files "$source_app" "$target_app" "$bundle" "$work"
tar -C "$(dirname -- "$bundle")" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
  -cf "$work/local.tar" -- "$name" "$name.complete.json"
sha256sum "$work/local.tar" | cut -d' ' -f1 >"$work/archive.sha256"
if [[ -z "$snapshot" ]]; then
  offsite_info 'Core Plus: lade den Punkt verschluesselt zu Google Drive hoch.'
  offsite_restic "$credentials" backup --json --host "$host" --tag grabenplaner-core-plus --tag "core-$manifest" \
    --stdin --stdin-filename core-plus.tar <"$work/local.tar" >"$work/upload.jsonl"
  snapshot="$(select_snapshot)"
fi
[[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] || offsite_die 'Kein eindeutiger Core-Plus-Snapshot auf Drive.'
printf '%s\n' "$snapshot" >"$work/snapshot"
rm -- "$work/local.tar"
offsite_info "Core Plus: lade Drive-Snapshot $snapshot zurueck."
offsite_restic "$credentials" dump "$snapshot" /core-plus.tar >"$work/drive.tar"
[[ "$(sha256sum "$work/drive.tar" | cut -d' ' -f1)" == "$(cat "$work/archive.sha256")" ]] ||
  offsite_die 'Die von Drive geladenen Archivbytes stimmen nicht mit dem versiegelten Punkt ueberein.'
offsite_remove_uploader_credentials "$credentials"
credentials=''
exec 8>&-
mkdir -- "$work/download"
tar -C "$work/download" --no-same-owner -xf "$work/drive.tar"
rm -- "$work/drive.tar"
[[ "$(sha256sum "$work/download/$name/manifest.json" | cut -d' ' -f1)" == "$manifest" ]]
offsite_info 'Core Plus: starte die isolierte PostgreSQL-Wiederherstellung aus dem Download.'
"$OFFSITE_NODE" "$target_app/server-tools/linux/lib/deploy-owned-recovery.js" \
  "$work/download/$name" "$work/download/$name.complete.json" "$source_app" "$target_app" >"$work/restore.json"
"$OFFSITE_NODE" "$helper" seal "$source_app" "$target_app" "$bundle" "$work"
open_repository
publish_receipt
offsite_info 'Core Plus: eigenstaendigen Drive-Nachweis signiert und erneut eingelesen.'
