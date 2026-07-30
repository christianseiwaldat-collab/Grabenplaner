#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly EXPECTED_COMMAND_TARGET="/opt/grabenplaner/app/server-tools/linux/uninstall-grabenplaner-server.sh"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Wartungsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
[[ ! -L "$SCRIPT_SOURCE" || "$SCRIPT_PATH" == "$EXPECTED_COMMAND_TARGET" ]] \
  || { printf '%s\n' "Der Wartungsbefehl zeigt nicht auf die erwartete Grabenplaner-Installation." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

app_arg="$GP_DEFAULT_APP_DIR"
service="$GP_DEFAULT_SERVICE"
bootstrap_service="grabenplaner-bootstrap.service"
monitor_service="grabenplaner-monitor.service"
monitor_timer="grabenplaner-monitor.timer"
host_control_socket="grabenplaner-host-control.socket"
host_control_worker="grabenplaner-host-control@.service"
host_reboot_service="grabenplaner-host-reboot.service"
host_control_group="grabenplaner-host-control"
host_control_root="/opt/grabenplaner-host-control"
caddy_config="/etc/caddy/Caddyfile"
confirmed=0

while (($#)); do
  case "$1" in
    --app-dir) app_arg="${2:?Wert fuer --app-dir fehlt}"; shift 2 ;;
    --service) service="${2:?Wert fuer --service fehlt}"; shift 2 ;;
    --bootstrap-service) bootstrap_service="${2:?Wert fehlt}"; shift 2 ;;
    --caddy-config) caddy_config="${2:?Wert fuer --caddy-config fehlt}"; shift 2 ;;
    --yes) confirmed=1; shift ;;
    -h|--help)
      cat <<'EOF'
Verwendung: sudo ./uninstall-grabenplaner-server.sh --yes [Optionen]

Entfernt App-Code, Grabenplaner-systemd-Units, den root-geschuetzten
Host-Control-Broker und die eigenen Befehlslinks.
Datenbank, Dokumente, geheime Konfiguration, Logs, Backups und der bisherige
Monitorstatus bleiben immer erhalten. Caddy selbst wird niemals deinstalliert.
EOF
      exit 0
      ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
(( confirmed == 1 )) || gp_die "Die Deinstallation erfordert die ausdrueckliche Option --yes."
gp_require_command systemctl
for command_name in awk find getent gpasswd groupdel rmdir stat; do gp_require_command "$command_name"; done

# Das optionale Offsite-Modul besitzt eigene Secrets, Binaries und einen
# Stagingbereich. Seine Entfernung muss bewusst ueber den eigenen, strikt
# getrennten Uninstaller erfolgen; der Core-Uninstaller darf diese Daten nie
# implizit entfernen oder unbrauchbar zuruecklassen.
offsite_configured=0
if [[ -f /etc/grabenplaner/grabenplaner.env && ! -L /etc/grabenplaner/grabenplaner.env ]] \
  && grep -Fqx 'GRABENPLANER_OFFSITE_CONFIGURED=1' /etc/grabenplaner/grabenplaner.env; then
  offsite_configured=1
fi
if (( offsite_configured == 1 )) || gp_systemd_unit_exists grabenplaner-offsite-upload.service \
  || gp_systemd_unit_exists grabenplaner-offsite-check.service \
  || gp_systemd_unit_exists grabenplaner-offsite-restore-test.service; then
  gp_die "Das optionale Offsite-Modul ist noch eingerichtet. Bitte zuerst sudo /usr/local/sbin/grabenplaner-offsite-uninstall --yes ausfuehren."
fi
gp_acquire_maintenance_lock
app_dir="$(gp_safe_absolute_path "$app_arg" "App-Ordner")"
[[ "$(basename -- "$app_dir")" == "app" && "$(basename -- "$(dirname -- "$app_dir")")" == "grabenplaner" ]] \
  || gp_die "Sicherheitsabbruch: Der App-Ordner muss auf .../grabenplaner/app enden."

if gp_systemd_unit_exists "$host_control_socket"; then
  systemctl disable --now "$host_control_socket" 2>/dev/null || true
fi
systemctl stop 'grabenplaner-host-control@*.service' "$host_reboot_service" 2>/dev/null || true
for unit in "$host_control_socket" "$host_control_worker" "$host_reboot_service" \
  "$monitor_timer" "$monitor_service" "$service" "$bootstrap_service"; do
  if gp_systemd_unit_exists "$unit"; then
    systemctl stop "$unit" 2>/dev/null || true
    systemctl disable "$unit" 2>/dev/null || true
  fi
  unit_file="/etc/systemd/system/$unit"
  if [[ -e "$unit_file" || -L "$unit_file" ]]; then
    [[ "$(dirname -- "$unit_file")" == "/etc/systemd/system" ]] || gp_die "Unerwarteter Unit-Pfad: $unit_file"
    rm -f -- "$unit_file"
  fi
done
systemctl daemon-reload
systemctl reset-failed "$host_control_socket" 'grabenplaner-host-control@*.service' "$host_reboot_service" \
  "$monitor_timer" "$monitor_service" "$service" "$bootstrap_service" 2>/dev/null || true

host_control_module="$host_control_root/module"
if [[ -e "$host_control_root" || -L "$host_control_root" ]]; then
  [[ -d "$host_control_root" && ! -L "$host_control_root" \
    && "$(stat --format='%u:%g' -- "$host_control_root")" == "0:0" ]] \
    || gp_die "Der Host-Control-Installationspfad ist veraendert und wird nicht automatisch entfernt."
  if [[ -e "$host_control_module" || -L "$host_control_module" ]]; then
    [[ -d "$host_control_module" && ! -L "$host_control_module" \
      && -z "$(find "$host_control_module" -xdev \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)" \
      && -z "$(find "$host_control_module" -xdev ! -type f ! -type d -print -quit)" ]] \
      || gp_die "Das Host-Control-Modul ist veraendert und wird nicht automatisch entfernt."
    rm -rf --one-file-system -- "$host_control_module"
  fi
  rmdir -- "$host_control_root" 2>/dev/null \
    || gp_warn "Der nicht leere Host-Control-Ordner bleibt zur manuellen Pruefung erhalten: $host_control_root"
fi
if getent group "$host_control_group" >/dev/null 2>&1; then
  host_control_members="$(getent group "$host_control_group" | awk -F: 'NR == 1 { print $4 }')"
  if tr ',' '\n' <<<"$host_control_members" | grep -Fxq "$GP_DEFAULT_SERVICE_USER"; then
    gpasswd --delete "$GP_DEFAULT_SERVICE_USER" "$host_control_group" >/dev/null
    host_control_members="$(getent group "$host_control_group" | awk -F: 'NR == 1 { print $4 }')"
  fi
  host_control_gid="$(getent group "$host_control_group" | awk -F: 'NR == 1 { print $3 }')"
  host_control_primary_members="$(getent passwd | awk -F: -v gid="$host_control_gid" '$4 == gid { print $1 }')"
  if [[ -z "$host_control_members" && -z "$host_control_primary_members" ]]; then
    groupdel "$host_control_group"
  else
    gp_warn "Die Host-Control-Gruppe besitzt unerwartete Mitglieder und bleibt zur manuellen Pruefung erhalten."
  fi
fi

bootstrap_command="/usr/local/sbin/grabenplaner-bootstrap-admin"
if [[ -f "$bootstrap_command" && ! -L "$bootstrap_command" ]] \
  && grep -Fqx 'readonly APP_SERVICE="grabenplaner.service"' "$bootstrap_command" \
  && grep -Fqx 'readonly DATABASE_PATH="/var/lib/grabenplaner/data/dienstplan.db"' "$bootstrap_command"; then
  rm -f -- "$bootstrap_command"
elif [[ -e "$bootstrap_command" || -L "$bootstrap_command" ]]; then
  gp_warn "Veraenderter Bootstrap-Befehl bleibt unangetastet: $bootstrap_command"
fi

declare -A command_targets=(
  [grabenplaner-backup]="$app_dir/server-tools/linux/backup-grabenplaner.sh"
  [grabenplaner-monitor]="$app_dir/server-tools/linux/monitor/run-grabenplaner-monitor.sh"
  [grabenplaner-stop]="$app_dir/server-tools/linux/stop-grabenplaner-server.sh"
  [grabenplaner-test]="$app_dir/server-tools/linux/test-grabenplaner-server.sh"
  [grabenplaner-update]="$app_dir/server-tools/linux/update-grabenplaner-server.sh"
  [grabenplaner-uninstall]="$app_dir/server-tools/linux/uninstall-grabenplaner-server.sh"
)
for command_name in "${!command_targets[@]}"; do
  command_path="/usr/local/sbin/$command_name"
  if [[ -L "$command_path" && "$(readlink -- "$command_path")" == "${command_targets[$command_name]}" ]]; then
    rm -f -- "$command_path"
  elif [[ -e "$command_path" || -L "$command_path" ]]; then
    gp_warn "Fremder oder veraenderter Befehlslink bleibt unangetastet: $command_path"
  fi
done

if [[ -n "$caddy_config" ]]; then
  caddy_config="$(gp_safe_absolute_path "$caddy_config" "Caddy-Konfiguration")"
  gp_path_is_same_or_child "$caddy_config" "/etc/caddy" || gp_die "Die Caddy-Konfiguration muss unter /etc/caddy liegen."
  if [[ -f "$caddy_config" && ! -L "$caddy_config" ]] && [[ "$(head --lines 1 -- "$caddy_config")" == "# Managed by Grabenplaner." ]]; then
    caddy_backup_dir="/etc/grabenplaner/caddy-backup"
    latest_caddy_backup=""
    if [[ -d "$caddy_backup_dir" && ! -L "$caddy_backup_dir" ]]; then
      latest_caddy_backup="$(find "$caddy_backup_dir" -maxdepth 1 -type f -name 'Caddyfile.pre-grabenplaner.*' -printf '%T@ %p\n' \
        | sort --numeric-sort --reverse | head --lines 1 | cut --delimiter=' ' --fields=2-)"
    fi
    if [[ -n "$latest_caddy_backup" && -f "$latest_caddy_backup" && ! -L "$latest_caddy_backup" ]]; then
      gp_path_is_same_or_child "$latest_caddy_backup" "$caddy_backup_dir" || gp_die "Das Caddy-Backup verlaesst den geschuetzten Backupordner."
      restored_caddy="/etc/caddy/.Caddyfile.grabenplaner-restore.$$"
      cp --preserve=mode,ownership,timestamps -- "$latest_caddy_backup" "$restored_caddy"
      if command -v caddy >/dev/null 2>&1 && caddy validate --config "$restored_caddy" --adapter caddyfile >/dev/null 2>&1; then
        mv -f -- "$restored_caddy" "$caddy_config"
        if gp_systemd_unit_exists "$GP_DEFAULT_CADDY_SERVICE"; then
          systemctl enable "$GP_DEFAULT_CADDY_SERVICE" >/dev/null 2>&1 || true
          systemctl reload-or-restart "$GP_DEFAULT_CADDY_SERVICE"
        fi
        gp_info "Die vor Grabenplaner vorhandene Caddy-Konfiguration wurde wiederhergestellt; ihr Backup bleibt erhalten."
      else
        rm -f -- "$restored_caddy"
        gp_warn "Das fruehere Caddyfile ist nicht validierbar; die aktive Konfiguration bleibt zur Sicherheit unveraendert."
      fi
    else
      if gp_systemd_unit_exists "$GP_DEFAULT_CADDY_SERVICE"; then
        systemctl stop "$GP_DEFAULT_CADDY_SERVICE" 2>/dev/null || true
        systemctl disable "$GP_DEFAULT_CADDY_SERVICE" 2>/dev/null || true
      fi
      rm -f -- "$caddy_config"
      gp_warn "Kein frueheres Caddyfile vorhanden: Caddy wurde sicher beendet, die Grabenplaner-Konfiguration entfernt."
    fi
  elif [[ -e "$caddy_config" || -L "$caddy_config" ]]; then
    gp_warn "Caddyfile ohne exakten Grabenplaner-Marker bleibt unangetastet: $caddy_config"
  fi
fi

if [[ -d "$app_dir" && ! -L "$app_dir" ]]; then rm -rf -- "$app_dir"; fi
gp_info "Grabenplaner-App und Dienste wurden entfernt. Daten, Schluessel, Logs, Backups und Monitorstatus bleiben erhalten."
