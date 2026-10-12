#!/usr/bin/env bash
# Executes exact installer bytes only on an explicitly authorized disposable
# GitHub-hosted Ubuntu runner. It never targets a user deployment.
set -euo pipefail

die() { printf 'installer runtime test: %s\n' "$*" >&2; exit 1; }

require_disposable_github_runner() {
  [[ "${YAWF_INSTALLER_RUNTIME_DISPOSABLE:-}" == "1" ]] || die "explicit disposable-runner authorization is required"
  [[ "${GITHUB_ACTIONS:-}" == "true" ]] || die "GitHub Actions is required"
  [[ "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] || die "a GitHub-hosted runner is required"
  [[ "${RUNNER_OS:-}" == "Linux" ]] || die "a Linux runner is required"
  [[ -r /etc/os-release ]] || die "Ubuntu release metadata is required"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "an Ubuntu runner is required"
}

require_disposable_github_runner
[[ ${EUID} -eq 0 ]] || die "runtime installer test must run as root"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo/deploy/updater/install.sh"
policy_directory=/etc/yawf-server-updater
policy_path="$policy_directory/config.json"
state_root=/var/lib/yawf-server-updater
install_directory=/usr/lib/yawf-server-updater
helper=/usr/local/sbin/yawf-server-update
service_unit=/etc/systemd/system/yawf-server-update.service
timer_unit=/etc/systemd/system/yawf-server-update.timer
timer_enable_link=/etc/systemd/system/timers.target.wants/yawf-server-update.timer
lock_directory=/run/yawf-server-updater
lock_path="$lock_directory/operation.lock"
fake_docker=/usr/local/bin/docker
fake_systemctl=/usr/local/bin/systemctl
fixture_root="/srv/yawf-installer-runtime-$$"

assert_absent_before_test() {
  local path
  for path in "$@"; do
    [[ ! -e "$path" && ! -L "$path" ]] || die "refusing pre-existing non-fixture path: $path"
  done
}

# This is an executable pre-mutation guard. The root-owned updater namespace
# and the two fake dispatch paths must be clean before this test owns them.
assert_absent_before_test \
  "$policy_directory" "$state_root" "$install_directory" "$helper" \
  "$service_unit" "$timer_unit" "$timer_enable_link" "$lock_directory" \
  "$fake_docker" "$fake_systemctl" "$fixture_root"

# A deterministic test umask makes the exact partial-registration state shape
# independent of runner defaults. It applies only to this disposable harness.
umask 022
preflight_namespace_absent=true

node_path="$(command -v node)"
[[ -n "$node_path" ]] || die "Node.js 24 is required for runtime installer test"
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || die "/usr/bin/node must be Node.js 24 or newer"

runtime_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/yawf-updater-install-runtime.XXXXXX")"
# The retained raw log and receipt are checked for secret-free bounded content
# before they are exposed to the unprivileged Actions step.
chmod 0755 "$runtime_root"
raw="$runtime_root/installer.raw.log"
receipt="$runtime_root/installer.receipt.json"
docker_log="$runtime_root/docker-dispatch.log"
compose_blocker="$runtime_root/block-compose"
source_hash="$(sha256sum "$installer" | awk '{print $1}')"

installation_started=false
registered_policy_owned=false
fixture_registration_may_exist=false
lock_may_exist=false
unsafe_policy_fixture=false
timer_touched=false
docker_fake_installed=false
systemctl_fake_installed=false
registration_cleanup_refused=false
cleanup_error_count=0
partial_registration_cleanup_observed=false
runtime_lock_cleanup_observed=false
continued_cleanup_after_error_observed=false

asset_matches_source() {
  local source="$1"
  local destination="$2"
  [[ ! -L "$destination" && -f "$destination" ]] || return 1
  [[ "$(sha256sum "$source" | awk '{print $1}')" == "$(sha256sum "$destination" | awk '{print $1}')" ]]
}

is_root_owned_mode() {
  local path="$1"
  local expected_mode="$2"
  local stat_line
  [[ ! -L "$path" ]] || return 1
  stat_line="$(stat -c '%u:%g:%a' "$path" 2>/dev/null)" || return 1
  [[ "$stat_line" == "0:0:$expected_mode" ]]
}

is_empty_directory() {
  local path="$1"
  ! find "$path" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

policy_is_fixture_owned() {
  [[ ! -L "$policy_path" && -f "$policy_path" ]] || return 1
  [[ ! -L "$policy_directory" && -d "$policy_directory" ]] || return 1
  is_root_owned_mode "$policy_directory" 700 || return 1
  /usr/bin/node - "$policy_path" "$fixture_root" <<'NODE'
const fs = require("fs");
const [policyPath, fixtureRoot] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
if (typeof policy.composeFile !== "string" || !policy.composeFile.startsWith(`${fixtureRoot}/`)) process.exit(1);
NODE
}

begin_registration_attempt() {
  [[ "$preflight_namespace_absent" == true ]] || die "registration fixture did not pass preflight"
  fixture_registration_may_exist=true
  lock_may_exist=true
}

runtime_lock_is_fixture_owned() {
  local entries mode group_digit other_digit
  [[ "$preflight_namespace_absent" == true && "$lock_may_exist" == true ]] || return 1
  [[ ! -L "$lock_directory" && -d "$lock_directory" ]] || return 1
  is_root_owned_mode "$lock_directory" 700 || return 1
  entries="$(find "$lock_directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  [[ "$entries" == "operation.lock" ]] || return 1
  [[ ! -L "$lock_path" && -f "$lock_path" ]] || return 1
  is_root_owned_mode "$lock_path" "$(stat -c '%a' "$lock_path" 2>/dev/null)" || return 1
  [[ "$(stat -c '%u:%g' "$lock_path" 2>/dev/null)" == "0:0" ]] || return 1
  [[ "$(stat -c '%s' "$lock_path" 2>/dev/null)" == "0" ]] || return 1
  mode="$(stat -c '%a' "$lock_path" 2>/dev/null)" || return 1
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1}"
  (( (10#$group_digit & 2) == 0 && (10#$other_digit & 2) == 0 )) || return 1
  /usr/bin/flock -n "$lock_path" /bin/true
}

partial_state_is_fixture_owned() {
  local entries
  [[ "$preflight_namespace_absent" == true && "$fixture_registration_may_exist" == true ]] || return 1
  [[ ! -e "$policy_path" && ! -L "$policy_path" ]] || return 1
  [[ ! -L "$state_root" && -d "$state_root" ]] || return 1
  is_root_owned_mode "$state_root" 700 || return 1
  entries="$(find "$state_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  [[ -z "$entries" ]] && return 0
  [[ "$entries" == "public" ]] || return 1
  [[ ! -L "$state_root/public" && -d "$state_root/public" ]] || return 1
  is_root_owned_mode "$state_root/public" 755 || return 1
  is_empty_directory "$state_root/public"
}

cleanup_error() {
  printf 'installer runtime cleanup error: %s\n' "$*" >&2
  cleanup_error_count=$((cleanup_error_count + 1))
}

remove_owned_empty_policy_directory() {
  [[ ! -e "$policy_directory" && ! -L "$policy_directory" ]] && return 0
  if [[ -L "$policy_directory" || ! -d "$policy_directory" ]] || ! is_root_owned_mode "$policy_directory" 700 || ! is_empty_directory "$policy_directory"; then
    cleanup_error "refusing non-empty or unowned updater policy directory"
    return 1
  fi
  if ! rmdir "$policy_directory"; then
    cleanup_error "could not remove fixture updater policy directory"
    return 1
  fi
}

remove_owned_runtime_lock() {
  [[ "$lock_may_exist" == true ]] || return 0
  if [[ ! -e "$lock_directory" && ! -L "$lock_directory" ]]; then
    lock_may_exist=false
    return 0
  fi
  if ! runtime_lock_is_fixture_owned; then
    cleanup_error "refusing unowned updater runtime lock"
    return 1
  fi
  if ! rm -f "$lock_path"; then
    cleanup_error "could not remove fixture updater runtime lock"
    return 1
  fi
  if ! rmdir "$lock_directory"; then
    cleanup_error "could not remove fixture updater runtime lock directory"
    return 1
  fi
  lock_may_exist=false
  runtime_lock_cleanup_observed=true
}

remove_owned_registration() {
  local result=0
  [[ "$registered_policy_owned" == true || "$fixture_registration_may_exist" == true ]] || return 0

  if [[ ! -e "$policy_path" && ! -L "$policy_path" ]]; then
    if [[ -e "$state_root" || -L "$state_root" ]]; then
      if partial_state_is_fixture_owned; then
        if [[ -e "$state_root/public" || -L "$state_root/public" ]] && ! rmdir "$state_root/public"; then
          cleanup_error "could not remove fixture partial updater public directory"
          registration_cleanup_refused=true
          result=1
        fi
        if [[ "$result" -eq 0 ]] && ! rmdir "$state_root"; then
          cleanup_error "could not remove fixture partial updater state directory"
          registration_cleanup_refused=true
          result=1
        fi
      else
        cleanup_error "refusing updater state without a validated fixture policy"
        registration_cleanup_refused=true
        return 1
      fi
    fi
    if ! remove_owned_empty_policy_directory; then
      registration_cleanup_refused=true
      result=1
    fi
    if [[ "$result" -eq 0 ]]; then
      registered_policy_owned=false
      fixture_registration_may_exist=false
      partial_registration_cleanup_observed=true
    fi
    return "$result"
  fi

  if ! policy_is_fixture_owned; then
    cleanup_error "refusing to remove an updater policy outside this fixture"
    registration_cleanup_refused=true
    return 1
  fi
  if ! "$helper" disable >>"$raw" 2>&1; then
    cleanup_error "could not disable validated fixture updater policy"
    registration_cleanup_refused=true
    return 1
  fi
  timer_touched=false
  if ! rm -f "$policy_path"; then
    cleanup_error "could not remove validated fixture updater policy"
    registration_cleanup_refused=true
    return 1
  fi
  if ! remove_owned_empty_policy_directory; then
    registration_cleanup_refused=true
    return 1
  fi
  if [[ -e "$state_root" || -L "$state_root" ]]; then
    if [[ -L "$state_root" || ! -d "$state_root" ]] || ! is_root_owned_mode "$state_root" 700; then
      cleanup_error "refusing unowned completed fixture updater state"
      registration_cleanup_refused=true
      return 1
    fi
    if ! rm -rf "$state_root"; then
      cleanup_error "could not remove validated fixture updater state"
      registration_cleanup_refused=true
      return 1
    fi
  fi
  registered_policy_owned=false
  fixture_registration_may_exist=false
}

remove_owned_installation() {
  local result=0
  [[ "$installation_started" == true ]] || return 0
  if [[ "$registration_cleanup_refused" == true ]]; then
    cleanup_error "refusing installed helper cleanup after registration cleanup refusal"
    return 1
  fi
  if [[ "$timer_touched" == true ]] && asset_matches_source "$repo/deploy/updater/yawf-server-update.timer" "$timer_unit"; then
    if ! systemctl disable --now yawf-server-update.timer >>"$raw" 2>&1; then
      cleanup_error "could not disable fixture updater timer"
      result=1
    fi
  fi
  timer_touched=false

  local source destination
  while IFS=$'\t' read -r source destination; do
    [[ -n "$source" ]] || continue
    if [[ -e "$destination" || -L "$destination" ]]; then
      if ! asset_matches_source "$source" "$destination"; then
        cleanup_error "refusing unowned installed path: $destination"
        result=1
        continue
      fi
      if ! rm -f "$destination"; then
        cleanup_error "could not remove installed fixture path: $destination"
        result=1
      fi
    fi
  done <<EOF_FILES
$repo/deploy/updater/yawf-server-update.mjs	$install_directory/yawf-server-update.mjs
$repo/deploy/updater/volume-copy.mjs	$install_directory/volume-copy.mjs
$repo/deploy/updater/yawf-server-update	$helper
$repo/deploy/updater/yawf-server-update.service	$service_unit
$repo/deploy/updater/yawf-server-update.timer	$timer_unit
EOF_FILES
  if [[ -e "$install_directory" || -L "$install_directory" ]] && ! rmdir "$install_directory"; then
    cleanup_error "could not remove fixture updater installation directory"
    result=1
  fi
  if ! systemctl daemon-reload >>"$raw" 2>&1; then
    cleanup_error "could not reload systemd after fixture asset cleanup"
    result=1
  fi
  return "$result"
}

remove_fake_docker() {
  [[ "$docker_fake_installed" == true ]] || return 0
  if [[ -L "$fake_docker" || ! -f "$fake_docker" ]] || ! rm -f "$fake_docker"; then
    cleanup_error "refusing fixture Docker dispatch path"
    return 1
  fi
  docker_fake_installed=false
}

remove_fake_systemctl() {
  [[ "$systemctl_fake_installed" == true ]] || return 0
  if [[ -L "$fake_systemctl" || ! -f "$fake_systemctl" ]] || ! rm -f "$fake_systemctl"; then
    cleanup_error "could not remove fixture systemctl dispatch path"
    return 1
  fi
  systemctl_fake_installed=false
}

remove_owned_fixture_root() {
  [[ ! -e "$fixture_root" && ! -L "$fixture_root" ]] && return 0
  if ! rm -rf "$fixture_root"; then
    cleanup_error "could not remove fixture root"
    return 1
  fi
}

remove_unsafe_policy_fixture() {
  [[ "$unsafe_policy_fixture" == true ]] || return 0
  local result=0
  if [[ -L "$policy_path" ]]; then
    if ! rm -f "$policy_path"; then
      cleanup_error "could not remove owned unsafe policy fixture"
      result=1
    fi
  else
    cleanup_error "unsafe policy fixture was not the expected symlink"
    result=1
  fi
  if [[ "$result" -eq 0 ]] && ! remove_owned_empty_policy_directory; then
    result=1
  fi
  [[ "$result" -eq 0 ]] && unsafe_policy_fixture=false
  return "$result"
}

cleanup_owned_resources() {
  local result=0
  remove_owned_registration || result=1
  remove_unsafe_policy_fixture || result=1
  remove_owned_installation || result=1
  remove_fake_docker || result=1
  remove_fake_systemctl || result=1
  remove_owned_fixture_root || result=1
  # The lock is last because every earlier cleanup helper can invoke the
  # installed updater wrapper and must retain the inherited lock boundary.
  remove_owned_runtime_lock || result=1
  return "$result"
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local final_status
  trap - EXIT
  set +e
  cleanup_owned_resources || cleanup_status=1
  final_status="$original_status"
  if [[ "$original_status" -eq 0 && ( "$cleanup_status" -ne 0 || "$cleanup_error_count" -ne 0 ) ]]; then
    final_status=1
  fi
  exit "$final_status"
}
trap cleanup EXIT

: > "$raw"
: > "$docker_log"

pty_install() {
  local case_name="$1"
  local input="$2"
  local expected_status="$3"
  local output="$runtime_root/${case_name}.log"
  local result_status
  set +e
  CASE_INPUT="$input" python3 - "$installer" "$output" <<'PY'
import os
import pty
import select
import signal
import sys
import time

installer, output = sys.argv[1:]
input_bytes = os.environ["CASE_INPUT"].encode()
pid, master = pty.fork()
if pid == 0:
    os.execv("/bin/bash", ["bash", installer])

chunks = []
total = 0
limit = 32 * 1024
deadline_seconds = 30
deadline = time.monotonic() + deadline_seconds
exit_status = None
reason = None
master_open = True

try:
    os.write(master, input_bytes)
    while exit_status is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            reason = f"installer PTY deadline exceeded after {deadline_seconds} seconds"
            break
        if master_open:
            readable, _, _ = select.select([master], [], [], min(0.5, remaining))
            if readable:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    master_open = False
                else:
                    total += len(chunk)
                    if total > limit:
                        reason = "installer PTY output exceeded 32768 bytes"
                        break
                    chunks.append(chunk)
        else:
            time.sleep(min(0.05, remaining))
        waited, waited_status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            exit_status = waited_status
finally:
    if exit_status is None:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, exit_status = os.waitpid(pid, 0)
    try:
        os.close(master)
    except OSError:
        pass
    with open(output, "wb") as handle:
        handle.write(b"".join(chunks))
        if reason is not None:
            handle.write(f"\n{reason}\n".encode())

if reason is not None:
    raise SystemExit(124)
raise SystemExit(os.waitstatus_to_exitcode(exit_status))
PY
  result_status=$?
  set -e
  cat "$output" >> "$raw"
  [[ "$result_status" -eq "$expected_status" ]] || {
    echo "PTY case $case_name returned $result_status, expected $expected_status" >&2
    return 1
  }
}

assert_timer() {
  local expected="$1"
  local actual
  actual="$(systemctl is-enabled yawf-server-update.timer 2>&1 || true)"
  [[ "$actual" == "$expected" ]] || {
    echo "timer state was $actual, expected $expected" >&2
    return 1
  }
}

assert_no_registration() {
  [[ ! -e "$policy_path" && ! -L "$policy_path" ]]
  [[ ! -e "$state_root" && ! -L "$state_root" ]]
  assert_timer disabled
}

create_protected_compose() {
  local path="$1"
  local directory
  directory="$(dirname "$path")"
  install -d -o root -g root -m 0755 "$directory"
  cat > "$path" <<'COMPOSE'
services:
  debridstreamer:
    image: ghcr.io/tgk-30/yawf-stream:2.3.12
COMPOSE
  chmod 0644 "$path"
  cat > "$directory/.env" <<'ENV'
DS_SERVER_SECRET_KEY=runtime-test-value
ENV
  chmod 0600 "$directory/.env"
}

install_fake_docker() {
  cat > "$fake_docker" <<'DOCKER'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> __DOCKER_LOG__
case "$1" in
  compose)
    if [ -e __COMPOSE_BLOCKER__ ]; then sleep 120; fi
    printf '%s\n' 0123456789abcdef
    ;;
  inspect)
    case "$3" in
      *com.docker.compose.service*) printf '%s\n' debridstreamer ;;
      *com.docker.compose.project*) printf '%s\n' yawfupdaterruntime ;;
      '{{.Config.Image}}') printf '%s\n' 'ghcr.io/tgk-30/yawf-stream@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
      '{{.Image}}') printf '%s\n' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
      '{{json .Mounts}}') printf '%s\n' '[{"Type":"volume","Destination":"/data","RW":true,"Name":"yawf-installer-runtime-data"}]' ;;
      *) exit 1 ;;
    esac
    ;;
  image) printf '%s\n' '["ghcr.io/tgk-30/yawf-stream@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]' ;;
  exec) printf '%s\n' '{"ok":true,"ready":true,"version":"2.3.12"}' ;;
  *) exit 1 ;;
esac
DOCKER
  sed -i "s|__DOCKER_LOG__|$docker_log|g; s|__COMPOSE_BLOCKER__|$compose_blocker|g" "$fake_docker"
  chmod 0755 "$fake_docker"
  docker_fake_installed=true
}

install_fake_systemctl() {
  cat > "$fake_systemctl" <<'SYSTEMCTL'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> __SYSTEMCTL_LOG__
case "$1" in
  daemon-reload|disable) exit 0 ;;
  enable) echo 'synthetic enable failure' >&2; exit 1 ;;
  is-enabled) printf '%s\n' disabled; exit 1 ;;
  *) exit 1 ;;
esac
SYSTEMCTL
  sed -i "s|__SYSTEMCTL_LOG__|$runtime_root/systemctl-dispatch.log|g" "$fake_systemctl"
  chmod 0755 "$fake_systemctl"
  systemctl_fake_installed=true
}

assert_no_installer_issued_transaction() {
  if grep -Eq '(^| )(pull|run|stop|up)( |$)' "$docker_log"; then
    echo "installer issued a Docker updater transaction command" >&2
    exit 1
  fi
}

# Fresh default, decline, EOF, and non-TTY behavior use real systemd and no
# fake Docker calls. They prove that installing the exact script bytes leaves a
# new host updater off unless the operator opts in.
installation_started=true
pty_install fresh-default $'\n' 0
assert_no_registration
pty_install fresh-decline $'N\n' 0
assert_no_registration
pty_install fresh-eof $'\004' 0
assert_no_registration
set +e
bash "$installer" </dev/null > "$runtime_root/non-tty.log" 2>&1
non_tty_status=$?
set -e
[[ "$non_tty_status" -eq 0 ]]
cat "$runtime_root/non-tty.log" >> "$raw"
grep -q 'No interactive terminal detected' "$runtime_root/non-tty.log"
assert_no_registration
bash "$installer" --unattended </dev/null > "$runtime_root/unattended.log" 2>&1
cat "$runtime_root/unattended.log" >> "$raw"
grep -q 'Automatic updates remain off' "$runtime_root/unattended.log"
assert_no_registration

# The fake Docker executable is a dispatch fixture only. The installed helper
# and its canonical-path registration validation, policy writes, and real
# systemd enable/disable behavior remain the actual installed implementation.
install_fake_docker
safe_compose="$fixture_root/with spaces/docker compose.ghcr.yml"
replacement_compose="$fixture_root/replacement/docker-compose.ghcr.yml"
create_protected_compose "$safe_compose"
create_protected_compose "$replacement_compose"

# Block only the fake Docker Compose dispatch after the original installed
# wrapper and Node helper have created their narrow state directory. The PTY
# deadline must kill and reap the whole process group before policy write.
: > "$compose_blocker"
begin_registration_attempt
pty_install interrupted-registration $'Y\n'"$safe_compose"$'\nY\n' 124
rm -f "$compose_blocker"
[[ ! -e "$policy_path" && ! -L "$policy_path" ]]
partial_state_is_fixture_owned
runtime_lock_is_fixture_owned
remove_owned_registration
remove_owned_runtime_lock
assert_absent_before_test "$policy_directory" "$state_root" "$lock_directory"
partial_registration_cleanup_observed=true
runtime_lock_cleanup_observed=true
assert_no_registration

begin_registration_attempt
pty_install fresh-yes $'Y\n'"$safe_compose"$'\nY\n' 0
registered_policy_owned=true
timer_touched=true
/usr/bin/node - "$safe_compose" <<'NODE'
const fs = require("fs");
const [path] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
if (policy.composeFile !== path || policy.enabled !== true) process.exit(1);
NODE
assert_timer enabled

# A registered enabled deployment cannot be replaced by the generic explicit
# enable flags. The policy and timer remain unchanged until the caller adds the
# dedicated replacement scope.
policy_before="$(sha256sum "$policy_path" | awk '{print $1}')"
begin_registration_attempt
set +e
bash "$installer" --unattended --enable --compose-file "$replacement_compose" > "$runtime_root/replacement-scope.log" 2>&1
scope_status=$?
set -e
[[ "$scope_status" -eq 1 ]]
grep -q -- '--replace-registration' "$runtime_root/replacement-scope.log"
[[ "$policy_before" == "$(sha256sum "$policy_path" | awk '{print $1}')" ]]
assert_timer enabled

# An explicit replacement scope must replace the policy with the separate
# protected Compose target, change policy bytes, and retain an enabled timer.
begin_registration_attempt
bash "$installer" --unattended --enable --replace-registration --compose-file "$replacement_compose" > "$runtime_root/replacement.log" 2>&1
[[ "$policy_before" != "$(sha256sum "$policy_path" | awk '{print $1}')" ]]
/usr/bin/node - "$replacement_compose" <<'NODE'
const fs = require("fs");
const [path] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
if (policy.composeFile !== path || policy.enabled !== true) process.exit(1);
NODE
assert_timer enabled

# Reinstall with a registered enabled timer leaves both policy bytes and timer
# state unchanged unless the caller supplies explicit replacement scope.
policy_before="$(sha256sum "$policy_path" | awk '{print $1}')"
bash "$installer" </dev/null > "$runtime_root/reinstall.log" 2>&1
grep -q 'Existing updater registration preserved' "$runtime_root/reinstall.log"
[[ "$policy_before" == "$(sha256sum "$policy_path" | awk '{print $1}')" ]]
assert_timer enabled
remove_owned_registration
assert_timer disabled

# An unsafe symlink target fails in the actual helper before registration and
# cannot reach enable.
mkdir -p "$fixture_root/unsafe"
printf '%s\n' 'services: {}' > "$fixture_root/unsafe/real-compose.yml"
printf '%s\n' 'DS_SERVER_SECRET_KEY=runtime-test-value' > "$fixture_root/unsafe/.env"
chmod 0600 "$fixture_root/unsafe/.env"
ln -s "$fixture_root/unsafe/real-compose.yml" "$fixture_root/unsafe/docker-compose.ghcr.yml"
begin_registration_attempt
pty_install registration-failure $'Y\n'"${fixture_root}/unsafe/docker-compose.ghcr.yml"$'\nY\n' 1
assert_no_registration

# A symlinked existing policy fails before an explicit replacement can reach
# registration, preserving the fail-closed policy boundary.
install -d -o root -g root -m 0700 "$policy_directory"
ln -s "$fixture_root/not-a-policy" "$policy_path"
unsafe_policy_fixture=true
begin_registration_attempt
set +e
bash "$installer" --unattended --enable --replace-registration --compose-file "$safe_compose" > "$runtime_root/unsafe-policy.log" 2>&1
unsafe_policy_status=$?
set -e
[[ "$unsafe_policy_status" -eq 1 ]]
grep -q 'Existing updater policy file is unsafe' "$runtime_root/unsafe-policy.log"
rm -f "$policy_path"
rmdir "$policy_directory"
unsafe_policy_fixture=false
assert_no_registration

# This isolated fake-systemctl case tests error dispatch only. It does not
# represent an image transaction. The installer must invoke disable after an
# enable failure and report the observed disabled state.
install_fake_systemctl
begin_registration_attempt
pty_install enable-failure $'Y\n'"$safe_compose"$'\nY\n' 1
registered_policy_owned=true
/usr/bin/node - <<'NODE'
const fs = require("fs");
if (JSON.parse(fs.readFileSync("/etc/yawf-server-updater/config.json", "utf8")).enabled !== false) process.exit(1);
NODE
grep -q '^enable --now yawf-server-update.timer$' "$runtime_root/systemctl-dispatch.log"
grep -q '^disable --now yawf-server-update.timer$' "$runtime_root/systemctl-dispatch.log"
grep -q 'Automatic updates are confirmed disabled' "$runtime_root/enable-failure.log"
remove_owned_registration
assert_timer disabled
assert_no_installer_issued_transaction

# Force an owned fake dispatch path into a refused shape only after the normal
# registration has been removed. Cleanup must still remove later owned
# resources and allowed installed assets, then leave this known symlink for an
# explicit, narrow fixture-only unlink.
rm -f "$fake_docker"
ln -s /dev/null "$fake_docker"
continued_cleanup_log="$runtime_root/continued-cleanup.log"
set +e
cleanup_owned_resources >"$continued_cleanup_log" 2>&1
continued_cleanup_status=$?
set -e
[[ "$continued_cleanup_status" -eq 1 ]]
grep -q 'refusing fixture Docker dispatch path' "$continued_cleanup_log"
cat "$continued_cleanup_log" >> "$raw"
[[ -L "$fake_docker" && "$(readlink "$fake_docker")" == /dev/null ]]
assert_absent_before_test \
  "$install_directory" "$helper" "$service_unit" "$timer_unit" "$timer_enable_link" \
  "$fake_systemctl" "$fixture_root" "$lock_directory"
rm -f "$fake_docker"
docker_fake_installed=false
cleanup_error_count=0
continued_cleanup_after_error_observed=true

# Exercise idempotent post-cleanup behavior before the receipt is written. The
# EXIT trap remains the safety path for every earlier failure.
cleanup_owned_resources
[[ "$cleanup_error_count" -eq 0 ]]
assert_absent_before_test \
  "$policy_directory" "$state_root" "$install_directory" "$helper" \
  "$service_unit" "$timer_unit" "$timer_enable_link" "$lock_directory" \
  "$fake_docker" "$fake_systemctl" "$fixture_root"

[[ "$source_hash" == "$(sha256sum "$installer" | awk '{print $1}')" ]]
if grep -q 'DS_SERVER_SECRET_KEY=' "$raw"; then
  echo "installer runtime output exposed an environment value" >&2
  exit 1
fi
/usr/bin/node - "$receipt" "$source_hash" "$partial_registration_cleanup_observed" "$runtime_lock_cleanup_observed" "$continued_cleanup_after_error_observed" <<'NODE'
const fs = require("fs");
const [receipt, sourceHash, partialRegistrationCleanupObserved, runtimeLockCleanupObserved, continuedCleanupAfterErrorObserved] = process.argv.slice(2);
if (partialRegistrationCleanupObserved !== "true" || runtimeLockCleanupObserved !== "true" || continuedCleanupAfterErrorObserved !== "true") process.exit(1);
fs.writeFileSync(receipt, `${JSON.stringify({
  ok: true,
  mode: "installer-pty-runtime",
  sourceSha256: sourceHash,
  cases: 13,
  freshDefaultOff: true,
  declinedOff: true,
  eofOff: true,
  nonTtyOff: true,
  unattendedOff: true,
  stubbedDockerRegistrationPolicySystemd: true,
  explicitResetScopeRequired: true,
  safeExplicitReplacement: true,
  existingEnabledPolicyPreserved: true,
  unsafeRegistrationRejected: true,
  enableFailureDisableObserved: true,
  partialRegistrationCleanupObserved: partialRegistrationCleanupObserved === "true",
  runtimeLockCleanupObserved: runtimeLockCleanupObserved === "true",
  continuedCleanupAfterErrorObserved: continuedCleanupAfterErrorObserved === "true",
  installerIssuedUpdateTransaction: false,
})}\n`, { mode: 0o600 });
NODE
test -s "$receipt"
chmod 0644 "$raw" "$receipt"
printf '%s\n' "INSTALLER_RUNTIME_RAW=$raw"
printf '%s\n' "INSTALLER_RUNTIME_RECEIPT=$receipt"
