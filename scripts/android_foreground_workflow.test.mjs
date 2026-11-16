import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/android-foreground-qa.yml", import.meta.url), "utf8");
const driver = readFileSync(new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeForegroundPlaybackFlowTest.java",
  import.meta.url,
), "utf8");
const validator = readFileSync(new URL("./android_foreground_playback_receipt.mjs", import.meta.url), "utf8");

function replaceUnique(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Mutation target is not unique: ${before}`);
  const changed = source.replace(before, after);
  assert.notEqual(changed, source);
  return changed;
}

function contract(source) {
  assert.match(source, /^name: Android foreground playback QA$/m);
  assert.match(source, /push:[\s\S]*branches:[\s\S]*codex\/android-foreground114-qa[\s\S]*codex\/android-foreground114-full-qa/);
  for (const path of [
    ".github/workflows/android-foreground-qa.yml",
    "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeForegroundPlaybackFlowTest.java",
    "scripts/android_foreground_playback_receipt.mjs",
    "scripts/android_foreground_playback_receipt.test.mjs",
    "scripts/android_foreground_workflow.test.mjs",
  ]) assert.ok(source.includes(`- ${path}`));
  assert.match(source, /workflow_dispatch:[\s\S]*run_mode:[\s\S]*options: \[admission, full\]/);
  assert.match(source, /playback_case:[\s\S]*options: \[direct, hls\]/);
  assert.match(source, /permissions:\n  contents: read/);
  assert.doesNotMatch(source, /pull_request:|schedule:|contents: write|packages: write/);
  assert.equal((source.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.doesNotMatch(source, /secrets\.|github-token:|token:|authorization|bearer/i);
  assert.match(source, /github\.repository_owner == 'Tgk-30'/);
  assert.match(source, /github\.repository == 'Tgk-30\/YAWF-Stream'/);
  assert.match(source, /github\.actor == github\.repository_owner/);
  assert.match(source, /github\.ref_type == 'branch'/);
  assert.match(source, /github\.ref_name == 'codex\/android-foreground114-qa'/);
  assert.match(source, /github\.ref_name == 'codex\/android-foreground114-full-qa'/);
  assert.match(source, /playback_case: \$\{\{ github\.event_name == 'push' && fromJSON\('\["direct","hls"\]'\)/);
  assert.match(source, /inputs\.playback_case \|\| 'direct'/);
  assert.match(source, /REQUESTED_MODE: \$\{\{ github\.event_name == 'push' && github\.ref_name == 'codex\/android-foreground114-full-qa' && 'full'/);
  assert.match(source, /inputs\.run_mode == 'full' && 'full' \|\| 'admission'/);
  assert.match(source, /REQUESTED_CASE: \$\{\{ matrix\.playback_case \}\}/);

  assert.match(source, /PUBLIC_VERSION: 2\.3\.105/);
  assert.match(source, /PUBLIC_VERSION_CODE: "2003105"/);
  assert.match(source, /PUBLIC_APK_BYTES: "88812417"/);
  assert.match(source, /PUBLIC_APK_SHA256: c585e5f3344fd9c0cdef28e30ddb44f6ca355540088461e95fe0503695ff00b4/);
  assert.match(source, /PUBLIC_SOURCE_SHA: 017098f3c609c0b275d91d0f658f77b1d371eaef/);
  assert.match(source, /FIXTURE_SOURCE_SHA: 25574d680ec58ce96975014c5e7f6e35a4b87b01/);
  assert.match(source, /github\.com\/Tgk-30\/YAWF-Stream\/releases\/download\/android-v2\.3\.105\/YAWF\.Stream_Android_2\.3\.105\.apk/);
  assert.match(source, /--proto '=https' --proto-redir '=https'/);
  assert.match(source, /--connect-timeout 15 --max-time 180/);
  assert.match(source, /--max-filesize "\$PUBLIC_APK_BYTES" --retry 3 --retry-all-errors/);
  assert.match(source, /test "\$\(wc -c < "\$apk" \| tr -d ' '\)" = "\$PUBLIC_APK_BYTES"/);
  assert.match(source, /printf '%s  %s\\n' "\$PUBLIC_APK_SHA256" "\$apk" \| sha256sum --check -/);
  assert.match(source, /--certificate-pin public-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(source, /test "\$\("\$\{adb_cmd\[@\]\}" shell sha256sum "\$installed" \| awk '\{print \$1\}'\)" = "\$PUBLIC_APK_SHA256"/);

  assert.match(source, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64/);
  assert.match(source, /AVD_NAME: yawf-foreground-phone105-api36/);
  assert.match(source, /EMULATOR_SERIAL: emulator-5568/);
  assert.match(source, /^      ADB_SERVER_PORT: "5142"$/m);
  assert.match(source, /ADB_SERVER_SOCKET: tcp:127\.0\.0\.1:5142/);
  assert.match(source, /ss -ltnH \| awk '\{print \$4\}' \| grep -Eq '\(\^\|:\)\(5037\|5142\|5568\|5569\)\$'/);
  assert.match(source, /Refusing an existing ADB or emulator listener on any bind address/);
  assert.match(source, /test "\$free_bytes" -ge \$\(\(12 \* 1024 \* 1024 \* 1024\)\)/);
  assert.match(source, /test "\$free_bytes" -ge \$\(\(6 \* 1024 \* 1024 \* 1024\)\)/);
  assert.match(source, /test -z "\$\(adb -H 127\.0\.0\.1 -P "\$ADB_SERVER_PORT" devices/);
  assert.ok(source.includes(
    'mapfile -t adb_pids < <(ss -ltnp | grep -E "127\\\\.0\\\\.0\\\\.1:${ADB_SERVER_PORT}[[:space:]]"',
  ));
  assert.ok(source.includes("| sed -nE 's/.*pid=([0-9]+),.*/\\1/p' | sort -u)"));
  assert.match(source, /test "\$\{#adb_pids\[@\]\}" -eq 1/);
  assert.ok(source.includes('setsid adb -L "tcp:${ADB_SERVER_PORT}" --one-device "$EMULATOR_SERIAL" server nodaemon'));
  assert.match(source, /adb_pid=\$!\n          adb_initial_identity="\$\(process_identity "\$adb_pid"\)"/);
  assert.ok(source.includes('adb_uid="${adb_initial_identity%%:*}"'));
  assert.ok(source.includes('adb_start="${adb_initial_identity##*:}"'));
  assert.ok(source.includes('test "$adb_uid" = "$(id -u)"'));
  assert.match(source, /deadline=\$\(\(SECONDS \+ 15\)\)\n          while :; do\n            current="\$\(process_identity "\$adb_pid"\)"\n            test "\$\{current%%:\*\}" = "\$adb_uid"\n            test "\$\{current##\*:\}" = "\$adb_start"/);
  assert.ok(source.includes('if [ "$current" = "$adb_uid:$adb_pid:$adb_start" ]; then\n              adb_identity="$current"'));
  assert.ok(source.includes('          done\n          test "$adb_identity" = "$adb_uid:$adb_pid:$adb_start"\n          test "${#adb_pids[@]}" -eq 1\n          test "${adb_pids[0]}" = "$adb_pid"'));
  assert.match(source, /adb_identity="\$\(process_identity "\$adb_pid"\)"/);
  assert.match(source, /test "\$\{adb_identity%%:\*\}" = "\$\(id -u\)"/);
  assert.equal(source.split(
    'ss -ltnp | grep -Eq "127\\\\.0\\\\.0\\\\.1:${ADB_SERVER_PORT}.*pid=${adb_pid},"',
  ).length - 1, 2);
  assert.match(source, /setsid emulator -avd "\$AVD_NAME" -port 5568/);
  assert.match(source, /-no-window -no-audio -no-snapshot/);
  assert.match(source, /adb -H 127\.0\.0\.1 -P "\$ADB_SERVER_PORT" -s "\$EMULATOR_SERIAL"/);
  assert.match(source, /uses: actions\/setup-node@v4[\s\S]*node-version: "24\.22\.3"[\s\S]*check-latest: false/);
  assert.match(source, /apt-get install -y --no-install-recommends libpulse0 ffmpeg fonts-dejavu-core/);
  assert.match(source, /section in \{'installed','available'\}/);
  assert.match(source, /assert sections, 'Official SDK metadata did not advertise the exact installed or available image path'/);
  assert.match(source, /shell getprop ro\.boot\.qemu\.avd_name/);
  assert.doesNotMatch(source, /emu avd name/);
  assert.match(source, /reverse tcp:43120 tcp:43120/);
  assert.match(source, /reverse tcp:43121 tcp:43121/);
  assert.match(source, /reverse --remove tcp:43120/);
  assert.match(source, /reverse --remove tcp:43121/);
  assert.match(source, /process_identity\(\)/);
  assert.ok(source.includes('trap - EXIT ERR'));
  assert.ok(source.includes('ANDROID_QA_REFUSED_LINE=%d EXIT=%d\\n'));
  assert.match(source, /snapshot_owned_group\(\)/);
  assert.match(source, /stat\[2\].*stat\[19\]/);
  assert.match(source, /fixture_identity="\$\(process_identity "\$fixture_pid"\)"/);
  assert.match(source, /emulator_identity="\$\(process_identity "\$emulator_pid"\)"/);
  assert.match(source, /current="\$\(process_identity "\$leader"\)" \|\| return 1/);
  assert.match(source, /\[ "\$current" = "\$expected" \] \|\| return 1/);
  assert.match(source, /current="\$\(process_identity "\$pid" 2>\/dev\/null\)" \|\| continue/);
  assert.match(source, /\[ "\$current" = "\$\(id -u\):\$leader:\$start" \] \|\| continue/);
  assert.match(source, /stop_owned_group "\$emulator_pid" "\$emulator_identity" \|\| status=1/);
  assert.match(source, /current="\$\(process_identity "\$emulator_pid" 2>\/dev\/null\)"[\s\S]*if \[ "\$current" = "\$emulator_identity" \]; then[\s\S]*reverse --remove tcp:43120/);
  assert.match(source, /stop_owned_group "\$fixture_pid" "\$fixture_identity" \|\| status=1/);
  assert.match(source, /stop_owned_adb \|\| status=1/);
  assert.equal((source.match(/\[ "\$current" = "\$adb_identity" \] \|\| return 1/g) ?? []).length, 2);

  assert.match(source, /--foreground-long --ipad-foreground/);
  assert.ok(source.includes('randomBytes(32).toString("hex")'));
  assert.ok(source.includes('test "${#ipad_qa_control_token}" -eq 64'));
  assert.ok(source.includes('test -z "${ipad_qa_control_token//[0-9a-f]/}"'));
  assert.ok(source.includes('IPAD_QA_CONTROL_TOKEN="$ipad_qa_control_token" setsid node'));
  assert.ok(source.includes('--import "$GITHUB_WORKSPACE/fixture-source/server/node_modules/tsx/dist/loader.mjs"'));
  assert.ok(source.includes('"$GITHUB_WORKSPACE/fixture-source/scripts/android_external_player_server_fixture.mts"'));
  assert.doesNotMatch(source, /tsx\/dist\/cli\.mjs/);
  assert.ok(source.includes('ss -ltnp | grep "pid=$fixture_pid," > "$RUNNER_TEMP/fixture-listeners.txt"'));
  assert.match(source, /fixture_pid=\$!\n          unset ipad_qa_control_token/);
  assert.match(source, /--repo "\$GITHUB_WORKSPACE\/fixture-source"/);
  assert.match(source, /127\\\.0\\\.0\\\.1:43120/);
  assert.match(source, /127\\\.0\\\.0\\\.1:43121/);
  assert.match(source, /'deviceExternalEgressBlocked':False/);
  assert.match(source, /'fixtureListenersLoopbackOnly':True/);
  assert.doesNotMatch(source, /deviceExternalEgressBlocked':True|zeroDeviceEgress|network=none/);
  assert.match(source, /test -s "\$fixture_output\/ipad-observations\.jsonl"/);
  assert.doesNotMatch(source, /cp .*ipad-observations|--observer /);

  assert.match(source, /RuntimeForegroundPlaybackFlowTest/);
  assert.match(source, /mode="\$REQUESTED_MODE"/);
  assert.match(source, /playback_case="\$REQUESTED_CASE"/);
  assert.match(source, /-e playbackMode "\$mode"/);
  assert.match(source, /-e playbackCase "\$playback_case"/);
  assert.match(source, /case "\$mode" in admission\) instrument_timeout=300;; full\) instrument_timeout=900/);
  assert.doesNotMatch(source, /RuntimeExternalPlayerFlowTest|VLC|org\.videolan|externalHandler/);
  assert.doesNotMatch(source, /logcat|uiautomator dump|dumpWindowHierarchy|screencap/);
  assert.doesNotMatch(source, /pm grant|appops|adb root|settings put|run-as com\.tgk30/);

  assert.match(source, /count=5 if os\.environ\['MODE'\]=='full' else 2/);
  assert.match(source, /expected\.add\('instrumentation-foreground-playback-receipt\.json'\)/);
  assert.match(source, /assert set\(names\)==expected/);
  assert.match(source, /assert total<=40\*1024\*1024\+64\*1024/);
  assert.match(source, /--evidence-dir "\$EVIDENCE" --output "\$EVIDENCE\/native-stage-summary\.json"/);
  assert.match(source, /assert result\['outcome'\]=='observer-abi-unintegrated'/);
  assert.match(source, /result\['hostedAdmission'\] is False and result\['fullQualification'\] is False/);
  assert.match(source, /'observerAbiIntegrated':False/);
  assert.match(source, /'runtimePublished':False/);
  assert.ok(source.includes(
    "            'runtimePublished':False,\n" +
    "            'hostedAdmission':False,\n" +
    "            'fullQualification':False,\n" +
    "            'observerAbiIntegrated':False,"
  ));
  assert.match(source, /assert total<=42\*1024\*1024/);
  assert.match(source, /retention-days: 7/);
  assert.match(source, /if: success\(\)/);
}

test("workflow is a manual, public, credential-free native UI observation", () => {
  contract(workflow);
});

function resolvedMode(eventName, branch, input) {
  if (eventName === "push" && branch === "codex/android-foreground114-full-qa") return "full";
  if (eventName === "workflow_dispatch" && input === "full") return "full";
  return "admission";
}

test("ordinary QA branch push is an admission matrix and missing input is never full", () => {
  assert.equal(resolvedMode("push", "codex/android-foreground114-qa", undefined), "admission");
  assert.equal(resolvedMode("workflow_dispatch", "codex/android-foreground114-qa", undefined), "admission");
  assert.match(workflow, /fromJSON\('\["direct","hls"\]'\)/);
});

test("only full branch push or explicit manual full input selects the 480 second mode", () => {
  assert.equal(resolvedMode("push", "codex/android-foreground114-full-qa", undefined), "full");
  assert.equal(resolvedMode("workflow_dispatch", "codex/android-foreground114-qa", "full"), "full");
  assert.equal(resolvedMode("push", "some-other-branch", "full"), "admission");
});

test("workflow does not promote native Stage 1 evidence into observer admission", () => {
  assert.match(validator, /outcome: "observer-abi-unintegrated"/);
  assert.match(validator, /hostedAdmission: false/);
  assert.match(validator, /fullQualification: false/);
  assert.match(validator, /stage2-schema-and-sealed-window-required/);
  assert.match(driver, /receipt\.put\("stage2ObserverAbiIntegrated", false\)/);
  assert.match(driver, /receipt\.put\("instrumentationWebViewAccessUsed", false\)/);
  assert.match(driver, /receipt\.put\("serverPassiveObserverUsed", true\)/);
});

test("workflow contract rejects public artifact substitution", () => {
  const changed = workflow.replace(
    "c585e5f3344fd9c0cdef28e30ddb44f6ca355540088461e95fe0503695ff00b4",
    "0".repeat(64),
  );
  assert.throws(() => contract(changed));
});

test("workflow contract rejects qualification inflation", () => {
  const changed = replaceUnique(workflow,
    "            'hostedAdmission':False,", "            'hostedAdmission':True,");
  assert.throws(() => contract(changed));
});

test("workflow contract rejects removal of the private ADB port", () => {
  const changed = replaceUnique(workflow,
    '      ADB_SERVER_PORT: "5142"', '      ADB_SERVER_PORT: "5037"');
  assert.throws(() => contract(changed));
});

test("workflow contract rejects a missing fixture control token assignment", () => {
  const changed = replaceUnique(workflow,
    'IPAD_QA_CONTROL_TOKEN="$ipad_qa_control_token" setsid node', 'setsid node');
  assert.throws(() => contract(changed));
});

test("workflow contract rejects a broader evidence inventory", () => {
  const changed = workflow.replace(
    "expected.add('instrumentation-foreground-playback-receipt.json')",
    "expected.update(names)",
  );
  assert.throws(() => contract(changed));
});

test("workflow contract rejects credential persistence", () => {
  const changed = workflow.replace("persist-credentials: false", "persist-credentials: true");
  assert.throws(() => contract(changed));
});

test("workflow contract catches hosted admission and cleanup regressions", () => {
  const mutations = [
    ["github.repository == 'Tgk-30/YAWF-Stream'", "github.repository == 'Tgk-30/DebridStreamer'"],
    ["github.actor == github.repository_owner", "true"],
    ['node-version: "24.22.3"', 'node-version: "24"'],
    ["libpulse0 ffmpeg fonts-dejavu-core", "libpulse0"],
    ["section in {'installed','available'}", "section=='available'"],
    ['--max-filesize "$PUBLIC_APK_BYTES"', ""],
    ["(5037|5142|5568|5569)", "(5037)"],
    ['adb_pid=$!', 'adb_pid=1'],
    [
      'setsid adb -L "tcp:${ADB_SERVER_PORT}" --one-device "$EMULATOR_SERIAL" server nodaemon',
      'adb -H 127.0.0.1 -P "$ADB_SERVER_PORT" start-server',
    ],
    [
      '          done\n          test "$adb_identity" = "$adb_uid:$adb_pid:$adb_start"\n          test "${#adb_pids[@]}" -eq 1\n          test "${adb_pids[0]}" = "$adb_pid"',
      '          done\n          test "$adb_identity" = "$adb_uid:$adb_pid:$adb_start"\n          test "${#adb_pids[@]}" -eq 1',
    ],
    [
      '            test "${current##*:}" = "$adb_start"',
      '            : # server birth identity check removed',
    ],
    ['test "${current%%:*}" = "$adb_uid"', ': # server UID check removed'],
    ['if [ "$current" = "$adb_uid:$adb_pid:$adb_start" ]; then', 'if true; then'],
    [
      '--import "$GITHUB_WORKSPACE/fixture-source/server/node_modules/tsx/dist/loader.mjs"',
      '"$GITHUB_WORKSPACE/fixture-source/server/node_modules/tsx/dist/cli.mjs"',
    ],
    ['ss -ltnp | grep "pid=$fixture_pid,"', 'ss -ltnp'],
    [
      'ss -ltnp | grep -Eq "127\\\\.0\\\\.0\\\\.1:${ADB_SERVER_PORT}.*pid=${adb_pid},"',
      ': # listener ownership guard removed',
    ],
    ['[ "$current" = "$adb_identity" ] || return 1', ': # ADB identity guard removed'],
    ["shell getprop ro.boot.qemu.avd_name", "emu avd name"],
    ['reverse tcp:43121 tcp:43121', ""],
    ['stop_owned_group "$fixture_pid" "$fixture_identity" || status=1', 'kill -TERM "$fixture_pid"'],
  ];
  for (const [before, after] of mutations) {
    const changed = workflow.replace(before, after);
    assert.notEqual(changed, workflow, `Mutation did not apply: ${before}`);
    assert.throws(() => contract(changed), `Mutation escaped contract: ${before}`);
  }
});
