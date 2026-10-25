import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAdmittedMedia } from "./android-touch-player-fixture/media-contract.mjs";
import { validateTouchPlayerEvidence } from "./android_touch_player_receipt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workflow = readFileSync(join(root, ".github/workflows/android-current-runtime.yml"), "utf8");
const job = workflow.slice(workflow.indexOf("  touch-player-fixture:\n"));
const fixture = readFileSync(join(here, "android_touch_player_server_fixture.mts"), "utf8");
const driver = readFileSync(join(here, "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeTouchPlayerFlowTest.java"), "utf8");
const serverApi = readFileSync(join(root, "web/src/lib/serverApi.ts"), "utf8");
const scrubBar = readFileSync(join(root, "web/src/components/player/ScrubBar.tsx"), "utf8");

function workflowRunStep(name) {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, `missing workflow step: ${name}`);
  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, `missing run block: ${name}`);
  const contentStart = runStart + runMarker.length;
  const nextStep = workflow.indexOf("\n      - name:", contentStart);
  const indented = workflow.slice(contentStart, nextStep === -1 ? undefined : nextStep);
  return indented.split("\n").map((line) => {
    assert.ok(line.length === 0 || line.startsWith("          "), `unexpected run-block indentation: ${line}`);
    return line.slice(10);
  }).join("\n");
}

function exactSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const touchRun = workflowRunStep("Run one fresh native UI touch-player flow");
const captureFunction = exactSlice(
  touchRun,
  "capture_preinstall_health() {",
  "\n\nsystem_server_pid_before=",
);
const admissionCommand = 'HEALTH_DIR="$health_dir" PID_BEFORE="$system_server_pid_before" PID_AFTER="$system_server_pid_after"';
const admissionCommandStart = touchRun.indexOf(admissionCommand);
assert.notEqual(admissionCommandStart, -1);
const admissionMarker = "python3 - <<'PY'\n";
const admissionStart = touchRun.indexOf(admissionMarker, admissionCommandStart);
assert.notEqual(admissionStart, -1);
const admissionEnd = touchRun.indexOf("\nPY\n", admissionStart + admissionMarker.length);
assert.notEqual(admissionEnd, -1);
const admissionPython = touchRun.slice(admissionStart + admissionMarker.length, admissionEnd);

const dropboxTags = [
  "system_server_anr", "system_app_anr", "data_app_anr",
  "system_server_crash", "system_app_crash", "data_app_crash",
];

function cleanDropbox(tag) {
  return [
    "Drop box contents: 35 entries",
    "Max entries: 1000",
    "Low priority rate limit period: 2000 ms",
    "Low priority tags: {data_app_wtf, system_server_wtf}",
    `Searching for: ${tag}`,
    "",
  ].join("\n");
}

function retainedDropbox(tag) {
  return `${cleanDropbox(tag)}\n========================================\n2026-10-25 00:00:00 ${tag} (compressed text, 14683 bytes)\nretained diagnostic body\n`;
}

function cleanSnapshots() {
  return Object.fromEntries([
    ...dropboxTags.map((tag) => [`dropbox-${tag}.txt`, cleanDropbox(tag)]),
    ["events.txt", "--------- beginning of events\n10-25 00:00:00.000   675   675 I boot_progress_start: [0]\n"],
    ["crash.txt", ""],
  ]);
}

function executeAdmission({ overrides = {}, statusOverrides = {}, omitted = [], pidBefore = "675", pidAfter = "675" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-health-admission-"));
  const snapshots = { ...cleanSnapshots(), ...overrides };
  for (const name of omitted) delete snapshots[name];
  for (const [name, contents] of Object.entries(snapshots)) writeFileSync(join(directory, name), contents);
  const statuses = Object.fromEntries(Object.keys(cleanSnapshots()).map((name) => [
    name.replace(/\.txt$/, ".status.json"),
    { schemaVersion: 1, commandExit: 0, redactorExit: 0, complete: true },
  ]));
  Object.assign(statuses, statusOverrides);
  for (const [name, contents] of Object.entries(statuses)) {
    writeFileSync(join(directory, name), `${JSON.stringify(contents)}\n`);
  }
  const result = spawnSync("python3", ["-c", admissionPython], {
    encoding: "utf8",
    env: {
      ...process.env,
      HEALTH_DIR: directory,
      PID_BEFORE: pidBefore,
      PID_AFTER: pidAfter,
      QUIET_START: "2026-10-25T03:00:00Z",
      QUIET_FINISH: "2026-10-25T03:00:15Z",
    },
  });
  const receiptPath = join(directory, "admission.json");
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  rmSync(directory, { recursive: true, force: true });
  return { ...result, receipt };
}

function executeCapture({ name = "sample", payload, command = 'printf "%s" "$CAPTURE_PAYLOAD"' }) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-health-capture-"));
  const shell = [
    "set -euo pipefail",
    'health_dir="$1"',
    'timeout() { shift; "$@"; }',
    captureFunction,
    'capture_preinstall_health "$2" bash -c "$3"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", shell, "health-capture", directory, name, command], {
    encoding: "utf8",
    env: { ...process.env, CAPTURE_PAYLOAD: payload ?? "" },
  });
  const outputPath = join(directory, `${name}.txt`);
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
  const statusPath = join(directory, `${name}.status.json`);
  const captureStatus = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : null;
  const partExists = existsSync(`${outputPath}.part`);
  rmSync(directory, { recursive: true, force: true });
  return { ...result, output, captureStatus, partExists };
}

function validUi() {
  return {
    schemaVersion: 1, outcome: "passed", fixture: "exact-multiaudio-real-server-transcoder-proxy",
    evidenceStatus: "provisional", decodedPlaybackClaimed: false,
    manualDecodedPlaybackReviewRequired: true,
    manualDecodedPlaybackReviewCaptureLabels: ["playing-clock-initial", "playing-clock-advanced"],
    checks: {
      nativeUiAutomationOnly: true, webViewInjectionUsed: false, privatePreferencesUsed: false,
      permissionGrantUsed: false, firstDecodeClockAdvanced: true, centralPauseResume: true,
      pausedBackForward: true, touchScrubDeltaSeconds: 8, twoRealAudioTracksObserved: true,
      japaneseSelectionPersistedAfterHandoff: true, normalHlsMetadataReady: true,
      preAudioSwitchAbsolutePositionSeconds: 20, postHandoffAbsolutePositionSeconds: 20,
      pausedSideDoubleTapSingleSeek: true,
      portraitLandscapePortrait: true, audioSelectionPersistedAcrossOrientation: true,
      initialPortraitWidthPx: 1080, initialPortraitHeightPx: 1920,
      portraitBeforeOrientationWidthPx: 1080, portraitBeforeOrientationHeightPx: 1920,
      landscapeWidthPx: 1920, landscapeHeightPx: 1080,
      portraitReturnWidthPx: 1080, portraitReturnHeightPx: 1920,
    },
  };
}

function validServer() {
  return {
    schemaVersion: 1, maxEntries: 256, droppedEntries: 0,
    events: [
      { sequence: 1, elapsedMs: 1, phase: "live", method: "GET", route: "proxy", status: 200, contentType: "video-mp4" },
      { sequence: 2, elapsedMs: 2, phase: "live", method: "GET", route: "audio-inventory", status: 200, contentType: "other" },
      { sequence: 3, elapsedMs: 3, phase: "live", method: "GET", route: "hls-manifest", status: 200, contentType: "hls", start: 20, audio: 1, playbackDecision: "transcode" },
      { sequence: 4, elapsedMs: 4, phase: "live", method: "GET", route: "hls-asset", status: 200, contentType: "video-mp2t" },
    ],
  };
}

test("dispatch is opt-in and mutually excludes every older runtime route", () => {
  assert.match(workflow, /touch_player_fixture:\n\s+description:[^\n]+\n\s+type: boolean\n\s+required: true\n\s+default: false/);
  assert.match(workflow, /api36-current-runtime:\n\s+if:[^\n]+inputs\.touch_player_fixture != true/);
  assert.match(workflow, /permission-return-fixtures:\n\s+if:[^\n]+inputs\.touch_player_fixture != true/);
  assert.match(workflow, /external-player-fixture:\n\s+if:[^\n]+inputs\.touch_player_fixture != true/);
  assert.match(job, /if:[^\n]+inputs\.touch_player_fixture == true[^\n]+inputs\.permission_fixture != true[^\n]+inputs\.external_player_fixture != true/);
});

test("touch job binds the exact immutable host and exact hosted UI without inventing version code", () => {
  assert.match(job, /PRODUCT_SHA256: 2b458f8bc5584b53ecbeb9fba932593dd51a648d209d49688803fa3e5b014200/);
  assert.match(job, /PRODUCT_SOURCE: 679534f91359d9e4b12a64cc45bbe3ae580d7f61/);
  assert.match(job, /PRODUCT_SIGNER_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a/);
  assert.match(job, /TOUCH_UI_SOURCE: a5ec866a6cbc9af3b0865a49845b7ad4cc9c9520/);
  assert.match(job, /PRODUCT_VERSION: 2\.3\.58/);
  assert.match(job, /TOUCH_UI_VERSION: 2\.3\.59/);
  assert.doesNotMatch(job, /PRODUCT_VERSION_CODE:\s*["']?[0-9]/);
  assert.match(job, /actual_version_code="\$\(apkanalyzer manifest version-code/);
  assert.match(job, /versionCodeSource.*apkanalyzer-from-immutable-apk/);
});

test("touch job is one fresh API36 x86_64 KVM AVD with fail-closed preinstall gates", () => {
  for (const text of [
    "system-images;android-36;google_apis;x86_64", "test -c /dev/kvm",
    "Refusing to reuse an existing emulator or device", "preinstallProductAbsent=true",
    "preinstallHarnessAbsent=true", "getprop ro.build.version.sdk", "getprop ro.product.cpu.abi",
    "getconf PAGE_SIZE", "adb -s \"$EMULATOR_SERIAL\" reverse", "timeout 720s",
  ]) assert.ok(job.includes(text), text);
  assert.doesNotMatch(job, /logcat -c|pm grant|continue-on-error|retry [1-9]|--retry/);
  assert.doesNotMatch(job, /VLC|phone42|externalHandler/);
  assert.match(job, /Product ANR observed; no waiver is allowed/);
});

test("preinstall admission requires a bounded quiet ANR and crash observation with a stable system_server", () => {
  for (const text of [
    "capture_preinstall_health", "sleep 15", "pidof system_server",
    "system_server_pid_before", "system_server_pid_after",
    "system_server_anr system_app_anr data_app_anr",
    "system_server_crash system_app_crash data_app_crash",
    "logcat -b events -d", "logcat -b crash -d",
    "maximum_bytes = 1024 * 1024", "maximum_lines = 4000",
    "Preinstall health capture failed or truncated",
    "Preinstall ANR/crash evidence observed; no waiver is allowed",
    "Preinstall diagnostics unavailable or malformed; no waiver is allowed",
    '"stableSystemServerPid"', '"anrOrCrashFindings"', '"diagnosticErrors"',
  ]) assert.ok(job.includes(text), text);
  const healthStart = job.indexOf("system_server_pid_before=");
  const healthGate = job.slice(healthStart, job.indexOf('adb -s "$EMULATOR_SERIAL" reverse', healthStart));
  assert.ok(healthGate.length > 0);
  assert.doesNotMatch(healthGate, /logcat -c|reboot|emu kill|\|\| true|retry/i);
});

test("exact embedded capture preserves URL whitespace and redacts complete sensitive suffixes", () => {
  const payload = [
    "prefix https://example.test/media?id=secret next-field",
    "notice Authorization: Bearer top secret with spaces",
    "header-value Cookie: session=abc def",
    "standalone bearer token-here",
    "",
  ].join("\n");
  const result = executeCapture({ payload });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.captureStatus,
    { schemaVersion: 1, commandExit: 0, redactorExit: 0, complete: true });
  assert.equal(result.output, [
    "prefix [redacted-url] next-field",
    "notice [redacted-sensitive]",
    "header-value [redacted-sensitive]",
    "standalone [redacted-sensitive]",
    "",
  ].join("\n"));
  assert.doesNotMatch(result.output, /example\.test|top secret|session=abc|token-here/);
});

test("exact embedded capture retains explicit success metadata for an empty crash buffer", () => {
  const result = executeCapture({ name: "crash", payload: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "");
  assert.deepEqual(result.captureStatus,
    { schemaVersion: 1, commandExit: 0, redactorExit: 0, complete: true });
});

test("exact embedded capture fails closed on command failure and truncation", async (t) => {
  await t.test("command failure", () => {
    const result = executeCapture({ command: "printf 'partial\\n'; exit 7" });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, null);
    assert.deepEqual(result.captureStatus,
      { schemaVersion: 1, commandExit: 7, redactorExit: 0, complete: false });
    assert.equal(result.partExists, true);
  });
  await t.test("line truncation", () => {
    const result = executeCapture({ command: `python3 -c 'for _ in range(4001): print("line")'` });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, null);
    assert.deepEqual(result.captureStatus,
      { schemaVersion: 1, commandExit: 0, redactorExit: 23, complete: false });
    assert.equal(result.partExists, true);
  });
  await t.test("byte truncation", () => {
    const result = executeCapture({ command: `python3 -c 'import sys; sys.stdout.write("x" * (1024 * 1024 + 1))'` });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, null);
    assert.deepEqual(result.captureStatus,
      { schemaVersion: 1, commandExit: 0, redactorExit: 23, complete: false });
    assert.equal(result.partExists, true);
  });
});

test("exact embedded admission accepts real-shaped empty filtered DropBox headers", () => {
  const result = executeAdmission();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.receipt.admitted, true);
  assert.deepEqual(result.receipt.anrOrCrashFindings, []);
  assert.deepEqual(result.receipt.diagnosticErrors, []);
  assert.equal(result.receipt.systemServerPidBefore, 675);
  assert.equal(result.receipt.systemServerPidAfter, 675);
  assert.equal(result.receipt.stableSystemServerPid, true);
});

test("exact embedded admission accepts parenthesized empty DropBox output but rejects a positive ANR", () => {
  const empty = cleanDropbox("system_app_anr").replace(/\n$/, "\n(No entries found.)\n");
  const accepted = executeAdmission({ overrides: { "dropbox-system_app_anr.txt": empty } });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.receipt.admitted, true);
  assert.deepEqual(accepted.receipt.anrOrCrashFindings, []);
  const positive = executeAdmission({ overrides: {
    "dropbox-system_app_anr.txt": `${empty}========================================\n2026-10-25 00:00:00 system_app_anr (compressed text, 14683 bytes)\nretained diagnostic body\n`,
  } });
  assert.notEqual(positive.status, 0);
  assert.equal(positive.receipt.admitted, false);
  assert.deepEqual(positive.receipt.anrOrCrashFindings, ["dropbox-system_app_anr.txt"]);
});

test("exact embedded admission rejects each retained DropBox ANR and crash entry, not its filter echo", async (t) => {
  for (const tag of dropboxTags) {
    await t.test(tag, () => {
      const name = `dropbox-${tag}.txt`;
      const result = executeAdmission({ overrides: { [name]: retainedDropbox(tag) } });
      assert.notEqual(result.status, 0);
      assert.equal(result.receipt.admitted, false);
      assert.deepEqual(result.receipt.anrOrCrashFindings, [name]);
      assert.deepEqual(result.receipt.diagnosticErrors, []);
    });
  }
});

test("exact embedded admission rejects am_anr and am_crash event records", async (t) => {
  for (const tag of ["am_anr", "am_crash"]) {
    await t.test(tag, () => {
      const events = `--------- beginning of events\n10-25 00:00:00.000   675   701 I ${tag}  : [0,fixture]\n`;
      const result = executeAdmission({ overrides: { "events.txt": events } });
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.receipt.anrOrCrashFindings, ["events.txt"]);
      assert.deepEqual(result.receipt.diagnosticErrors, []);
    });
  }
});

test("exact embedded admission rejects Java and native crash markers", async (t) => {
  const cases = [
    ["java-fatal", "AndroidRuntime", "FATAL EXCEPTION: main"],
    ["native-signal", "libc", "Fatal signal 11 (SIGSEGV), code 1"],
    ["crash-dump", "DEBUG", "crash_dump64 completed"],
    ["abort", "DEBUG", "Abort message: owned fixture"],
    ["anr", "ActivityManager", "ANR in com.example.fixture"],
  ];
  for (const [name, tag, message] of cases) {
    await t.test(name, () => {
      const crash = `--------- beginning of crash\n10-25 00:00:00.000   675   701 E ${tag}: ${message}\n`;
      const result = executeAdmission({ overrides: { "crash.txt": crash } });
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.receipt.anrOrCrashFindings, ["crash.txt"]);
      assert.deepEqual(result.receipt.diagnosticErrors, []);
    });
  }
});

test("exact embedded admission fails closed on missing, malformed, unavailable, and unstable diagnostics", async (t) => {
  const cases = [
    ["missing snapshot", { omitted: ["events.txt"] }, /missing snapshot/],
    ["unavailable DropBox", { overrides: { "dropbox-system_server_anr.txt": "Can't find service: dropbox\n" } }, /DropBox/],
    ["malformed logcat", { overrides: { "events.txt": "logcat unavailable\n" } }, /logcat/],
    ["wrong logcat buffer", { overrides: { "events.txt": "--------- beginning of crash\n" } }, /logcat/],
    ["failed empty crash capture", { statusOverrides: { "crash.status.json": { schemaVersion: 1, commandExit: 1, redactorExit: 0, complete: false } } }, /capture command failed/],
    ["nonnumeric PID", { pidBefore: "675x" }, /PID before/],
    ["changed PID", { pidAfter: "676" }, /PID changed/],
  ];
  for (const [name, options, error] of cases) {
    await t.test(name, () => {
      const result = executeAdmission(options);
      assert.notEqual(result.status, 0);
      assert.equal(result.receipt.admitted, false);
      assert.match(result.receipt.diagnosticErrors.join("\n"), error);
    });
  }
});

test("fixture uses exact two-track bytes, live ffprobe, real proxy, and real transcoder", () => {
  const facts = assertAdmittedMedia(join(here, "android-touch-player-fixture"));
  assert.equal(facts.audioTracks, 2);
  assert.deepEqual(facts.keyframesSeconds, [0, 10, 20]);
  assert.equal(facts.mp4Sha256, "e07908225929030752333173d91669819b3412e159e710655bc7413ef3625e7c");
  assert.match(fixture, /spawnSync\("ffprobe"/);
  assert.match(fixture, /transcoder: realTranscoder/);
  assert.match(fixture, /enableTranscode: true/);
  assert.match(fixture, /recordPlayerResponse/);
  assert.match(fixture, /route: "proxy" \| "audio-inventory" \| "hls-manifest" \| "hls-asset"/);
  assert.match(fixture, /Blocked unexpected outbound request/);
});

test("driver stays in product UI and exercises every touch-player behavior", () => {
  for (const text of [
    "RuntimeTouchPlayerFlowTest", "firstDecodeClockAdvanced", "centralPauseResume",
    "pausedBackForward", "touchScrubDeltaSeconds", "twoRealAudioTracksObserved",
    "japaneseSelectionPersistedAfterHandoff", "pausedSideDoubleTapSingleSeek",
    "portraitLandscapePortrait", "audioSelectionPersistedAcrossOrientation",
    "device.setOrientationLeft()", "device.setOrientationNatural()",
    "device.swipe(", "device.click(x, y)", "SystemClock.sleep(180)",
  ]) assert.ok(driver.includes(text), text);
  assert.doesNotMatch(driver, /evaluateJavascript|executeShellCommand|VLC|external player|pm grant/i);
});

test("driver emits provisional decode evidence, exact handoff clocks, and measured orientation dimensions", () => {
  const runFlow = driver.slice(driver.indexOf("private void runFlow()"), driver.indexOf("private void openCurrentAudioSheet"));
  assert.ok(runFlow.indexOf("device.setOrientationNatural()") < runFlow.indexOf('capture("first-run")'));
  for (const text of [
    'capture("playing-clock-initial")', 'capture("playing-clock-advanced")',
    'checks.put("preAudioSwitchAbsolutePositionSeconds", preAudioSwitchPosition)',
    'checks.put("postHandoffAbsolutePositionSeconds", postHandoffPosition)',
    "Math.max(1, preAudioSwitchPosition - 1), MEDIA_WAIT_MS",
    "Math.abs(postHandoffPosition - preAudioSwitchPosition) <= 1",
    'checks.put("normalHlsMetadataReady", true)',
    'checks.put("initialPortraitWidthPx", initialPortraitWidth)',
    'checks.put("portraitBeforeOrientationWidthPx", portraitWidth)',
    'checks.put("landscapeWidthPx", landscapeWidth)',
    'checks.put("portraitReturnWidthPx", portraitReturnWidth)',
  ]) assert.ok(driver.includes(text), text);
  assert.match(driver, /receipt\.put\("evidenceStatus", "provisional"\)/);
  assert.match(driver, /receipt\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(driver, /receipt\.put\("manualDecodedPlaybackReviewRequired", true\)/);
  assert.doesNotMatch(driver, /receipt\.put\("decodedPlaybackClaimed", "passed"\.equals\(outcome\)\)/);
});

test("layout checks bind the visible transport state at each call site", () => {
  assert.match(driver, /assertCoreLayout\("portrait-playing", "Pause"\)/);
  assert.match(driver, /assertCoreLayout\("landscape", "Play"\)/);
  assert.match(driver, /assertCoreLayout\("portrait-return", "Play"\)/);
  assert.match(driver, /private void assertCoreLayout\(String label, String expectedPlayPauseLabel\)/);
  assert.match(driver, /waitForLabeledClickable\(\s*expectedPlayPauseLabel, SHORT_WAIT_MS/);
  assert.doesNotMatch(driver, /private void assertCoreLayout\(String label\) \{/);
});

test("selected-audio receipt binding follows the product's shared integer-second floor", () => {
  assert.match(serverApi, /const startSeconds = Math\.floor\(boundedTranscodeStartSeconds\(options\.startSeconds\)\)/);
  assert.match(scrubBar, /aria-valuenow=\{Math\.floor\(displayedTime\)\}/);
  const ui = validUi();
  const server = validServer();
  server.events[2].start = ui.checks.preAudioSwitchAbsolutePositionSeconds - 1;
  assert.throws(() => validateTouchPlayerEvidence(ui, server));
});

test("driver disables animated idle waits and refreshes public accessibility observations", () => {
  assert.match(driver, /Configurator\.getInstance\(\)\.setWaitForIdleTimeout\(0\)/);
  assert.match(driver, /private void refreshObservation\(\) \{\s*instrumentation\.getUiAutomation\(\)\.clearCache\(\)/);
  assert.match(driver, /private float\[\] readNativeSeekRange\(\) \{\s*refreshObservation\(\)/);
  assert.match(driver, /private void capture\(String label\) throws IOException \{\s*refreshObservation\(\)/);
  assert.doesNotMatch(driver, /executeShellCommand|java\.lang\.reflect|setAccessible\(/);
});

test("driver uses observed language labels and reopens the source-remounted audio sheet", () => {
  assert.match(driver, /private static final String ENGLISH = "English"/);
  assert.match(driver, /private static final String JAPANESE = "Japanese"/);
  assert.doesNotMatch(driver, /Synthetic English 440 Hz tone|Synthetic Japanese 880 Hz tone/);
  const audio = driver.slice(driver.indexOf('transition("two-track-audio-handoff")'),
    driver.indexOf('transition("paused-side-double-tap-after-hls")'));
  assert.match(audio, /openCurrentAudioSheet\("Audio tracks", "Audio track, " \+ ENGLISH\)/);
  assert.match(audio, /waitForLabeledClickable\("Audio track, " \+ JAPANESE/);
  assert.match(audio, /!hasTextOrDescription\("Close audio tracks"\)/);
  assert.match(audio, /openCurrentAudioSheet\("Audio track, " \+ JAPANESE\)/);
  assert.match(audio, /clickLabeled\("Close audio tracks", "close persisted audio tracks"/);
});

test("driver positions paused playback away from either clamp before one ten-second side double tap", () => {
  assert.match(driver, /seekBounds\.left \+ seekBounds\.width\(\) \* 2 \/ 3/);
  const doubleTap = driver.slice(driver.indexOf('transition("paused-side-double-tap-after-hls")'),
    driver.indexOf('transition("orientation-round-trip")'));
  assert.match(doubleTap, /clickLabeled\("Back 10 seconds", "paused Back 10 before side double tap"/);
  assert.match(doubleTap, /beforeDoubleTap >= 8 && beforeDoubleTap <= 12/);
  assert.match(doubleTap, /waitForPlaybackPositionAtLeast\(beforeDoubleTap \+ 9/);
  assert.match(doubleTap, /doubleTapDelta >= 9/);
  assert.match(doubleTap, /doubleTapDelta <= 11/);
  assert.match(driver, /assertAbsoluteThirtySecondTimeline\(\)/);
  assert.match(driver, /range\[1\] >= 29f && range\[1\] <= 31f/);
});

test("bounded receipt validator accepts complete evidence and kills each semantic omission", () => {
  const accepted = validateTouchPlayerEvidence(validUi(), validServer());
  assert.equal(accepted.outcome, "provisional");
  assert.equal(accepted.decodedPlaybackClaimed, false);
  assert.equal(accepted.manualDecodedPlaybackReviewRequired, true);
  assert.equal(accepted.selectedAudioHlsStartSeconds, 20);
  const mutants = [
    () => { const x = validUi(); x.checks.firstDecodeClockAdvanced = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.touchScrubDeltaSeconds = 0; return [x, validServer()]; },
    () => { const x = validUi(); x.decodedPlaybackClaimed = true; return [x, validServer()]; },
    () => { const x = validUi(); x.manualDecodedPlaybackReviewRequired = false; return [x, validServer()]; },
    () => { const x = validUi(); delete x.checks.preAudioSwitchAbsolutePositionSeconds; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.postHandoffAbsolutePositionSeconds = 0; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.postHandoffAbsolutePositionSeconds = 18; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.normalHlsMetadataReady = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.landscapeWidthPx = 900; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.portraitReturnWidthPx = 1079; return [x, validServer()]; },
    () => { const x = validServer(); x.events[2].audio = 0; return [validUi(), x]; },
    () => { const x = validServer(); x.events[2].start = 0; return [validUi(), x]; },
    () => { const x = validServer(); x.events[2].start = 19; return [validUi(), x]; },
    () => { const x = validServer(); x.events[2].start = 10; return [validUi(), x]; },
    () => { const x = validServer(); x.events = x.events.filter(e => e.route !== "proxy"); x.events.forEach((e,i) => e.sequence=i+1); return [validUi(), x]; },
    () => { const x = validServer(); x.droppedEntries = 1; return [validUi(), x]; },
  ];
  for (const mutate of mutants) assert.throws(() => validateTouchPlayerEvidence(...mutate()));
});
