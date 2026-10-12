import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deb-release.yml", import.meta.url), "utf8");
const integration = readFileSync(new URL("./server_updater_compose_integration.mjs", import.meta.url), "utf8");
const transactionDriver = readFileSync(new URL("./server_updater_transaction_driver.mjs", import.meta.url), "utf8");
const updater = readFileSync(new URL("../deploy/updater/yawf-server-update.mjs", import.meta.url), "utf8");
const volumeCopy = readFileSync(new URL("../deploy/updater/volume-copy.mjs", import.meta.url), "utf8");
const installerRuntime = readFileSync(new URL("./server_updater_install_runtime.sh", import.meta.url), "utf8");
const installerContainer = readFileSync(new URL("./server_updater_install.test.mjs", import.meta.url), "utf8");
const installer = readFileSync(new URL("../deploy/updater/install.sh", import.meta.url), "utf8");
const updaterReadme = readFileSync(new URL("../deploy/updater/README.md", import.meta.url), "utf8");
const composeReadme = readFileSync(new URL("../deploy/compose/README.md", import.meta.url), "utf8");
const installerStep = workflow.match(/- name: Test updater policy and release guards[\s\S]*?(?=\n\s+- name: Install disabled updater)/)?.[0] ?? "";
const syntheticStep = workflow.match(/- name: Verify isolated Compose upgrade and rollback[\s\S]*?(?=\n\s+- name: Validate optional)/)?.[0] ?? "";
const actualStep = workflow.match(/- name: Verify actual published image upgrade and rollback[\s\S]*?(?=\n\s+- name: Retain updater)/)?.[0] ?? "";

function uniqueSlice(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, label + " start missing");
  assert.equal(source.indexOf(startMarker, start + startMarker.length), -1, label + " start duplicated");
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, label + " end missing");
  return source.slice(start, end);
}

function initialPreflight(source) {
  const block = uniqueSlice(source, "# This is an executable pre-mutation guard.",
    "\n# A deterministic test umask", "initial updater namespace preflight");
  const lines = block.split(/\r?\n/);
  const startText = "assert_absent_before_test " + String.fromCharCode(92);
  const starts = lines.flatMap((line, i) => line.trim() === startText ? [i] : []);
  assert.equal(starts.length, 1, "initial preflight must contain exactly one continuation call");
  const call = [];
  for (let i = starts[0]; i < lines.length; i += 1) {
    call.push(lines[i]);
    if (!lines[i].trim().endsWith(String.fromCharCode(92))) break;
  }
  return {
    raw: call.join("\n"),
    normalized: call.join(" ").split(String.fromCharCode(92)).join(" ").replace(/\s+/g, " ").trim(),
  };
}

function assertInitialPreflight(source) {
  assert.equal(initialPreflight(source).normalized,
    'assert_absent_before_test "$policy_directory" "$state_root" "$install_directory" "$helper" "$service_unit" "$timer_unit" "$timer_enable_link" "$lock_directory" "$fake_docker" "$fake_systemctl" "$fixture_root"');
}

function uniqueShellFunction(source, name) {
  const header = name + "() {\n";
  assert.equal(source.split(header).length - 1, 1, name + " must have one definition");
  const start = source.indexOf(header);
  const end = source.indexOf("\n}\n", start + header.length);
  assert.notEqual(end, -1, name + " terminator missing");
  return { text: source.slice(start, end + 3), end: end + 3 };
}

function significantLines(block) {
  return block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function assertCleanupDispatch(source) {
  assert.deepEqual(significantLines(uniqueShellFunction(source, "cleanup_owned_resources").text), [
    "cleanup_owned_resources() {", "local result=0",
    "remove_owned_registration || result=1",
    "remove_unsafe_policy_fixture || result=1",
    "remove_owned_installation || result=1",
    "remove_fake_docker || result=1",
    "remove_fake_systemctl || result=1",
    "remove_owned_fixture_root || result=1",
    "remove_owned_runtime_lock || result=1",
    'return "$result"', "}",
  ]);
}

function assertOwnedInstallationReload(source) {
  const installation = uniqueShellFunction(source, "remove_owned_installation").text;
  const reloads = installation.match(/(?:\/usr\/bin\/)?systemctl daemon-reload/g) ?? [];
  assert.deepEqual(reloads, ["/usr/bin/systemctl daemon-reload"]);
}

test("initial preflight and cleanup guards cannot be satisfied by later duplicate substrings", () => {
  assertInitialPreflight(installerRuntime);
  assertCleanupDispatch(installerRuntime);
  const preflight = initialPreflight(installerRuntime).raw;
  const omittedLock = preflight.replace(' "$lock_directory"', "");
  assert.notEqual(omittedLock, preflight);
  assert.throws(() => assertInitialPreflight(installerRuntime.replace(preflight, omittedLock)));
  const cleanup = uniqueShellFunction(installerRuntime, "cleanup_owned_resources").text;
  const omittedCleanupLock = cleanup.replace("  remove_owned_runtime_lock || result=1\n", "");
  assert.notEqual(omittedCleanupLock, cleanup);
  assert.throws(() => assertCleanupDispatch(installerRuntime.replace(cleanup, omittedCleanupLock)));
});

test("unique EXIT cleanup preserves failure status and cannot return a false success", () => {
  const cleanup = uniqueShellFunction(installerRuntime, "cleanup");
  assert.deepEqual(significantLines(cleanup.text), [
    "cleanup() {", "local original_status=$?", "local cleanup_status=0", "local final_status",
    "trap - EXIT", "set +e", "cleanup_owned_resources || cleanup_status=1",
    'final_status="$original_status"',
    'if [[ "$original_status" -eq 0 && ( "$cleanup_status" -ne 0 || "$cleanup_error_count" -ne 0 ) ]]; then',
    "final_status=1", "fi", 'exit "$final_status"', "}",
  ]);
  assert.ok(installerRuntime.slice(cleanup.end).startsWith("trap cleanup EXIT\n"));
});

test("owned installation cleanup reloads systemd through the real absolute path", () => {
  assertOwnedInstallationReload(installerRuntime);
  const installation = uniqueShellFunction(installerRuntime, "remove_owned_installation").text;
  const unqualified = installation.replace("/usr/bin/systemctl daemon-reload", "systemctl daemon-reload");
  assert.notEqual(unqualified, installation);
  assert.throws(() => assertOwnedInstallationReload(installerRuntime.replace(installation, unqualified)));
});

test("a cached deleted fake systemctl cannot intercept the absolute cleanup reload", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "yawf-systemctl-path-cache-"));
  const fakeDirectory = resolve(fixture, "fake");
  const realDirectory = resolve(fixture, "real");
  const fakeMarker = resolve(fixture, "fake.marker");
  const realMarker = resolve(fixture, "real.marker");
  const probe = resolve(fixture, "probe.sh");
  try {
    mkdirSync(fakeDirectory);
    mkdirSync(realDirectory);
    writeFileSync(resolve(fakeDirectory, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' fake >> "$FAKE_MARKER"
`, { mode: 0o700 });
    writeFileSync(resolve(realDirectory, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' real >> "$REAL_MARKER"
`, { mode: 0o700 });
    writeFileSync(probe, `#!/usr/bin/env bash
set -euo pipefail
shopt -u checkhash
PATH="$FAKE_DIR:$REAL_DIR:/usr/bin:/bin"
export PATH
systemctl daemon-reload
unlink "$FAKE_DIR/systemctl"
set +e
systemctl daemon-reload
cached_status=$?
set -e
test "$cached_status" -eq 127
"$REAL_DIR/systemctl" daemon-reload
`, { mode: 0o700 });
    const result = spawnSync("bash", [probe], {
      encoding: "utf8",
      env: { ...process.env, FAKE_DIR: fakeDirectory, REAL_DIR: realDirectory, FAKE_MARKER: fakeMarker, REAL_MARKER: realMarker },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fakeMarker, "utf8"), "fake\n");
    assert.equal(readFileSync(realMarker, "utf8"), "real\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("installer PTY runtime proof remains an exact-byte, bounded Ubuntu CI gate", () => {
  assert.match(installerStep, /set -euo pipefail/);
  assert.match(installerStep, /timeout 420s sudo env[\s\S]*bash scripts\/server_updater_install_runtime\.sh 2>&1 \| tee "\$driver_log"/);
  assert.match(installerStep, /test -s "\$runtime_raw"/);
  assert.match(installerStep, /test -s "\$runtime_receipt"/);
  assert.match(installerStep, /assert\.equal\(receipt\.sourceSha256, expectedSourceHash/);
  assert.match(installerStep, /assert\.equal\(receipt\.installerIssuedUpdateTransaction, false\)/);
  assert.match(installerRuntime, /pty\.fork\(\)/);
  assert.match(installerRuntime, /source_hash="\$\(sha256sum "\$installer"/);
  assert.match(installerRuntime, /\[\[ "\$source_hash" == "\$\(sha256sum "\$installer"/);
  assert.match(installerRuntime, /limit = 32 \* 1024/);
  assert.match(installerRuntime, /systemctl disable --now yawf-server-update\.timer/);
  assert.match(installer, /"\$helper" register "\$compose_file"/);
  assert.match(installer, /"\$helper" enable/);
  assert.doesNotMatch(installer, /"\$helper" (?:check|run)/);
  assert.match(installer, /Register this path and enable the timer now\? The installer does not directly run an update check or transaction\. \[y\/N\]/);
  assert.match(installer, /Registering the requested Compose deployment\. The installer does not directly run an update check or transaction\./);
  for (const readme of [updaterReadme, composeReadme]) {
    assert.match(readme, /The installer does not directly invoke an update check or transaction\. Enabling activates the systemd timer; any timer service run is scheduled independently by systemd and remains subject to the updater policy and maintenance-window gates\./);
  }
});

test("installer PTY runtime dispatch requires explicit disposable CI authority and owned cleanup", () => {
  assert.match(installerStep, /timeout 240s env YAWF_REQUIRE_DOCKER=1 node --test scripts\/server_updater_install\.test\.mjs/);
  assert.match(installerStep, /timeout 420s sudo env[\s\S]*YAWF_INSTALLER_RUNTIME_DISPOSABLE=1/);
  assert.match(installerStep, /GITHUB_ACTIONS="\$GITHUB_ACTIONS"/);
  assert.match(installerStep, /RUNNER_ENVIRONMENT="\$RUNNER_ENVIRONMENT"/);
  assert.match(installerStep, /RUNNER_OS="\$RUNNER_OS"/);
  assert.match(installerRuntime, /require_disposable_github_runner\n\[\[ \$\{EUID\} -eq 0 \]\]/);
  assert.match(installerRuntime, /YAWF_INSTALLER_RUNTIME_DISPOSABLE:-\}" == "1"/);
  assert.match(installerRuntime, /GITHUB_ACTIONS:-\}" == "true"/);
  assert.match(installerRuntime, /RUNNER_ENVIRONMENT:-\}" == "github-hosted"/);
  assert.match(installerRuntime, /RUNNER_OS:-\}" == "Linux"/);
  assert.match(installerRuntime, /ID:-\}" == "ubuntu"/);
  assert.match(installerRuntime, /lock_directory=\/run\/yawf-server-updater/);
  assert.match(installerRuntime, /lock_path="\$lock_directory\/operation\.lock"/);
  assert.match(installerRuntime, /begin_registration_attempt\(\)[\s\S]*fixture_registration_may_exist=true[\s\S]*lock_may_exist=true/);
  assert.match(installerRuntime, /runtime_lock_is_fixture_owned\(\)[\s\S]*is_root_owned_mode "\$lock_directory" 700[\s\S]*operation\.lock[\s\S]*\/usr\/bin\/flock -n "\$lock_path" \/bin\/true/);
  assert.match(installerRuntime, /partial_state_is_fixture_owned\(\)[\s\S]*is_root_owned_mode "\$state_root" 700[\s\S]*state_root\/public[\s\S]*is_root_owned_mode "\$state_root\/public" 755/);
  assert.match(installerRuntime, /cleanup_error_count=0/);
  assert.match(installerRuntime, /could not remove fixture partial updater public directory"[\s\S]*registration_cleanup_refused=true/);
  assert.match(installerRuntime, /could not remove fixture partial updater state directory"[\s\S]*registration_cleanup_refused=true/);
  assert.match(installerRuntime, /remove_owned_runtime_lock\(\)[\s\S]*rm -f "\$lock_path"[\s\S]*rmdir "\$lock_directory"/);
  assert.doesNotMatch(installerRuntime, /remove_owned_registration\(\)[\s\S]*?\bdie\(/);
  assert.doesNotMatch(installerRuntime, /saved_docker|saved_systemctl|had_docker|had_systemctl/);
});

test("EXIT cleanup exits with the computed final status instead of returning from the trap", () => {
  const cleanup = installerRuntime.match(/cleanup\(\) \{[\s\S]*?\n}\ntrap cleanup EXIT/)?.[0] ?? "";
  assert.match(cleanup, /trap - EXIT/);
  assert.match(cleanup, /final_status="\$original_status"/);
  assert.match(cleanup, /original_status" -eq 0[\s\S]*final_status=1/);
  assert.match(cleanup, /exit "\$final_status"/);
  assert.doesNotMatch(cleanup, /return "\$final_status"/);
});

test("installer PTY runner bounds hung cases and proves replacement uses a second target", () => {
  assert.match(installerRuntime, /deadline = time\.monotonic\(\) \+ deadline_seconds/);
  assert.match(installerRuntime, /deadline_seconds = 30/);
  assert.match(installerRuntime, /os\.killpg\(os\.getpgid\(pid\), signal\.SIGKILL\)/);
  assert.match(installerRuntime, /raise SystemExit\(124\)/);
  assert.match(installerRuntime, /: > "\$compose_blocker"[\s\S]*begin_registration_attempt[\s\S]*pty_install interrupted-registration[\s\S]* 124/);
  assert.match(installerRuntime, /partial_state_is_fixture_owned[\s\S]*runtime_lock_is_fixture_owned[\s\S]*remove_owned_registration[\s\S]*remove_owned_runtime_lock/);
  assert.match(installerRuntime, /partialRegistrationCleanupObserved: partialRegistrationCleanupObserved === "true"/);
  assert.match(installerRuntime, /runtimeLockCleanupObserved: runtimeLockCleanupObserved === "true"/);
  assert.match(installerRuntime, /continuedCleanupAfterErrorObserved: continuedCleanupAfterErrorObserved === "true"/);
  assert.match(installerRuntime, /refusing fixture Docker dispatch path/);
  assert.match(installerRuntime, /cleanup_owned_resources >"\$continued_cleanup_log" 2>&1/);
  assert.match(installerRuntime, /continued_cleanup_status" -eq 1/);
  assert.match(installerRuntime, /installerIssuedUpdateTransaction: false/);
  assert.match(installerRuntime, /replacement_compose="\$fixture_root\/replacement\/docker-compose\.ghcr\.yml"/);
  assert.match(installerRuntime, /--replace-registration --compose-file "\$replacement_compose"/);
  assert.match(installerRuntime, /\[\[ "\$policy_before" != "\$\(sha256sum "\$policy_path"/);
  assert.match(installerRuntime, /\/usr\/bin\/node - "\$replacement_compose"/);
  assert.match(installer, /"\$helper" register "\$compose_file"/);
  assert.match(installerStep, /timeout-minutes: 10/);
  assert.match(installerContainer, /YAWF_REQUIRE_DOCKER=1 requires a usable Docker daemon/);
  assert.match(installerContainer, /runContainerBundle/);
  assert.match(installerContainer, /a copied installer mutation cannot silently bypass fresh opt-in enablement/);
  assert.match(installerContainer, /cpSync\(updaterDirectory, bundle, \{ recursive: true \}\)/);
  assert.match(installerContainer, /assert\.equal\(original\.split\(enableInvocation\)\.length - 1, 1/);
  assert.match(installerContainer, /original\.replace\(enableInvocation, '\"\$helper\" status'\)/);
  assert.match(installerContainer, /assert\.notEqual\(result\.status, 0, output\)/);
  assert.match(installerContainer, /assert\.match\(output, \/fresh opt-in did not enable registered policy\//);
  assert.match(installerContainer, /fresh opt-in did not enable registered policy/);
  assert.match(installerContainer, /case_explicit_replacement_uses_second_protected_target/);
  assert.match(installerContainer, /--replace-registration --compose-file "\$second"/);
});

test("updater transaction pipelines cannot hide a failed Node process behind tee", () => {
  for (const [name, step] of [["synthetic", syntheticStep], ["actual", actualStep]]) {
    assert.match(step, /set -euo pipefail/, `${name} updater step does not enable pipefail`);
    assert.match(step, /2>&1 \| tee "\$raw"/, `${name} updater step does not retain raw failure output`);
    assert.match(step, /test -s "\$receipt"/, `${name} updater step accepts an empty receipt`);
  }
  assert.match(syntheticStep, /sudo \/usr\/bin\/node scripts\/server_updater_compose_integration\.mjs/,
    "synthetic integration does not run as root for root-owned fixture cleanup");
});

test("separate receipt validators require identity and every transaction claim", () => {
  for (const field of ["result.ok", "result.mode", "result.version", "result.digest", "result.source"]) {
    assert.match(actualStep, new RegExp(`assert\\.equal\\(${field.replace(".", "\\.")}`), `actual receipt does not validate ${field}`);
  }
  for (const claim of ["digestVerified", "sourceVerified", "candidateHealthVerified", "injectedRollbackVerified",
    "activePlaybackDeferred", "successfulUpdateVerified", "stopFailureVerified", "snapshotFailureVerified",
    "interruptedRecoveryVerified", "registrationDriftPreserved", "ownershipAndDatabaseWriteVerified", "otherServicePreserved",
    "protectedFilesPreserved", "umask077PublicStatusVerified", "nonRootReadOnlyStatusVerified"]) {
    assert.ok(actualStep.includes(`\"${claim}\"`), `actual receipt validator omits ${claim}`);
  }
  assert.match(actualStep, /assert\.equal\(result\.digest, expectedDigest\)/);
  assert.match(actualStep, /assert\.equal\(result\.source, expectedSource\)/);
  assert.match(actualStep, /assert\.equal\(result\.version, expectedVersion\)/);
  assert.match(actualStep, /writeFileSync\(receipt,[\s\S]*mode: 0o600/);
  assert.match(syntheticStep, /assert\.equal\(result\.mode, "transaction-primitive"\)/);
  assert.match(syntheticStep, /assert\.match\(result\.digest, \/\^sha256:/);
  assert.match(syntheticStep, /assert\.equal\(result\.source, "generated-user-node-fixtures"\)/);
  assert.match(syntheticStep, /assert\.equal\(result\.version, expectedVersion\)/);
  assert.match(syntheticStep, /"protectedFilesPreserved"/);
  assert.match(syntheticStep, /writeFileSync\(receipt,[\s\S]*mode: 0o600/);
});

test("interrupted transaction evidence proves stopped state and journal identity", () => {
  assert.match(integration, /composeRun\("ps", "--all", "--quiet", service\)/);
  assert.match(integration, /docker\("inspect", "--format", "\{\{\.State\.Running\}\}"/);
  assert.match(integration, /assert\.equal\(interruptedRunning, "false"/);
  assert.match(integration, /assert\.equal\(interruptedStatus, "exited"/);
  assert.match(integration, /assert\.equal\(interruptedJournal\.phase, "snapshotted"/);
  assert.match(integration, /assert\.deepEqual\(interruptedJournal\.registration, expectedRegistration/);
  assert.match(integration, /diagnostic: "interrupted-transaction"/);
  assert.match(integration, /assert\.equal\(existsSync\(journalPath\), false/);
  assert.match(integration, /diagnostic: "pre-snapshot-fault"/);
  assert.match(integration, /assert\.equal\(failedStatus\.state, "failed"/);
  assert.match(integration, /assert\.equal\(failedPolicy\.inhibitedVersion, candidateVersion/);
  assert.match(integration, /assert\.equal\(journalPending, false/);
});

test("post-health rollback cannot pass unless the injected mutation was reached", () => {
  assert.match(transactionDriver, /let faultReached = false/);
  assert.match(transactionDriver, /writeFileSync\(policy\.envPath,[\s\S]*faultReached = true;[\s\S]*throw new Error\("Injected post-health failure\."\)/);
  assert.match(transactionDriver, /if \(fault === "after-health"\) assert\.equal\(faultReached, true/);
  assert.match(integration, /assert\.equal\(rollbackStatus\.state, "rolled_back"/);
  assert.match(integration, /assert\.equal\(rollbackPolicy\.inhibitedVersion, candidateVersion/);
});

test("integration emits structured synthetic and actual receipts", () => {
  assert.match(integration, /process\.umask\(0o077\)/);
  assert.match(integration, /mode: "actual-published-images", version: candidateVersion, digest: actualCandidateDigest/);
  assert.match(integration, /source: actualSourceRevision/);
  assert.match(integration, /digestVerified: true, sourceVerified: true/);
  assert.match(integration, /umask077PublicStatusVerified: true, nonRootReadOnlyStatusVerified: true/);
  assert.match(integration, /mode: "transaction-primitive", version: candidateVersion, digest: newImage/);
  assert.match(integration, /source: "generated-user-node-fixtures"/);
  assert.match(integration, /fixtureDigestVerified: true, fixtureSourceVerified: true/);
});

test("candidate version follows server package metadata instead of a frozen release", () => {
  assert.match(integration, /server\/package\.json/);
  assert.match(transactionDriver, /server\/package\.json/);
  assert.doesNotMatch(integration, /2\.3\.(?:9|10)/);
  assert.doesNotMatch(transactionDriver, /2\.3\.(?:9|10)/);
  assert.doesNotMatch(workflow, /2\.3\.(?:9|10)/);
});

test("actual transaction proves umask-safe nonroot read-only status access", () => {
  assert.match(integration, /process\.umask\(0o077\)/);
  assert.match(integration, /lstatSync\("\/var\/lib\/yawf-server-updater\/public"\)/);
  assert.match(integration, /lstatSync\("\/var\/lib\/yawf-server-updater\/public\/status\.json"\)/);
  assert.match(integration, /"--user", "node"/);
  assert.match(integration, /source=\/var\/lib\/yawf-server-updater\/public,target=\/updater-status,readonly/);
  assert.match(integration, /writeBlocked=true/);
  assert.match(integration, /umask077PublicStatusVerified: true, nonRootReadOnlyStatusVerified: true/);
});

test("volume copier uses bounded no-follow descriptor streaming and explicit metadata order", () => {
  assert.doesNotMatch(volumeCopy, /copyFileSync/);
  assert.match(volumeCopy, /const COPY_BUFFER_BYTES = 64 \* 1024/);
  assert.match(volumeCopy, /openSync\(from, constants\.O_RDONLY \| constants\.O_NOFOLLOW\)/);
  assert.match(volumeCopy, /constants\.O_WRONLY \| constants\.O_CREAT \| constants\.O_EXCL \| constants\.O_NOFOLLOW/);
  assert.match(volumeCopy, /while \(written < count\)[\s\S]*writeSync\(destinationFd, buffer, written, count - written/);
  assert.match(volumeCopy, /fstatSync\(sourceFd\)[\s\S]*sameSource\(expected, after\)/);
  assert.match(volumeCopy, /finally \{[\s\S]*closeSync\(destinationFd\)[\s\S]*finally \{[\s\S]*closeSync\(sourceFd\)/);
  assert.match(volumeCopy, /fchmodSync\(fd, desiredMode\)[\s\S]*fchownSync\(fd, stat\.uid, stat\.gid\)/,
    "the copier must set ordinary mode bits before giving ownership away without FOWNER");
  assert.match(volumeCopy, /mode === "copy" \? \["\/data", "\/backup\/data"\][\s\S]*mode === "restore" \? \["\/backup\/data", "\/data"\]/);
  assert.match(volumeCopy, /Snapshot root must be a directory/);
  assert.match(volumeCopy, /Snapshot destination root must be a directory/);
});

test("Compose copier proof retains minimal capabilities and protected multi-chunk fixtures", () => {
  const capabilityContract = /"--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN"/;
  assert.match(updater, capabilityContract);
  assert.match(integration, capabilityContract);
  assert.doesNotMatch(updater, /FOWNER/);
  assert.doesNotMatch(integration, /FOWNER/);
  assert.match(integration, /updater-private-fixture','private',\{mode:0o600\}/);
  assert.match(integration, /updater-readonly-fixture',Buffer\.alloc\(\(64\*1024\*3\)\+17,0x5a\),\{mode:0o400\}/);
  assert.match(integration, /private-key','secret',\{mode:0o600\}/);
  assert.match(integration, /protected-payload',Buffer\.alloc\(\(64\*1024\*3\)\+17,0x5a\),\{mode:0o400\}/);
  assert.match(integration, /createHash\('sha256'\)\.update\(f\.readFileSync\(p\)\)\.digest\('hex'\)/);
  assert.match(integration, /protectedFilesPreserved: true/);
});
