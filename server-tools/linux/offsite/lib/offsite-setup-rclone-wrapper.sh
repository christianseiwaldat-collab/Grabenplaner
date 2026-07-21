#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

setup_root="${GRABENPLANER_OFFSITE_SETUP_ROOT:-}"
credentials="${CREDENTIALS_DIRECTORY:-}"
[[ "$setup_root" == /run/grabenplaner-offsite/setup.* && -d "$setup_root" && ! -L "$setup_root" ]] || exit 1
[[ "$credentials" == /run/grabenplaner-offsite/credentials.* && -d "$credentials" && ! -L "$credentials" ]] || exit 1
[[ "$(stat --format='%u:%G:%a' -- "$setup_root")" == "0:grabenplaner-offsite:750" ]] || exit 1
config_root="$setup_root/config"
[[ -d "$config_root" && ! -L "$config_root" \
  && "$(stat --format='%U:%G:%a' -- "$config_root")" == "grabenplaner-offsite:grabenplaner-offsite:700" ]] || exit 1
for target in "$setup_root/rclone" "$config_root/rclone.conf" "$setup_root/read-secret" "$credentials/rclone-config-password"; do
  [[ -f "$target" && ! -L "$target" ]] || exit 1
done
[[ "$(stat --format='%u:%g:%a:%h' -- "$setup_root/rclone")" == "0:0:755:1" ]] || exit 1
[[ "$(stat --format='%U:%G:%a:%h' -- "$config_root/rclone.conf")" == "grabenplaner-offsite:grabenplaner-offsite:600:1" ]] || exit 1
[[ "$(stat --format='%u:%g:%a:%h' -- "$setup_root/read-secret")" == "0:0:755:1" ]] || exit 1
[[ "$(stat --format='%u:%G:%a:%h' -- "$credentials/rclone-config-password")" == "0:grabenplaner-offsite:440:1" ]] || exit 1
exec "$setup_root/rclone" \
  --config "$config_root/rclone.conf" \
  --password-command "$setup_root/read-secret $credentials/rclone-config-password" \
  --ask-password=false \
  "$@"
