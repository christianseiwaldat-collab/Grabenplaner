#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

credentials="${CREDENTIALS_DIRECTORY:-}"
target="${1:-}"
[[ -n "$credentials" && "$credentials" == /* && -d "$credentials" && ! -L "$credentials" ]] || exit 1
[[ "$target" == "$credentials/rclone-config-password" ]] || exit 1
[[ -f "$target" && ! -L "$target" ]] || exit 1
size="$(stat --format='%s' -- "$target")"
[[ "$size" =~ ^[0-9]+$ ]] && (( size >= 16 && size <= 1024 )) || exit 1
secret=""
IFS= read -r secret <"$target" || [[ -n "$secret" ]] || exit 1
[[ -n "$secret" && "$secret" != *$'\r'* && "$secret" != *$'\n'* ]] || exit 1
printf '%s\n' "$secret"
