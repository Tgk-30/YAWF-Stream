import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before } from "node:test";

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

function safeDetailsOpeningContract(source) {
  const start = source.indexOf("private void openDetailsOnce()");
  const end = source.indexOf("private UiObject2 waitForUniquePlayerDialog", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const refresh = body.indexOf(
    'assertTrue("Accessibility cache refresh failed while opening player details",',
  );
  const clearCache = body.indexOf("instrumentation.getUiAutomation().clearCache()", refresh);
  const noApproval = body.indexOf("assertNoOutOfScopeApproval()", clearCache);
  const foreground = body.indexOf(
    'assertEquals("Product package lost foreground ownership while opening player details",',
    noApproval,
  );
  const player = body.indexOf("findUniqueExactProductDialog(PLAYER_DIALOG_LABEL)", foreground);
  const playerVisible = body.indexOf("player == null || !hasVisibleBounds(player)", player);
  const details = body.indexOf(
    "findLabeledClickableWithin(player, DETAILS_LABEL, DETAILS_LABEL)",
    playerVisible,
  );
  const visible = body.indexOf("details != null && hasVisibleBounds(details)", details);
  const exactClick = body.indexOf("details.click();", visible);
  for (const [name, index] of Object.entries({
    refresh,
    clearCache,
    noApproval,
    foreground,
    player,
    playerVisible,
    details,
    visible,
    exactClick,
  })) assert.ok(index >= 0, `Missing safe details-opening marker: ${name}`);
  assert.ok(refresh < clearCache && clearCache < noApproval);
  assert.ok(noApproval < foreground && foreground < player);
  assert.ok(player < playerVisible && playerVisible < details);
  assert.ok(details < visible && visible < exactClick);
  const staleCatch = body.indexOf('catch (StaleObjectException stale)', visible);
  const retryContinue = body.indexOf('continue;', staleCatch);
  assert.ok(staleCatch > visible && staleCatch < retryContinue && retryContinue < exactClick);
  assert.match(body, /details != null && hasVisibleBounds\(details\) && details\.isEnabled\(\)/);
  assert.doesNotMatch(body.slice(refresh, staleCatch), /guardedClick\(|\.click\(\)/);
  assert.doesNotMatch(body, /catch \(AssertionError|catch \(Exception/);
  assert.match(body.slice(visible, staleCatch), /!noInputWindowStarted[\s\S]*assertNoOutOfScopeApproval\(\)[\s\S]*assertNotNull\([^\n]*details\)[\s\S]*details\.isEnabled\(\)/);
  assert.doesNotMatch(body.slice(staleCatch, exactClick), /isEnabled\(\)|hasVisibleBounds\(/);
  assert.equal((body.match(/details\.click\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(body, /guardedClick\(player|player::click|player\.click\(/);
  assert.match(body, /SystemClock\.uptimeMillis\(\) \+ MEDIA_WAIT_MS/);
}

function safeDetailsWaitContract(source) {
  const start = source.indexOf("private UiObject2 waitForUniqueDetailsDialog(long timeoutMs)");
  const end = source.indexOf("private UiObject2 requireUniqueDetailsDialog", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const deadline = body.indexOf("SystemClock.uptimeMillis() + timeoutMs");
  const refresh = body.indexOf(
    'assertTrue("Accessibility cache refresh failed while waiting for player details",',
    deadline,
  );
  const clearCache = body.indexOf("instrumentation.getUiAutomation().clearCache()", refresh);
  const noApproval = body.indexOf("assertNoOutOfScopeApproval()", clearCache);
  const foreground = body.indexOf(
    'assertEquals("Product package lost foreground ownership while waiting for player details",',
    noApproval,
  );
  const dialog = body.indexOf("findUniqueExactProductDialog(DETAILS_LABEL)", foreground);
  const visible = body.indexOf("dialog != null && hasVisibleBounds(dialog)", dialog);
  for (const [name, index] of Object.entries({
    deadline,
    refresh,
    clearCache,
    noApproval,
    foreground,
    dialog,
    visible,
  })) assert.ok(index >= 0, `Missing safe details-wait marker: ${name}`);
  assert.ok(deadline < refresh && refresh < clearCache && clearCache < noApproval);
  assert.ok(noApproval < foreground && foreground < dialog && dialog < visible);
  assert.doesNotMatch(body, /guardedClick\(|\.click\(\)|::click|device\.click\(/);
}

function noPlayerSurfaceInputContract(source) {
  assert.doesNotMatch(source, /player::click|guardedClick\(player|player\.click\(/);
  const start = source.indexOf("private void openPlaybackSettingsTransaction()");
  const end = source.indexOf("private UiObject2 scrollPlaybackSettingsUntilLabeledClickable", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /Observation\.settings\(settings::click\)/);
  assert.equal((body.match(/Observation\.waiting\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(body, /Observation\.reveal\(/);
  assert.match(body, /MEDIA_WAIT_MS/);
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
    "scripts/android_foreground_refusal.py",
    "scripts/android_foreground_refusal_test.py",
    "scripts/android_foreground_observer_diagnostic.mjs",
    "scripts/android_foreground_observer_diagnostic.test.mjs",
  ]) assert.ok(source.includes(`- ${path}`));
  assert.match(source, /workflow_dispatch:[\s\S]*run_mode:[\s\S]*options: \[admission, full\]/);
  assert.match(source, /playback_case:[\s\S]*options: \[direct, hls, auto-mkv\]/);
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
  assert.match(source, /FIXTURE_SOURCE_SHA: d477d2a3eb2977c429c0a3b1a9128374536075cd/);
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
  assert.match(source, /adb_initial_identity="\$\(process_identity "\$adb_pid"\)"/);
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
  assert.match(source, /if: always\(\)/);
  assert.match(source, /python3 -I -B scripts\/android_foreground_refusal_test\.py/);
  const refusalParser = source.indexOf(
    'python3 -I -B scripts/android_foreground_refusal.py \\\n' +
    '            --input "$RUNNER_TEMP/instrumentation.txt" --output "$EVIDENCE/refusal.json"',
  );
  const boundedCopy = source.indexOf(
    'EVIDENCE="$EVIDENCE" MODE="$mode" CASE="$playback_case" PRESENTATION="$presentation" NATIVE_TEST_OK="$native_test_ok" python3',
    refusalParser,
  );
  const authoritativeStatus = source.indexOf('test "$instrumentation_status" -eq 0', boundedCopy);
  const authoritativeOk = source.indexOf('grep -Fq \'OK (1 test)\' "$RUNNER_TEMP/instrumentation.txt"', authoritativeStatus);
  const nativeValidator = source.indexOf('node scripts/android_foreground_playback_receipt.mjs', authoritativeOk);
  assert.ok(refusalParser >= 0 && refusalParser < boundedCopy);
  assert.ok(boundedCopy < authoritativeStatus && authoritativeStatus < authoritativeOk);
  assert.ok(authoritativeOk < nativeValidator);
  assert.match(source, /if os\.environ\['NATIVE_TEST_OK'\]=='true':\s*assert set\(names\)==expected/);
  assert.match(source, /if os\.environ\['PRESENTATION'\]=='normal-diagnostic':\s*expected=\{f"normal-anchor-/);
  assert.match(source, /elif os\.environ\['PRESENTATION'\]=='normal-diagnostic':\s*assert set\(names\)<=expected and receipt in names/);
  assert.match(source, /else:\s*assert set\(names\)<=expected and 'instrumentation-foreground-playback-receipt\.json' in names/);
  assert.match(source, /assert len\(names\)==len\(set\(names\)\), 'Duplicate native evidence filename'/);
  assert.match(source, /FIXTURE_VALIDATOR="\$GITHUB_WORKSPACE\/fixture-source\/scripts\/ipad-foreground\/passive_observer\.mjs"/);
  const observerExport = source.indexOf('node scripts/android_foreground_observer_diagnostic.mjs', refusalParser);
  assert.ok(refusalParser < observerExport && observerExport < boundedCopy);
  assert.match(source, /--input "\$fixture_output\/ipad-observations\.jsonl"/);
  assert.match(source, /--validator "\$GITHUB_WORKSPACE\/fixture-source\/scripts\/ipad-foreground\/passive_observer\.mjs"/);
  assert.match(source, /--output "\$EVIDENCE\/passive-observations\.json"/);
  assert.match(source, /evidence_bytes\+=len\(data\); assert evidence_bytes<=42\*1024\*1024/);
  assert.match(source, /path: android-foreground-evidence/);
  assert.doesNotMatch(source, /path:.*instrumentation\.txt/);
}

// A broken positive contract must never make negative mutations appear causal.
before(() => contract(workflow));

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

test("native refusal metadata is one bounded public status diagnostic", () => {
  assert.equal((driver.match(/instrumentation\.sendStatus\(/g) ?? []).length, 1);
  assert.equal((driver.match(/yawfForegroundRefusalPhase/g) ?? []).length, 1);
  assert.equal((driver.match(/yawfForegroundRefusalClass/g) ?? []).length, 1);
  assert.equal((driver.match(/yawfForegroundRefusalSite/g) ?? []).length, 1);
  assert.equal((driver.match(/yawfForegroundRefusalLine/g) ?? []).length, 1);
  assert.match(driver, /SAFE_FAILURE_CLASS\.matcher\(simpleName\)\.matches\(\) \? simpleName : "OtherThrowable"/);
  assert.match(driver, /MAX_REFUSAL_SITE_FRAMES = 16/);
  for (const phase of [
    "not-started", "launching-product", "server-login", "source-selection", "selecting-480p",
    "opening-read-only-details", "measured-no-input-window", "native-observation-complete",
  ]) assert.match(driver, new RegExp(`case "${phase}":`));
  assert.match(driver, /default:\s*return "unrecognized"/);
  const diagnostic = driver.slice(
    driver.indexOf("private void sendRefusalDiagnostic"),
    driver.indexOf("private String refusalPhase"),
  );
  assert.match(diagnostic, /Math\.min\(MAX_REFUSAL_SITE_FRAMES, frames\.length\)/);
  assert.match(diagnostic, /RuntimeForegroundPlaybackFlowTest\.class\.getName\(\)/);
  assert.match(diagnostic, /RuntimeExternalSettingsTransaction\.class\.getName\(\)/);
  assert.match(diagnostic, /flowClass\.equals\(frame\.getClassName\(\)\)[\s\S]*site = "native-flow"/);
  assert.match(diagnostic, /settingsClass\.equals\(frame\.getClassName\(\)\)[\s\S]*site = "settings-transaction"/);
  assert.match(diagnostic, /line < 1 \|\| line > 2000/);
  assert.match(diagnostic, /String site = "unknown";[\s\S]*int siteLine = 0;/);
  assert.doesNotMatch(
    diagnostic,
    /getMessage|getMethodName|getFileName|printStackTrace|REPORT_KEY_STREAMRESULT|https?:|FIXTURE_URL|USERNAME|PASSWORD|\.contains\(|\.startsWith\(|\.endsWith\(/,
  );
});

test("native timing starts only after the passive zero-baseline is sealed", () => {
  const start = driver.indexOf("private void runFlow() throws Exception");
  const end = driver.indexOf("private void launchProduct()", start);
  assert.ok(start >= 0 && end > start);
  const flow = driver.slice(start, end);
  const noInput = flow.indexOf("noInputWindowStarted = true");
  const ownership = flow.indexOf("assertForegroundOwnership()", noInput);
  const baselineStats = flow.indexOf("FrameSample first = readStats(details)", ownership);
  const timedStart = flow.indexOf("windowStartedMs = SystemClock.uptimeMillis()", baselineStats);
  const baselineSample = flow.indexOf("appendSample(first, 0)", timedStart);
  const baselineCapture = flow.indexOf("captureAnchor(1, 0)", baselineSample);
  const remainingAnchors = flow.indexOf("for (int index = 1; index < anchorCount; index++)", baselineCapture);
  for (const [name, index] of Object.entries({
    noInput,
    ownership,
    baselineStats,
    timedStart,
    baselineSample,
    baselineCapture,
    remainingAnchors,
  })) assert.ok(index >= 0, `Missing baseline timing marker: ${name}`);
  assert.ok(noInput < ownership && ownership < baselineStats && baselineStats < timedStart);
  assert.ok(timedStart < baselineSample && baselineSample < baselineCapture);
  assert.ok(baselineCapture < remainingAnchors);
  assert.doesNotMatch(flow.slice(noInput), /guardedClick\(|\.click\(\)|device\.click\(/);
  assert.match(validator, /receipt\.anchors\[0\]\.elapsedMs > 5_000/);
});

test("details opening refreshes observation and clicks only the exact visible control", () => {
  safeDetailsOpeningContract(driver);
});

test("details-opening contract catches missing refresh and generic player input", () => {
  safeDetailsOpeningContract(driver);
  const missingRefresh = replaceUnique(
    driver,
    'assertTrue("Accessibility cache refresh failed while opening player details",\n' +
      "                    instrumentation.getUiAutomation().clearCache());",
    'assertTrue("Accessibility cache refresh failed while opening player details", true);',
  );
  assert.throws(() => safeDetailsOpeningContract(missingRefresh));

  const genericPlayerInput = replaceUnique(
    driver,
    '            // A click can have uncertain delivery. Never retry after attempting it.',
    '            guardedClick(player, "player surface reveal");\n' +
      '            // A click can have uncertain delivery. Never retry after attempting it.',
  );
  assert.throws(() => safeDetailsOpeningContract(genericPlayerInput));
});

test("details wait refreshes observation before reacquiring the exact dialog", () => {
  safeDetailsWaitContract(driver);
});

test("details-wait contract rejects cache-refresh omission", () => {
  safeDetailsWaitContract(driver);
  const changed = replaceUnique(
    driver,
    'assertTrue("Accessibility cache refresh failed while waiting for player details",\n' +
      "                    instrumentation.getUiAutomation().clearCache());",
    'assertTrue("Accessibility cache refresh failed while waiting for player details", true);',
  );
  assert.throws(() => safeDetailsWaitContract(changed));
});

test("flow never uses the product player surface as a setup input", () => {
  safeDetailsOpeningContract(driver);
  noPlayerSurfaceInputContract(driver);
});

test("flow contract rejects reintroduced settings surface reveal", () => {
  safeDetailsOpeningContract(driver);
  noPlayerSurfaceInputContract(driver);
  const changed = replaceUnique(
    driver,
    "                        return RuntimeExternalSettingsTransaction.Observation.waiting();\n" +
      "                    }\n                    @Override public void recordTiming",
    "                        return RuntimeExternalSettingsTransaction.Observation.reveal(player::click);\n" +
      "                    }\n                    @Override public void recordTiming",
  );
  assert.throws(() => noPlayerSurfaceInputContract(changed));
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

test("workflow contract keeps exact success and bounded partial-failure inventories", () => {
  const mutations = [
    ["assert set(names)==expected", "assert set(names)<=expected"],
    [
      "assert set(names)<=expected and 'instrumentation-foreground-playback-receipt.json' in names",
      "assert set(names)<=expected",
    ],
  ];
  for (const [before, after] of mutations) {
    const changed = replaceUnique(workflow, before, after);
    assert.throws(() => contract(changed), `Inventory mutation escaped contract: ${before}`);
  }
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
    ['CASE="$playback_case" PRESENTATION="$presentation" NATIVE_TEST_OK="$native_test_ok" python3', 'CASE="$playback_case" NATIVE_TEST_OK="$native_test_ok" python3'],
    ["elif os.environ['PRESENTATION']=='normal-diagnostic':\n              assert set(names)<=expected and receipt in names", "elif os.environ['PRESENTATION']=='normal-diagnostic':\n              pass"],
  ];
  for (const [before, after] of mutations) {
    const changed = workflow.replace(before, after);
    assert.notEqual(changed, workflow, `Mutation did not apply: ${before}`);
    assert.throws(() => contract(changed), `Mutation escaped contract: ${before}`);
  }
});

test('normal viewing is explicit manual full only and preserves the no-input epoch', () => {
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.presentation == 'normal-diagnostic'/);
  assert.match(workflow, /normal-diagnostic\) test "\$mode" = full && test "\$\{\{ github\.event_name \}\}" = workflow_dispatch/);
  assert.match(workflow, /if \[ "\$presentation" = normal-diagnostic \]; then[\s\S]*android_normal_foreground_diagnostic\.mjs[\s\S]*else[\s\S]*android_foreground_playback_receipt\.mjs/);
  const start = driver.indexOf('private void runNormalDiagnostic(');
  const end = driver.indexOf('private void runFlow() throws Exception', start);
  assert.ok(start >= 0 && end > start);
  const body = driver.slice(start, end);
  const close = body.indexOf('guardedClick(close, "close playback information")');
  const ownership = body.indexOf('assertNormalOwnership()', close);
  const noInput = body.indexOf('noInputWindowStarted = true', ownership);
  const clock = body.indexOf('windowStartedMs = SystemClock.uptimeMillis()', noInput);
  const capture = body.indexOf('captureNormalAnchor(1, 0)', clock);
  const loop = body.indexOf('for (int index = 1; index < 5; index++)', capture);
  assert.ok(close >= 0 && close < ownership && ownership < noInput && noInput < clock && clock < capture && capture < loop);
  assert.match(body.slice(clock, capture), /^windowStartedMs = SystemClock\.uptimeMillis\(\);\s*$/);
  assert.match(body.slice(capture, loop), /clearCache\(\)[\s\S]*assertNormalOwnership\(\)/);
  assert.match(body, /assertNull\("Details panel remained visible", findUniqueExactProductDialog\(DETAILS_LABEL\)\)/);
  assert.match(body, /findLabeledClickableWithin\(details, "Close playback information"/);
  assert.doesNotMatch(body.slice(noInput), /guardedClick\(|\.click\(\)|device\.click\(/);
  assert.match(body, /index < 5/);
  assert.match(body, /findLabeledClickableWithin\(player, "Pause", "pause control"\)/);
  assert.match(body, /player\.findObjects\(By\.desc\(exactLabel\("Play"\)\)\)/);
  assert.match(body, /captureNormalAnchor\(index \+ 1, elapsedMs\);[\s\S]*clearCache\(\)[\s\S]*assertNormalOwnership\(\)/);
  assert.match(driver, /!presentation\.equals\("normal-diagnostic"\) \|\| mode\.equals\("full"\)/);
});

function autoMkvContract(source, java) {
  assert.match(source, /FIXTURE_SOURCE_SHA: d477d2a3eb2977c429c0a3b1a9128374536075cd/);
  assert.match(source, /sha256sum fixture-source\/scripts\/ipad-foreground\/passive_observer\.mjs[^\n]*73d12d475d280ce430993bcbd709a38e4b8f970cbd9e58d39fabe9a2259b0369/);
  assert.match(source, /if \[ "\$REQUESTED_CASE" = auto-mkv \]; then\s*test "\$\{\{ github\.event_name \}\}" = workflow_dispatch\s*test "\$REQUESTED_MODE" = full\s*test "\$REQUESTED_PRESENTATION" = normal-diagnostic/);
  assert.match(source, /fixture_extra=\(\)\s*if \[ "\$playback_case" = auto-mkv \]; then fixture_extra=\(--source-mkv\); fi/);
  assert.match(source, /--foreground-long --ipad-foreground "\$\{fixture_extra\[@\]\}"/);
  assert.match(java, /!playbackCase\.equals\("auto-mkv"\) \|\| \(mode\.equals\("full"\) && presentation\.equals\("normal-diagnostic"\)\)/);
  assert.match(java, /if \(playbackCase\.equals\("hls"\)\) \{\s*phase = "selecting-480p"/);
  assert.match(java, /waitForExactMkvFile\(MEDIA_WAIT_MS\)/);
  assert.match(java, /readDefinitionValue\(details, "File", exactLabel\(MKV_FILE\)\)/);
  assert.match(java, /assertTrue\("Auto MKV must not select quality manually", !qualitySelected\)/);
  assert.match(java, /playbackCase\.equals\("direct"\) \? DIRECT_ENGINE : HLS_ENGINE/);
}
test('auto MKV is manual full only with exact source and no quality action', () => {
  autoMkvContract(workflow, driver);
  for (const [from, to] of [
    ['test "$REQUESTED_MODE" = full', 'test "$REQUESTED_MODE" = admission'],
    ['test "$REQUESTED_PRESENTATION" = normal-diagnostic', 'test "$REQUESTED_PRESENTATION" = details'],
    ['fixture_extra=(--source-mkv)', 'fixture_extra=()'],
  ]) {
    assert.equal(workflow.split(from).length, 2);
    assert.throws(() => autoMkvContract(workflow.replace(from, to), driver));
  }
  for (const [from, to] of [
    ['readDefinitionValue(details, "File", exactLabel(MKV_FILE))', 'MKV_FILE'],
    ['assertTrue("Auto MKV must not select quality manually", !qualitySelected)', 'assertTrue("Auto MKV must not select quality manually", true)'],
    ['if (playbackCase.equals("hls")) {\n            phase = "selecting-480p"', 'if (!playbackCase.equals("direct")) {\n            phase = "selecting-480p"'],
  ]) {
    assert.equal(driver.split(from).length, 2);
    assert.throws(() => autoMkvContract(workflow, driver.replace(from, to)));
  }
});

function mkvFileObservationContract(source) {
  const start = source.indexOf('private void waitForExactMkvFile(long timeoutMs)');
  const end = source.indexOf('private FrameSample waitForReadableStats', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /long deadline = SystemClock\.uptimeMillis\(\) \+ timeoutMs/);
  assert.match(body, /while \(SystemClock\.uptimeMillis\(\) < deadline\)/);
  assert.match(body, /clearCache\(\)[\s\S]*assertNoOutOfScopeApproval\(\)[\s\S]*PRODUCT_PACKAGE, device\.getCurrentPackageName\(\)[\s\S]*requireUniqueDetailsDialog\(\)[\s\S]*readDefinitionValue\(details, "File", exactLabel\(MKV_FILE\)\)/);
  assert.match(body, /catch \(StaleObjectException stale\)/);
  assert.doesNotMatch(body, /catch \(AssertionError|catch \(Exception|guardedClick\(|\.click\(\)/);
  assert.match(source, /FrameSample readyStats = waitForReadableStats\(details, MEDIA_WAIT_MS\);\s*if \(presentation\.equals\("normal-diagnostic"\)\) \{\s*details = waitForUniqueDetailsDialog\(SHORT_WAIT_MS\);\s*runNormalDiagnostic\(details, readyStats\)/);
}
test('MKV file observation refreshes and reacquires only for stale AX nodes', () => {
  mkvFileObservationContract(driver);
  for (const [from, to] of [
    ['instrumentation.getUiAutomation().clearCache());\n                assertNoOutOfScopeApproval();\n                assertEquals("Product package lost foreground ownership while reading MKV file"', 'true);\n                assertNoOutOfScopeApproval();\n                assertEquals("Product package lost foreground ownership while reading MKV file"'],
    ['assertNoOutOfScopeApproval();\n                assertEquals("Product package lost foreground ownership while reading MKV file"', 'assertEquals("Product package lost foreground ownership while reading MKV file"'],
    ['PRODUCT_PACKAGE, device.getCurrentPackageName());\n                UiObject2 details = requireUniqueDetailsDialog();', '"other", device.getCurrentPackageName());\n                UiObject2 details = requireUniqueDetailsDialog();'],
    ['catch (StaleObjectException stale) {\n                // Retry only a retired accessibility node', 'catch (AssertionError stale) {\n                // Retry only a retired accessibility node'],
    ['long deadline = SystemClock.uptimeMillis() + timeoutMs;\n        while (SystemClock.uptimeMillis() < deadline) {\n            try {\n                assertTrue("Accessibility cache refresh failed while reading MKV file"', 'long deadline = Long.MAX_VALUE;\n        while (SystemClock.uptimeMillis() < deadline) {\n            try {\n                assertTrue("Accessibility cache refresh failed while reading MKV file"'],
  ]) {
    assert.equal(driver.split(from).length, 2);
    assert.throws(() => mkvFileObservationContract(driver.replace(from, to)));
  }
});

test('details stale retry is limited to pre-input reads', () => {
  safeDetailsOpeningContract(driver);
  for (const [from, to] of [
    ['catch (StaleObjectException stale) {\n                // No input has been attempted.', 'catch (AssertionError stale) {\n                // No input has been attempted.'],
    ['details != null && hasVisibleBounds(details) && details.isEnabled()', 'details != null && hasVisibleBounds(details)'],
    ['            } catch (StaleObjectException stale) {\n                // No input has been attempted.', '                details.click();\n            } catch (StaleObjectException stale) {\n                // No input has been attempted.'],
    ['            details.click();\n            SystemClock.sleep(500);', '            assertTrue("enabled", details.isEnabled());\n            details.click();\n            SystemClock.sleep(500);'],
    ['long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;\n        while (SystemClock.uptimeMillis() < deadline) {\n            UiObject2 details;', 'long deadline = Long.MAX_VALUE;\n        while (SystemClock.uptimeMillis() < deadline) {\n            UiObject2 details;'],
  ]) {
    assert.equal(driver.split(from).length, 2);
    assert.throws(() => safeDetailsOpeningContract(driver.replace(from, to)));
  }
});
