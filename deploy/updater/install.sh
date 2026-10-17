#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo ./install.sh [--unattended] [--enable --compose-file /absolute/compose.yml [--replace-registration]]

Installs the optional Docker Compose host updater. With no options, an
interactive terminal is offered an opt-in. Non-interactive installations leave
automatic updates off. --enable with --compose-file is explicit unattended
operator authorization. --replace-registration is required before replacing an
existing registration.
USAGE
}

die() { echo "install.sh: $*" >&2; exit 1; }

if [[ ${EUID} -ne 0 ]]; then die "Run this installer with sudo."; fi

unattended=false
enable=false
replace_registration=false
compose_file=""

while (($#)); do
  case "$1" in
    --unattended) unattended=true ;;
    --enable) enable=true ;;
    --replace-registration) replace_registration=true ;;
    --compose-file)
      (($# >= 2)) || die "--compose-file requires an absolute Compose path."
      compose_file="$2"
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

if [[ "$enable" == true && -z "$compose_file" ]]; then
  die "--enable requires --compose-file /absolute/compose.yml."
fi
if [[ "$enable" != true && -n "$compose_file" ]]; then
  die "--compose-file is only valid with --enable."
fi
if [[ "$replace_registration" == true && "$enable" != true ]]; then
  die "--replace-registration requires --enable and --compose-file."
fi

node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 24 ]]; then die "Node.js 24 or newer is required."; fi
command -v docker >/dev/null || die "Docker with Compose is required."
command -v flock >/dev/null || die "util-linux flock is required."

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_path=/etc/yawf-server-updater/config.json
policy_directory="${policy_path%/*}"
helper=/usr/local/sbin/yawf-server-update

policy_exists() { [[ -e "$policy_path" || -L "$policy_path" ]]; }

assert_existing_policy_safe() {
  [[ ! -L "$policy_directory" && -d "$policy_directory" && -O "$policy_directory" ]] || die "Existing updater policy directory is unsafe."
  local directory_mode
  directory_mode="$(stat -c '%a' "$policy_directory")"
  (( (8#$directory_mode & 8#22) == 0 )) || die "Existing updater policy directory is group or other writable."
  [[ ! -L "$policy_path" && -f "$policy_path" && -O "$policy_path" ]] || die "Existing updater policy file is unsafe."
  local policy_mode
  policy_mode="$(stat -c '%a' "$policy_path")"
  (( (8#$policy_mode & 8#22) == 0 )) || die "Existing updater policy file is group or other writable."
}

install -d -m 0755 /usr/lib/yawf-server-updater /usr/local/sbin
install -m 0755 "$root/yawf-server-update.mjs" /usr/lib/yawf-server-updater/yawf-server-update.mjs
install -m 0755 "$root/yawf-server-update" "$helper"
install -m 0644 "$root/volume-copy.mjs" /usr/lib/yawf-server-updater/volume-copy.mjs
install -m 0644 "$root/yawf-server-update.service" /etc/systemd/system/yawf-server-update.service
install -m 0644 "$root/yawf-server-update.timer" /etc/systemd/system/yawf-server-update.timer
systemctl daemon-reload

if policy_exists; then
  assert_existing_policy_safe
  if [[ "$replace_registration" != true ]]; then
    if [[ "$enable" == true ]]; then
      die "An updater registration already exists. Re-run with --replace-registration to replace it explicitly."
    fi
    echo "Existing updater registration preserved. Its timer and policy were not changed."
    exit 0
  fi
elif [[ "$replace_registration" == true ]]; then
  die "--replace-registration requires an existing safe updater registration."
fi

offer_interactive_opt_in() {
  echo
  echo "Optional unattended stable server updates can register this protected Docker Compose deployment."
  echo "The root-owned helper uses immutable release digests, waits for 03:00-05:00 UTC,"
  echo "defers active playback, and snapshots the stopped named volume and opaque .env for rollback."
  echo "It never runs inside the application container or mounts Docker into the application."
  printf 'Register this deployment and enable automatic updates? [y/N] '
  local answer
  if ! IFS= read -r answer; then
    echo "No answer received. Automatic updates remain off."
    return 0
  fi
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) echo "Automatic updates remain off."; return 0 ;;
  esac
  printf 'Protected absolute Compose file path: '
  if ! IFS= read -r compose_file || [[ -z "$compose_file" ]]; then
    echo "No Compose file path received. Automatic updates remain off."
    return 0
  fi
  printf 'Register this path and enable the timer now? The installer does not directly run an update check or transaction. [y/N] '
  if ! IFS= read -r answer; then
    echo "No confirmation received. Automatic updates remain off."
    return 0
  fi
  case "$answer" in
    y|Y|yes|YES|Yes) enable=true ;;
    *) echo "Automatic updates remain off."; return 0 ;;
  esac
}

if [[ "$enable" != true ]]; then
  if [[ "$unattended" == true ]]; then
    echo "Unattended installation completed. Automatic updates remain off."
    exit 0
  fi
  if [[ -t 0 ]]; then
    offer_interactive_opt_in
  else
    echo "No interactive terminal detected. Automatic updates remain off."
  fi
fi

if [[ "$enable" != true ]]; then
  exit 0
fi

[[ "$compose_file" = /* ]] || die "Compose path must be absolute."
echo "Registering the requested Compose deployment. The installer does not directly run an update check or transaction."
"$helper" register "$compose_file"

if "$helper" enable; then
  echo "Automatic server updates are enabled."
  exit 0
fi

echo "Registration completed, but enabling automatic updates failed." >&2
echo "Attempting the existing updater disable operation so the new registration fails closed." >&2
if "$helper" disable; then
  timer_state="$(systemctl is-enabled yawf-server-update.timer 2>&1 || true)"
  if [[ "$timer_state" == "disabled" ]]; then
    echo "Automatic updates are confirmed disabled." >&2
  else
    echo "Automatic updates could not be confirmed disabled. systemctl reports: ${timer_state:-no state}." >&2
  fi
else
  timer_state="$(systemctl is-enabled yawf-server-update.timer 2>&1 || true)"
  echo "The updater disable operation also failed. systemctl reports: ${timer_state:-no state}." >&2
fi
exit 1
