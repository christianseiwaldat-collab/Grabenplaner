#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly RCLONE="/opt/grabenplaner-offsite/bin/rclone"
readonly PASSWORD_READER="/opt/grabenplaner-offsite/module/grabenplaner-offsite-read-secret.sh"
readonly RCLONE_CONFIG="/var/lib/grabenplaner-offsite/credentials/rclone.conf"
credentials="${CREDENTIALS_DIRECTORY:-}"
[[ -n "$credentials" && "$credentials" == /* && -d "$credentials" && ! -L "$credentials" ]] || exit 1
[[ -f "$credentials/rclone-config-password" && ! -L "$credentials/rclone-config-password" ]] || exit 1
[[ -f "$RCLONE_CONFIG" && ! -L "$RCLONE_CONFIG" ]] || exit 1
[[ "$(stat --format='%U:%G:%a:%h' -- "$RCLONE_CONFIG")" == "grabenplaner-offsite:grabenplaner-offsite:600:1" ]] || exit 1
[[ -f "$RCLONE" && ! -L "$RCLONE" && "$(stat --format='%u:%g:%h' -- "$RCLONE")" == "0:0:1" ]] || exit 1
[[ -f "$PASSWORD_READER" && ! -L "$PASSWORD_READER" && "$(stat --format='%u:%g:%h' -- "$PASSWORD_READER")" == "0:0:1" ]] || exit 1
for executable in "$RCLONE" "$PASSWORD_READER"; do
  mode="$(stat --format='%a' -- "$executable")"
  (( (8#$mode & 022) == 0 && (8#$mode & 0111) != 0 )) || exit 1
done
exec "$RCLONE" \
  --config "$RCLONE_CONFIG" \
  --password-command "$PASSWORD_READER $credentials/rclone-config-password" \
  --ask-password=false \
  "$@"
