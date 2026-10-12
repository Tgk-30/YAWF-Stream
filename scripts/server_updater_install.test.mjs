import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const repository = resolve(new URL("..", import.meta.url).pathname);
const updaterDirectory = resolve(repository, "deploy/updater");
const image = "node:24-bookworm-slim";

function dockerReady() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0;
}

const dockerAvailable = dockerReady();
if (process.env.YAWF_REQUIRE_DOCKER === "1" && !dockerAvailable) {
  throw new Error("YAWF_REQUIRE_DOCKER=1 requires a usable Docker daemon for installer runtime tests.");
}

const containerRunner = `#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
ln -sf "$(command -v node)" /usr/bin/node
mkdir -p /usr/local/bin /test

cat > /usr/local/bin/docker <<'DOCKER'
#!/bin/sh
set -eu
case "$1" in
  compose)
    printf '%s\\n' 0123456789abcdef
    ;;
  inspect)
    case "$3" in
      *com.docker.compose.service*) printf '%s\\n' debridstreamer ;;
      *com.docker.compose.project*) printf '%s\\n' yawfupdatertest ;;
      '{{.Config.Image}}') printf '%s\\n' 'ghcr.io/tgk-30/yawf-stream@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
      '{{.Image}}') printf '%s\\n' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
      '{{json .Mounts}}') printf '%s\\n' '[{"Type":"volume","Destination":"/data","RW":true,"Name":"yawf-updater-test-data"}]' ;;
      *) echo "unexpected docker inspect format: $3" >&2; exit 1 ;;
    esac
    ;;
  image)
    [ "$2" = inspect ] || exit 1
    printf '%s\\n' '["ghcr.io/tgk-30/yawf-stream@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'
    ;;
  exec)
    printf '%s\\n' '{"ok":true,"ready":true,"version":"2.3.12"}'
    ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 1 ;;
esac
DOCKER
chmod 0755 /usr/local/bin/docker

cat > /usr/local/bin/systemctl <<'SYSTEMCTL'
#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "\${YAWF_TEST_LOG:?}"
state=/run/yawf-updater-test-timer-state
case "$1" in
  daemon-reload) ;;
  enable)
    if [ "\${YAWF_TEST_SYSTEMCTL_MODE:-ok}" = fail-enable ]; then
      echo "synthetic enable failure" >&2
      exit 1
    fi
    echo enabled > "$state"
    ;;
  disable) echo disabled > "$state" ;;
  is-enabled)
    state_value="$(cat "$state" 2>/dev/null || echo disabled)"
    printf '%s\\n' "$state_value"
    [ "$state_value" = enabled ]
    ;;
  *) echo "unexpected systemctl invocation: $*" >&2; exit 1 ;;
esac
SYSTEMCTL
chmod 0755 /usr/local/bin/systemctl

reset_case() {
  rm -rf /etc/yawf-server-updater /var/lib/yawf-server-updater /usr/lib/yawf-server-updater \
    /usr/local/sbin/yawf-server-update /etc/systemd/system/yawf-server-update.service \
    /etc/systemd/system/yawf-server-update.timer /srv/yawf /srv/yawf-with-spaces
  : > /test/commands.log
  echo disabled > /run/yawf-updater-test-timer-state
  export YAWF_TEST_LOG=/test/commands.log
  export YAWF_TEST_SYSTEMCTL_MODE=ok
}

create_compose() {
  path="$1"
  directory="$(dirname "$path")"
  mkdir -p "$directory"
  chmod 0755 "$directory"
  cat > "$path" <<'COMPOSE'
services:
  debridstreamer:
    image: ghcr.io/tgk-30/yawf-stream:2.3.12
COMPOSE
  cat > "$directory/.env" <<'ENV'
DS_SERVER_SECRET_KEY=not-a-real-secret
ENV
  chmod 0644 "$path"
  chmod 0600 "$directory/.env"
}

run_noninteractive() {
  env YAWF_TEST_LOG=/test/commands.log YAWF_TEST_SYSTEMCTL_MODE="$YAWF_TEST_SYSTEMCTL_MODE" \
    PATH="$PATH" bash /bundle/install.sh "$@" < /dev/null > /test/output.log 2>&1
}

run_interactive() {
  input="$1"
  set +e
  printf '%b' "$input" | script -q -e -c "env YAWF_TEST_LOG=/test/commands.log YAWF_TEST_SYSTEMCTL_MODE=$YAWF_TEST_SYSTEMCTL_MODE PATH=$PATH bash /bundle/install.sh" /dev/null > /test/output.log 2>&1
  status=\${PIPESTATUS[1]}
  set -e
  return "$status"
}

expect_no_registration() {
  test ! -e /etc/yawf-server-updater/config.json
  ! grep -q '^enable ' /test/commands.log
  ! grep -q '^disable ' /test/commands.log
}

assert_fresh_opt_in_enabled() {
  path="$1"
  node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync("/etc/yawf-server-updater/config.json")); if (p.composeFile !== process.argv[1] || p.enabled !== true) process.exit(1)' "$path" || {
    echo 'fresh opt-in did not enable registered policy' >&2
    return 1
  }
}

case_fresh_yes() {
  reset_case
  path=/srv/yawf/docker-compose.ghcr.yml
  create_compose "$path"
  run_interactive "Y\\n$path\\nY\\n"
  assert_fresh_opt_in_enabled "$path"
  grep -q '^enable --now yawf-server-update.timer$' /test/commands.log
}

case_decline_default_eof_and_non_tty() {
  for response in 'N\\n' '\\n'; do
    reset_case
    run_interactive "$response"
    expect_no_registration
  done
  reset_case
  set +e
  script -q -e -c "env YAWF_TEST_LOG=/test/commands.log PATH=$PATH bash /bundle/install.sh" /dev/null < /dev/null > /test/output.log 2>&1
  status=$?
  set -e
  test "$status" -eq 0
  expect_no_registration
  reset_case
  run_noninteractive
  expect_no_registration
  grep -q 'No interactive terminal detected' /test/output.log
}

case_explicit_unattended_and_path_safety() {
  reset_case
  path='/srv/yawf-with-spaces/docker compose.ghcr.yml'
  create_compose "$path"
  run_noninteractive --unattended --enable --compose-file "$path"
  node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync("/etc/yawf-server-updater/config.json")); if (p.composeFile !== process.argv[1] || p.enabled !== true) process.exit(1)' "$path"
  test ! -e /test/injected
  set +e
  run_noninteractive --unattended --enable --compose-file '/srv/yawf;touch /test/injected'
  status=$?
  set -e
  test "$status" -ne 0
  test ! -e /test/injected
}

case_explicit_replacement_uses_second_protected_target() {
  reset_case
  first=/srv/yawf/docker-compose.ghcr.yml
  second=/srv/yawf-with-spaces/docker-compose.ghcr.yml
  create_compose "$first"
  create_compose "$second"
  run_noninteractive --unattended --enable --compose-file "$first"
  before="$(sha256sum /etc/yawf-server-updater/config.json)"
  set +e
  run_noninteractive --unattended --enable --compose-file "$second"
  status=$?
  set -e
  test "$status" -ne 0
  test "$before" = "$(sha256sum /etc/yawf-server-updater/config.json)"
  test "$(cat /run/yawf-updater-test-timer-state)" = enabled
  run_noninteractive --unattended --enable --replace-registration --compose-file "$second"
  test "$before" != "$(sha256sum /etc/yawf-server-updater/config.json)"
  node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync("/etc/yawf-server-updater/config.json")); if (p.composeFile !== process.argv[1] || p.enabled !== true) process.exit(1)' "$second"
  test "$(cat /run/yawf-updater-test-timer-state)" = enabled
}

case_reinstall_and_unsafe_existing_policy() {
  reset_case
  mkdir -p /etc/yawf-server-updater
  printf '%s\\n' '{"schemaVersion":1,"enabled":true}' > /etc/yawf-server-updater/config.json
  chmod 0700 /etc/yawf-server-updater
  chmod 0600 /etc/yawf-server-updater/config.json
  before="$(sha256sum /etc/yawf-server-updater/config.json)"
  run_interactive 'Y\\n/srv/yawf/docker-compose.ghcr.yml\\nY\\n'
  test "$before" = "$(sha256sum /etc/yawf-server-updater/config.json)"
  ! grep -q '^enable ' /test/commands.log

  reset_case
  mkdir -p /etc/yawf-server-updater
  ln -s /test/not-a-policy /etc/yawf-server-updater/config.json
  set +e
  run_noninteractive --unattended
  status=$?
  set -e
  test "$status" -ne 0
  grep -q 'Existing updater policy file is unsafe' /test/output.log
}

case_registration_and_enable_failures() {
  reset_case
  mkdir -p /srv/yawf
  printf '%s\\n' 'services: {}' > /srv/yawf/real-compose.yml
  printf '%s\\n' 'DS_SERVER_SECRET_KEY=not-a-real-secret' > /srv/yawf/.env
  chmod 0600 /srv/yawf/.env
  ln -s /srv/yawf/real-compose.yml /srv/yawf/docker-compose.ghcr.yml
  set +e
  run_interactive 'Y\\n/srv/yawf/docker-compose.ghcr.yml\\nY\\n'
  status=$?
  set -e
  test "$status" -ne 0
  test ! -e /etc/yawf-server-updater/config.json
  ! grep -q '^enable ' /test/commands.log

  reset_case
  path=/srv/yawf/docker-compose.ghcr.yml
  create_compose "$path"
  export YAWF_TEST_SYSTEMCTL_MODE=fail-enable
  set +e
  run_interactive "Y\\n$path\\nY\\n"
  status=$?
  set -e
  test "$status" -ne 0
  node -e 'const f=require("fs"); if (JSON.parse(f.readFileSync("/etc/yawf-server-updater/config.json")).enabled !== false) process.exit(1)'
  grep -q '^enable --now yawf-server-update.timer$' /test/commands.log
  grep -q '^disable --now yawf-server-update.timer$' /test/commands.log
  grep -q 'Automatic updates are confirmed disabled' /test/output.log
}

case_fresh_yes
case_decline_default_eof_and_non_tty
case_explicit_unattended_and_path_safety
case_explicit_replacement_uses_second_protected_target
case_reinstall_and_unsafe_existing_policy
case_registration_and_enable_failures
printf '%s\\n' 'installer runtime cases passed: 11'
`;

function runContainerBundle(bundleDirectory) {
  const fixture = mkdtempSync(resolve(tmpdir(), "yawf-updater-install-test-"));
  const runner = resolve(fixture, "run-installer-cases.sh");
  try {
    writeFileSync(runner, containerRunner, { mode: 0o700 });
    const result = spawnSync("docker", ["run", "--rm", "-v", `${bundleDirectory}:/bundle:ro`, "-v", `${fixture}:/test:rw`, image,
      "bash", "/test/run-installer-cases.sh"], { encoding: "utf8", timeout: 120_000 });
    return { result, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("exact installer bytes handle opt-in, decline, EOF, non-TTY, replacement, reinstall, and failure paths in an isolated Linux container", { skip: !dockerAvailable }, () => {
  const { result, output } = runContainerBundle(updaterDirectory);
  assert.equal(result.status, 0, output);
  assert.match(output, /installer runtime cases passed: 11/);
});

test("a copied installer mutation cannot silently bypass fresh opt-in enablement", { skip: !dockerAvailable }, () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "yawf-updater-install-enable-mutation-"));
  const bundle = resolve(fixture, "bundle");
  try {
    cpSync(updaterDirectory, bundle, { recursive: true });
    const installerPath = resolve(bundle, "install.sh");
    const original = readFileSync(installerPath, "utf8");
    const enableInvocation = '"$helper" enable';
    assert.equal(original.split(enableInvocation).length - 1, 1, "mutation target must be unique");
    writeFileSync(installerPath, original.replace(enableInvocation, '"$helper" status'));

    const { result, output } = runContainerBundle(bundle);
    assert.notEqual(result.status, 0, output);
    assert.match(output, /fresh opt-in did not enable registered policy/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
