#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo ./install.sh [--node-runtime /absolute/node] [--unattended] [--enable --compose-file /absolute/compose.yml [--replace-registration]]

Installs the optional Docker Compose host updater. With no options, an
interactive terminal is offered an opt-in. Non-interactive installations leave
automatic updates off. --enable with --compose-file is explicit unattended
operator authorization. --replace-registration is required before replacing an
existing registration.

--node-runtime installs a validated root-owned Node.js 24 or newer executable
into the updater's private runtime. It never replaces the system Node.js.
USAGE
}

die() { echo "install.sh: $*" >&2; exit 1; }

if [[ ${EUID} -ne 0 ]]; then die "Run this installer with sudo."; fi

unattended=false
enable=false
replace_registration=false
compose_file=""
node_runtime=""

while (($#)); do
  case "$1" in
    --unattended) unattended=true ;;
    --enable) enable=true ;;
    --replace-registration) replace_registration=true ;;
    --node-runtime)
      (($# >= 2)) || die "--node-runtime requires an absolute executable path."
      node_runtime="$2"
      shift
      ;;
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

runtime_directory=/usr/lib/yawf-server-updater/runtime
private_node="$runtime_directory/node"

assert_secure_ancestor_chain() {
  local path="$1" current
  current="$(dirname "$path")"
  while :; do
    [[ ! -L "$current" && -d "$current" ]] || die "Node runtime ancestor is unsafe: $current"
    [[ "$(stat -c '%u' "$current")" == 0 ]] || die "Node runtime ancestor is not root-owned: $current"
    local mode
    mode="$(stat -c '%a' "$current")"
    (( (8#$mode & 8#22) == 0 )) || die "Node runtime ancestor is group or other writable: $current"
    [[ "$current" == / ]] && break
    current="$(dirname "$current")"
  done
}

assert_secure_node_file() {
  local path="$1" require_canonical="$2" canonical mode
  [[ "$path" = /* ]] || die "Node runtime path must be absolute."
  canonical="$(readlink -f -- "$path" 2>/dev/null)" || die "Node runtime path cannot be resolved."
  if [[ "$require_canonical" == true ]]; then
    [[ "$canonical" == "$path" ]] || die "Node runtime path must be canonical and contain no symlinks."
  fi
  [[ ! -L "$canonical" && -f "$canonical" && -x "$canonical" ]] || die "Node runtime must be a regular executable file."
  [[ "$(stat -c '%u' "$canonical")" == 0 ]] || die "Node runtime must be root-owned."
  mode="$(stat -c '%a' "$canonical")"
  (( (8#$mode & 8#22) == 0 )) || die "Node runtime must not be group or other writable."
  assert_secure_ancestor_chain "$canonical"
  printf '%s\n' "$canonical"
}

probe_node_24() {
  local path="$1" major
  major="$("$path" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || die "Node runtime probe failed."
  [[ "$major" =~ ^[0-9]+$ ]] || die "Node runtime returned an invalid version."
  (( major >= 24 )) || die "Node.js 24 or newer is required."
}

ensure_secure_directory() {
  local path="$1" mode
  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" && -d "$path" ]] || die "Private Node runtime directory is unsafe: $path"
    [[ "$(stat -c '%u' "$path")" == 0 ]] || die "Private Node runtime directory is not root-owned: $path"
    mode="$(stat -c '%a' "$path")"
    (( (8#$mode & 8#22) == 0 )) || die "Private Node runtime directory is group or other writable: $path"
  else
    install -d -o root -g root -m 0755 "$path"
  fi
}

runtime_source=""
reuse_private=false
install_private=false
if [[ -n "$node_runtime" ]]; then
  runtime_source="$(assert_secure_node_file "$node_runtime" true)"
  probe_node_24 "$runtime_source"
  install_private=true
elif [[ -e "$private_node" || -L "$private_node" ]]; then
  assert_secure_node_file "$private_node" true >/dev/null
  probe_node_24 "$private_node"
  reuse_private=true
else
  # The distro-owned system entry may normally be a symlink. Validate its
  # resolved executable and ancestors without rejecting that entry-point link.
  system_node="$(assert_secure_node_file /usr/bin/node false)"
  probe_node_24 "$system_node"
fi
command -v docker >/dev/null || die "Docker with Compose is required."
command -v flock >/dev/null || die "util-linux flock is required."

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_path=/etc/yawf-server-updater/config.json
policy_directory="${policy_path%/*}"
helper=/usr/local/sbin/yawf-server-update

if [[ "$reuse_private" == true ]]; then
  echo "Private Node runtime reused: destination=$private_node sha256=$(sha256sum "$private_node" | awk '{print $1}')"
elif [[ "$install_private" == true ]]; then
  assert_secure_ancestor_chain /usr/lib/yawf-server-updater
  ensure_secure_directory /usr/lib/yawf-server-updater
  assert_secure_ancestor_chain "$runtime_directory"
  ensure_secure_directory "$runtime_directory"
  assert_secure_ancestor_chain "$private_node"
  runtime_temp="$(mktemp "$runtime_directory/.node.install.XXXXXX")"
  cleanup_runtime_temp() { rm -f -- "${runtime_temp:-}"; }
  trap cleanup_runtime_temp EXIT
  source_hash_before="$(sha256sum "$runtime_source" | awk '{print $1}')"
  install -o root -g root -m 0755 "$runtime_source" "$runtime_temp"
  source_hash_after="$(sha256sum "$runtime_source" | awk '{print $1}')"
  temp_hash="$(sha256sum "$runtime_temp" | awk '{print $1}')"
  [[ "$source_hash_before" == "$source_hash_after" && "$source_hash_before" == "$temp_hash" ]] || die "Node runtime changed while it was being installed."
  probe_node_24 "$runtime_temp"
  mv -fT -- "$runtime_temp" "$private_node"
  runtime_temp=""
  trap - EXIT
  assert_secure_node_file "$private_node" true >/dev/null
  probe_node_24 "$private_node"
  destination_hash="$(sha256sum "$private_node" | awk '{print $1}')"
  [[ "$destination_hash" == "$source_hash_before" ]] || die "Installed private Node runtime hash mismatch."
  echo "Private Node runtime installed: source-sha256=$source_hash_before source-after-sha256=$source_hash_after destination=$private_node destination-sha256=$destination_hash"
else
  echo "System Node runtime validated: /usr/bin/node"
fi

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
