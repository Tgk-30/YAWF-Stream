import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    manualGestureReviewRequired: true,
    manualGestureReviewCaptureLabels: ["before-side-double-tap", "after-side-double-tap"],
    strictSeekSemanticObserved: true, nativeSeekRangeObserved: false,
    playbackClockObservationBasis: "native-seekbar-aria-valuetext",
    nativeDoubleTapInjectionUsed: true,
    doubleTapObservationBasis: "uiautomation-motion-event-source-touchscreen-uptime",
    checks: {
      nativeUiAutomationOnly: true, webViewInjectionUsed: false, privatePreferencesUsed: false,
      permissionGrantUsed: false, firstDecodeClockAdvanced: true, centralPauseResume: true,
      strictSeekSemanticObserved: true, nativeSeekRangeObserved: false,
      playbackClockObservationBasis: "native-seekbar-aria-valuetext",
      pausedClockBeforeResumeSeconds: 3,
      pausedBackForward: true, touchScrubDeltaSeconds: 8, twoRealAudioTracksObserved: true,
      japaneseSelectionPersistedAfterHandoff: true, normalHlsMetadataReady: true,
      preAudioSwitchAbsolutePositionSeconds: 20, postHandoffAbsolutePositionSeconds: 20,
      preRotationAbsolutePositionSeconds: 20, postRotationAbsolutePositionSeconds: 20,
      nativeDoubleTapInjectionUsed: true, doubleTapGestureTimingValid: true,
      doubleTapPlayerSafetyVerified: true, doubleTapPointOutsideActionableControls: true,
      doubleTapObservationBasis: "uiautomation-motion-event-source-touchscreen-uptime",
      doubleTapFirstDownUptimeMs: 1000, doubleTapFirstUpUptimeMs: 1040,
      doubleTapSecondDownUptimeMs: 1140, doubleTapSecondUpUptimeMs: 1180,
      doubleTapUpToUpGapMs: 140, doubleTapPointXPx: 907, doubleTapPointYPx: 672,
      pausedSideDoubleTapSingleSeek: true, pausedSideDoubleTapDeltaSeconds: 10,
      portraitLandscapePortrait: true, audioSelectionPersistedAcrossOrientation: true,
      playbackActionsRailScrolled: true, playbackActionsRailPanAttempts: 2,
      playbackSettingsOpened: true, playbackSettingsVerticalPanAttempts: 1,
      externalPlayerActionReachable: true, externalPlayerActionLaunched: false,
      playbackSettingsUpwardPanAttempts: 1, playbackSettingsCloseUsed: true,
      playbackActionsRailReturnPanAttempts: 2,
      pausedJapanesePreservedAfterPlaybackSettings: true,
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

function javaIntConstant(name) {
  const match = driver.match(new RegExp(`private static final int ${name} = ([0-9_]+);`));
  assert.ok(match, `missing Java integer constant ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

function executeJavaBooleanReturn(methodSource, parameterNames, values) {
  const match = methodSource.match(/return\s+([\s\S]*?);/);
  assert.ok(match, "missing Java boolean return expression");
  const expression = match[1]
    .replaceAll("MAX_SURFACE_REVEALS", String(javaIntConstant("MAX_SURFACE_REVEALS")))
    .replaceAll("DOUBLE_TAP_MAX_UP_TO_UP_MS", "320")
    .replaceAll("Float.isFinite", "Number.isFinite")
    .replace(/(\d+)L\b/g, "$1")
    .replace(/(\d+)f\b/g, "$1");
  return Function(...parameterNames, `"use strict"; return (${expression});`)(...values);
}

const PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
const PLAYER_DIALOG_TITLE = "Playing Synthetic Fixture Movie (2026)";
const DISPLAY = { width: 1080, height: 1920 };

function javaPatternConstant(name) {
  const match = driver.match(new RegExp(
    `private static final Pattern ${name} = Pattern\\.compile\\(\\n\\s*("(?:[^"\\\\]|\\\\.)*")\\);`,
  ));
  assert.ok(match, `missing Java pattern constant ${name}`);
  return new RegExp(JSON.parse(match[1]));
}

const SEEK_VALUE_ONLY = javaPatternConstant("SEEK_VALUE_ONLY");
const SEEK_VALUE_WITH_NAME = javaPatternConstant("SEEK_VALUE_WITH_NAME");
const configuredJavaHome = process.env.JAVA_HOME;
const javac = configuredJavaHome ? join(configuredJavaHome, "bin", "javac") : "javac";
const java = configuredJavaHome ? join(configuredJavaHome, "bin", "java") : "java";
const strictSeekProbeCache = new Map();

function spawnDiagnostics(result) {
  return [result?.error?.stack ?? result?.error?.message, result?.stdout, result?.stderr]
    .filter(Boolean).join("\n");
}

function strictSeekParserProbe(source) {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  if (strictSeekProbeCache.has(sourceHash)) return strictSeekProbeCache.get(sourceHash);
  if (configuredJavaHome) {
    assert.ok(existsSync(javac), `configured JAVA_HOME has no compiler: ${javac}`);
    assert.ok(existsSync(java), `configured JAVA_HOME has no runtime: ${java}`);
  }
  const patterns = exactSlice(
    source,
    "    private static final Pattern SEEK_VALUE_ONLY",
    "\n\n    private Instrumentation",
  );
  const parser = exactSlice(
    source,
    "    static int[] parseStrictSeekSemantic(",
    "\n    static boolean isBoundedNativeSeekRange(",
  );
  const probeSource = `import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class StrictSeekSemanticProbe {
${patterns}
${parser}
    private static void expect(int current, int total, String text, String description) {
        int[] parsed = parseStrictSeekSemantic(text, description);
        if (parsed == null || parsed[0] != current || parsed[1] != total) {
            throw new AssertionError("valid case rejected: " + text + " / " + description);
        }
    }

    private static void reject(String text, String description) {
        if (parseStrictSeekSemantic(text, description) != null) {
            throw new AssertionError("invalid case admitted: " + text + " / " + description);
        }
    }

    public static void main(String[] args) {
        expect(20, 30, "0:20 of 0:30, Seek", "");
        expect(20, 30, "0:20 of 0:30", "Seek");
        reject("0:20 of 0:30, Seek now", "");
        reject("0:20 of 0:30", "Timeline");
        reject("0:60 of 0:30, Seek", "");
        reject("0:31 of 0:30, Seek", "");
        reject("0:20 of 0:29, Seek", "");
        reject("0:20 of 0:60, Seek", "");
    }
}`;
  const directory = mkdtempSync(join(tmpdir(), "yawf-strict-seek-semantic-"));
  try {
    const file = join(directory, "StrictSeekSemanticProbe.java");
    writeFileSync(file, probeSource);
    const compile = spawnSync(javac, ["-encoding", "UTF-8", "-d", directory, file], {
      encoding: "utf8",
    });
    assert.equal(compile.error, undefined,
      `required javac is unavailable (${javac})\n${spawnDiagnostics(compile)}`);
    const run = compile.status === 0
      ? spawnSync(java, ["-cp", directory, "StrictSeekSemanticProbe"], { encoding: "utf8" })
      : null;
    if (run != null) {
      assert.equal(run.error, undefined,
        `required java runtime is unavailable (${java})\n${spawnDiagnostics(run)}`);
    }
    const result = { sourceHash, compile, run };
    strictSeekProbeCache.set(sourceHash, result);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function exactMutation(source, before, after) {
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `mutation target missing: ${before}`);
  return mutated;
}

function playerDialog(parent = null) {
  return { packageName: PRODUCT_PACKAGE, className: "android.app.Dialog", text: PLAYER_DIALOG_TITLE, parent };
}

function insideActivePlayerDialog(node) {
  let current = node;
  for (let depth = 0; depth < 20 && current != null; depth++) {
    if (current.packageName === PRODUCT_PACKAGE
      && current.className === "android.app.Dialog"
      && current.text === PLAYER_DIALOG_TITLE) return true;
    current = current.parent;
  }
  return false;
}

function validBounds(bounds, minimumWidth, minimumHeight, display = DISPLAY) {
  return bounds != null && bounds.left >= 0 && bounds.top >= 0
    && bounds.right <= display.width && bounds.bottom <= display.height
    && bounds.right - bounds.left >= minimumWidth
    && bounds.bottom - bounds.top >= minimumHeight;
}

function selectPlayerTransport(nodes, label, display = DISPLAY) {
  const candidates = nodes.filter((node) => node.packageName === PRODUCT_PACKAGE
    && node.className === "android.widget.ToggleButton"
    && (node.text === label || node.description === label)
    && node.clickable === true && node.enabled === true
    && insideActivePlayerDialog(node)
    && validBounds(node.bounds, 44, 44, display));
  if (candidates.length > 1) throw new Error("ambiguous active-player transport");
  return candidates[0] ?? null;
}

function parseStrictSeekSemantic(text, description) {
  const rawText = String(text ?? "");
  const rawDescription = String(description ?? "");
  let match;
  if (rawDescription === "" && (match = rawText.match(SEEK_VALUE_WITH_NAME)) != null) {
    // Chromium may combine aria-valuetext and the accessible name in node text.
  } else if (rawDescription === "Seek"
      && (match = rawText.match(SEEK_VALUE_ONLY)) != null) {
    // Chromium may expose aria-valuetext as text and the accessible name separately.
  } else {
    return null;
  }
  const current = Number(match[1]) * 60 + Number(match[2]);
  const total = Number(match[3]) * 60 + Number(match[4]);
  if (Number(match[2]) > 59 || Number(match[4]) > 59 || total !== 30
      || current < 0 || current > total) return null;
  return { current, total };
}

function executeRangeValues(range, bounds, display = DISPLAY) {
  const method = exactSlice(
    driver,
    "static boolean isBoundedNativeSeekRangeValues(",
    "\n    private void refreshObservation()",
  );
  return executeJavaBooleanReturn(method, [
    "minimum", "current", "maximum", "left", "top", "right", "bottom", "displayWidth", "displayHeight",
  ], [
    range.min, range.current, range.max,
    bounds.left, bounds.top, bounds.right, bounds.bottom, display.width, display.height,
  ]);
}

function selectPlayerSeekObservation(nodes, display = DISPLAY) {
  const dialogs = nodes.filter((node) => node.packageName === PRODUCT_PACKAGE
    && node.className === "android.app.Dialog" && node.text === PLAYER_DIALOG_TITLE);
  if (dialogs.length > 1) throw new Error("ambiguous active player dialog");
  if (dialogs.length !== 1) return null;
  const candidates = [];
  for (const node of nodes) {
    if (node.packageName !== PRODUCT_PACKAGE || node.className !== "android.widget.SeekBar"
      || !insideActivePlayerDialog(node)
      || node.visible !== true || node.enabled !== true || node.clickable !== true
      || !validBounds(node.bounds, 44, 1, display)) continue;
    const semantic = parseStrictSeekSemantic(node.text, node.description);
    if (semantic == null) continue;
    if (node.range != null) {
      if (!executeRangeValues(node.range, node.bounds, display)) continue;
      if (Math.abs(semantic.current - node.range.current) > 1) {
        throw new Error("SeekBar aria-valuetext disagrees with native range");
      }
    }
    candidates.push({ node, semantic, range: node.range ?? null });
  }
  if (candidates.length > 1) throw new Error("ambiguous strict native SeekBar");
  return candidates[0] ?? null;
}

function scanPlayerAxFrame(nodes, { requestPlayingPauseFocus = false, focusActionResult = true } = {}) {
  const dialogs = nodes.filter((node) => node.packageName === PRODUCT_PACKAGE
    && node.className === "android.app.Dialog" && node.text === PLAYER_DIALOG_TITLE);
  if (dialogs.length > 1) throw new Error("ambiguous active player dialog");
  const nestedDialogs = nodes.filter((node) => node.packageName === PRODUCT_PACKAGE
    && node.className === "android.app.Dialog" && node.text !== PLAYER_DIALOG_TITLE
    && insideActivePlayerDialog(node)).length;
  const transports = nodes.filter((node) => node.packageName === PRODUCT_PACKAGE
    && node.className === "android.widget.ToggleButton"
    && (node.text === "Pause" || node.text === "Play"
      || node.description === "Pause" || node.description === "Play")
    && node.visible === true && node.enabled === true && node.clickable === true
    && validBounds(node.bounds, 44, 44) && insideActivePlayerDialog(node));
  const pauses = transports.filter((node) => node.text === "Pause" || node.description === "Pause");
  const plays = transports.filter((node) => node.text === "Play" || node.description === "Play");
  if (pauses.length > 1 || plays.length > 1) throw new Error("ambiguous active-player transport");
  if (pauses.length === 1 && plays.length === 1) throw new Error("both Play and Pause exposed");
  const seek = selectPlayerSeekObservation(nodes);
  const snapshot = {
    activeDialogs: dialogs.length,
    nestedDialogs,
    pauseControls: pauses.length,
    playControls: plays.length,
    seekBars: seek == null ? 0 : 1,
    focusedPauseControls: pauses.filter((node) => node.focused === true).length,
    nativeRange: seek?.range ?? null,
    semanticClock: seek?.semantic.current ?? -1,
    semanticTotal: seek?.semantic.total ?? -1,
    pauseFocusActionAttempted: false,
    pauseFocusActionSucceeded: false,
  };
  if (requestPlayingPauseFocus && dialogs.length === 1 && nestedDialogs === 0 && pauses.length === 1
    && plays.length === 0 && snapshot.focusedPauseControls === 0) {
    if (pauses[0].focusable !== true) throw new Error("Pause is not focusable");
    snapshot.pauseFocusActionAttempted = true;
    snapshot.pauseFocusActionSucceeded = focusActionResult;
  }
  return snapshot;
}

function verifyFocusedPlayingSnapshot(frames, focusActionResult = true) {
  const observed = scanPlayerAxFrame(frames[0] ?? [], {
    requestPlayingPauseFocus: true,
    focusActionResult,
  });
  if (observed.pauseControls !== 1 || observed.playControls !== 0) {
    throw new Error("playing Pause not observed");
  }
  if (observed.pauseFocusActionAttempted && !observed.pauseFocusActionSucceeded) {
    throw new Error("focus action failed");
  }
  const verified = observed.pauseFocusActionAttempted
    ? scanPlayerAxFrame(frames[1] ?? [])
    : observed;
  if (verified.activeDialogs !== 1 || verified.nestedDialogs !== 0
    || verified.pauseControls !== 1 || verified.playControls !== 0
    || verified.focusedPauseControls !== 1) {
    throw new Error("fresh focused playing state not verified");
  }
  return {
    position: verified.semanticClock,
    focusActions: observed.pauseFocusActionAttempted ? 1 : 0,
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
  assert.match(job, /PRODUCT_APK: verified-phone-candidate\/YAWF\.Stream_Android_2\.3\.59\.apk/);
  assert.match(job, /PRODUCT_SHA256: 5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47/);
  assert.match(job, /PRODUCT_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(job, /PRODUCT_SIGNER_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a/);
  assert.match(job, /TOUCH_UI_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(job, /PRODUCT_VERSION: 2\.3\.59/);
  assert.match(job, /TOUCH_UI_VERSION: 2\.3\.59/);
  assert.doesNotMatch(job, /PRODUCT_VERSION_CODE:\s*["']?[0-9]/);
  assert.match(job, /actual_version_code="\$\(apkanalyzer manifest version-code/);
  assert.match(job, /versionCodeSource.*apkanalyzer-from-immutable-apk/);
  assert.match(job, /actions\/download-artifact@v4/);
  assert.match(job, /artifact-ids: 12589729254/);
  assert.match(job, /run-id: 40169716770/);
  assert.match(job, /merge-multiple: true/);
  assert.match(job, /nativeProducerRunId=40169716770/);
  assert.match(job, /nativeArtifactId=12589729254/);
  assert.doesNotMatch(job, /PRODUCT_URL|curl .*YAWF\.Stream/);
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

test("clickable-label lookup rejects nonclickable ancestor traps and admits only unique enabled controls", () => {
  const method = driver.slice(driver.indexOf("private void collectClickableAncestors"), driver.indexOf("private static Pattern exactLabel"));
  assert.match(method, /current\.isClickable\(\) && current\.isEnabled\(\)/);
  assert.match(method, /current == null \|\| !current\.isClickable\(\) \|\| !current\.isEnabled\(\)/);
  const resolve = (matches) => {
    const candidates = [];
    for (const match of matches) {
      let current = match;
      for (let depth = 0; depth < 6 && current != null; depth++) {
        if (current.clickable && current.enabled) break;
        current = current.parent;
      }
      if (current == null || !current.clickable || !current.enabled) continue;
      if (!candidates.some((existing) => existing.id === current.id)) candidates.push(current);
    }
    if (candidates.length > 1) throw new Error("ambiguous");
    return candidates[0] ?? null;
  };
  const button = { id: "sign-in", clickable: true, enabled: true, parent: null };
  const trap = { id: "heading", clickable: false, enabled: true };
  let cursor = trap;
  for (let i = 0; i < 6; i++) { cursor.parent = { id: `ancestor-${i}`, clickable: false, enabled: true }; cursor = cursor.parent; }
  cursor.parent = button;
  assert.equal(resolve([trap]), null);
  assert.equal(resolve([button]), button);
  assert.equal(resolve([{ id: "disabled", clickable: false, enabled: true, parent: { id: "disabled-ancestor", clickable: true, enabled: false } }]), null);
  const second = { id: "other", clickable: true, enabled: true, parent: null };
  assert.throws(() => resolve([button, second]), /ambiguous/);
});

test("strict same-SeekBar aria-valuetext contract admits only exact native observations", async (t) => {
  const dialog = playerDialog();
  const base = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.SeekBar",
    text: "0:20 of 0:30, Seek", description: "", range: null,
    visible: true, enabled: true, clickable: true,
    bounds: { left: 28, top: 1572, right: 1052, bottom: 1690 }, parent: { parent: dialog },
  };
  const cases = [
    ["empty description with combined exact text", base, true],
    ["split exact label and value text", { ...base, text: "0:20 of 0:30", description: "Seek" }, true],
    ["arbitrary suffix", { ...base, text: "0:20 of 0:30, Seek now" }, false],
    ["wrong accessible label", { ...base, text: "0:20 of 0:30", description: "Timeline" }, false],
    ["unrelated clock node", { ...base, className: "android.widget.TextView" }, false],
    ["hidden slider", { ...base, visible: false }, false],
    ["disabled slider", { ...base, enabled: false }, false],
    ["clock beyond total", { ...base, text: "0:31 of 0:30, Seek" }, false],
    ["wrong total", { ...base, text: "0:20 of 0:29, Seek" }, false],
  ];
  for (const [name, candidate, admitted] of cases) {
    await t.test(name, () => {
      assert.match(driver, /static int\[\] parseStrictSeekSemantic\(/,
        "Java driver must own the exact same-node semantic parser");
      const observed = selectPlayerSeekObservation([dialog, candidate]);
      assert.equal(observed != null, admitted);
    });
  }
  await t.test("ambiguous strict sliders", () => {
    assert.match(driver, /Multiple strict semantic SeekBars/);
    assert.throws(() => selectPlayerSeekObservation([
      dialog, base, { ...base, bounds: { left: 28, top: 1400, right: 1052, bottom: 1518 } },
    ]), /ambiguous strict native SeekBar/);
  });
  await t.test("optional numeric range agreement", () => {
    assert.match(driver, /aria-valuetext disagreed with its native range/);
    assert.equal(selectPlayerSeekObservation([
      dialog, { ...base, range: { min: 0, current: 20, max: 30 } },
    ]).semantic.current, 20);
    assert.throws(() => selectPlayerSeekObservation([
      dialog, { ...base, range: { min: 0, current: 16, max: 30 } },
    ]), /disagrees/);
  });
});

test("exact Java strict Seek parser executes on JDK 17 and kills body and pattern mutants", () => {
  const accepted = strictSeekParserProbe(driver);
  assert.equal(accepted.compile.status, 0,
    `${accepted.compile.stdout}\n${accepted.compile.stderr}`);
  assert.equal(accepted.run.status, 0, `${accepted.run.stdout}\n${accepted.run.stderr}`);

  const mutants = [
    exactMutation(
      driver,
      "if (total != 30 || current < 0 || current > total) return null;",
      "if (current < 0 || current > total) return null;",
    ),
    exactMutation(
      driver,
      "if (total != 30 || current < 0 || current > total) return null;",
      "if (total != 30 || current < 0) return null;",
    ),
    exactMutation(driver, "), Seek$\");", "), Seek.*\");"),
    exactMutation(
      driver,
      '} else if ("Seek".equals(exactDescription)) {',
      "} else if (!exactDescription.isEmpty()) {",
    ),
  ];
  for (const mutant of mutants) {
    const rejected = strictSeekParserProbe(mutant);
    assert.equal(rejected.compile.status, 0,
      `${rejected.compile.stdout}\n${rejected.compile.stderr}`);
    assert.notEqual(rejected.run.status, 0,
      "mutated exact Java parser unexpectedly satisfied the boundary oracle");
  }
  assert.equal(strictSeekParserProbe(driver), accepted,
    "identical frozen driver text must reuse the one compiled probe result");
});

test("initial playing choreography reuses one native snapshot and lowers paused clock with bounded input", () => {
  const runFlow = exactSlice(driver, "private void runFlow()", "\n    private void openCurrentAudioSheet(");
  assert.match(driver, /private void assertCoreLayoutSnapshot\(/);
  assert.match(runFlow, /assertCoreLayoutSnapshot\("portrait-playing", initialPlaying, "Pause"\)/);
  assert.doesNotMatch(runFlow, /assertCoreLayout\("portrait-playing", "Pause"\)/);
  assert.ok(runFlow.indexOf('capture("playing-clock-advanced")')
    < runFlow.indexOf('clickPlayerTransport("Pause", "central Pause"'));
  assert.ok(runFlow.indexOf('clickPlayerTransport("Pause", "central Pause"')
    < runFlow.indexOf("positionPausedClockAtMostFive()"));
  assert.ok(runFlow.indexOf("positionPausedClockAtMostFive()")
    < runFlow.indexOf('clickPlayerTransport("Play", "central Play"'));
  const lower = exactSlice(driver, "private int positionPausedClockAtMostFive()", "\n    private void openCurrentAudioSheet(");
  assert.match(lower, /for \(int attempt = 0; attempt < 3/);
  assert.match(lower, /clickPlayerLabeled\("Back 10 seconds"/);
  assert.match(lower, /position <= 5/);
  assert.match(lower, /waitForPlaybackPositionAtMost\(/);
  assert.doesNotMatch(lower, /evaluateJavascript|executeShellCommand|setText/);
});

test("active-player AX selection executes run4 shapes and rejects identity and range mutants", () => {
  assert.ok(driver.includes('private static final String PLAYER_DIALOG_TITLE = "Playing Synthetic Fixture Movie (2026)";'),
    "driver must bind controls to the exact active fixture-player dialog");
  assert.match(driver, /By\.clazz\("android\.widget\.ToggleButton"\)\.pkg\(PRODUCT_PACKAGE\)/);
  assert.match(driver, /By\.clazz\("android\.widget\.SeekBar"\)\.pkg\(PRODUCT_PACKAGE\)/);
  assert.match(driver, /if \(!isInsideActivePlayerDialog\(candidate\)\) continue/);

  const dialog = playerDialog();
  const playerContainer = { parent: dialog };
  const detailDialog = {
    packageName: PRODUCT_PACKAGE, className: "android.app.Dialog",
    text: "Synthetic Fixture Movie details", parent: null,
  };
  const backgroundPlay = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.Button", text: "Play", description: "",
    clickable: true, enabled: true, bounds: { left: 84, top: 895, right: 480, bottom: 1029 }, parent: detailDialog,
  };
  const playerPlay = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.ToggleButton", text: "Play", description: "",
    clickable: true, enabled: true, bounds: { left: 443, top: 876, right: 603, bottom: 1047 }, parent: playerContainer,
  };
  assert.equal(selectPlayerTransport([backgroundPlay, playerPlay], "Play"), playerPlay);
  assert.equal(selectPlayerTransport([backgroundPlay], "Play"), null);
  assert.equal(selectPlayerTransport([{ ...playerPlay, className: "android.widget.Button" }], "Play"), null);
  assert.equal(selectPlayerTransport([{ ...playerPlay, packageName: "other.package" }], "Play"), null);
  assert.equal(selectPlayerTransport([{ ...playerPlay, parent: detailDialog }], "Play"), null);
  assert.equal(selectPlayerTransport([{ ...playerPlay, bounds: { left: 0, top: 0, right: 43, bottom: 44 } }], "Play"), null);
  assert.throws(() => selectPlayerTransport([
    playerPlay,
    { ...playerPlay, bounds: { left: 200, top: 876, right: 360, bottom: 1047 } },
  ], "Play"), /ambiguous/);

  const run4Seek = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.SeekBar",
    text: "0:30 of 0:30, Seek", description: "", range: { min: 0, current: 30, max: 30 },
    visible: true, enabled: true, clickable: true,
    bounds: { left: 28, top: 1572, right: 1052, bottom: 1690 }, parent: { parent: dialog },
  };
  assert.equal(selectPlayerSeekObservation([dialog, run4Seek]).node, run4Seek);
  assert.deepEqual(parseStrictSeekSemantic(run4Seek.text, run4Seek.description), { current: 30, total: 30 });
  assert.equal(selectPlayerSeekObservation([dialog, { ...run4Seek, range: null }]).semantic.current, 30);
  assert.equal(selectPlayerSeekObservation([dialog, { ...run4Seek, text: "", description: "" }]), null);
  const rejected = [
    { ...run4Seek, packageName: "other.package" },
    { ...run4Seek, className: "android.view.View" },
    { ...run4Seek, range: { min: 0, current: Number.NaN, max: 30 } },
    { ...run4Seek, range: { min: 0, current: 31, max: 30 } },
    { ...run4Seek, range: { min: 1, current: 20, max: 30 } },
    { ...run4Seek, range: { min: 0, current: 20, max: 28 } },
    { ...run4Seek, visible: false },
    { ...run4Seek, enabled: false },
    { ...run4Seek, clickable: false },
    { ...run4Seek, bounds: { left: 0, top: 0, right: 43, bottom: 44 } },
    { ...run4Seek, bounds: { left: 28, top: 1572, right: 1100, bottom: 1690 } },
    { ...run4Seek, parent: { parent: detailDialog } },
  ];
  for (const mutant of rejected) assert.equal(selectPlayerSeekObservation([dialog, mutant]), null);
  assert.throws(() => selectPlayerSeekObservation([
    dialog, { ...run4Seek, text: "0:25 of 0:30, Seek" },
  ]), /disagrees/);
  assert.throws(() => selectPlayerSeekObservation([
    dialog, run4Seek,
    { ...run4Seek, bounds: { left: 28, top: 1400, right: 1052, bottom: 1518 } },
  ]), /ambiguous strict native SeekBar/);

  const rangeReader = exactSlice(
    driver,
    "private PlayerAxSnapshot readPlayerAxSnapshot(boolean requestPlayingPauseFocus)",
    "\n    private Rect uniqueBounds(",
  );
  assert.equal((rangeReader.match(/getRootInActiveWindow\(\)/g) ?? []).length, 1);
  assert.match(rangeReader, /node\.getRangeInfo\(\)/);
  assert.match(rangeReader, /node\.getBoundsInScreen\(bounds\)/);
  assert.match(rangeReader, /node\.isVisibleToUser\(\)/);
  assert.match(rangeReader, /parseStrictSeekSemantic\(/);
  assert.match(rangeReader, /Multiple strict semantic SeekBars/);
  assert.match(rangeReader, /AccessibilityNodeInfo\.obtain\(node\)/);
  assert.match(rangeReader, /performAction\(AccessibilityNodeInfo\.ACTION_FOCUS\)/);
  assert.doesNotMatch(rangeReader, /startsWith\("Seek"\)/);
  assert.doesNotMatch(rangeReader, /centerX|width\(\).*current|current.*width\(\)/);
  assert.doesNotMatch(rangeReader, /device\.findObjects|UiObject2/);
});

test("single AX snapshot keeps delayed playing observation strict across normal autohide", () => {
  assert.match(driver, /private static final class PlayerAxSnapshot/);
  const snapshotReader = exactSlice(
    driver,
    "private PlayerAxSnapshot readPlayerAxSnapshot(boolean requestPlayingPauseFocus)",
    "\n    private Rect uniqueBounds(",
  );
  assert.equal((snapshotReader.match(/getRootInActiveWindow\(\)/g) ?? []).length, 1,
    "each observation must use one fresh native tree root");
  assert.match(snapshotReader, /snapshot\.activeDialogs/);
  assert.match(snapshotReader, /snapshot\.pauseControls/);
  assert.match(snapshotReader, /snapshot\.playControls/);
  assert.match(snapshotReader, /snapshot\.nativeRange/);
  assert.match(snapshotReader, /snapshot\.focusedPauseControls/);
  assert.match(snapshotReader, /performAction\(AccessibilityNodeInfo\.ACTION_FOCUS\)/);

  const dialog = playerDialog();
  const container = { parent: dialog };
  const playingPause = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.ToggleButton",
    text: "Pause", description: "", visible: true, enabled: true, clickable: true,
    focusable: true, focused: false,
    bounds: { left: 443, top: 876, right: 603, bottom: 1047 }, parent: container,
  };
  const focusedPause = { ...playingPause, focused: true };
  const playingSeek = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.SeekBar",
    text: "0:13 of 0:30, Seek", description: "", range: { min: 0, current: 13, max: 30 },
    visible: true, enabled: true, clickable: true,
    bounds: { left: 28, top: 1572, right: 1052, bottom: 1690 }, parent: container,
  };
  const hiddenAfterSlowIndependentScan = [dialog];
  const run5Timing = {
    revealMs: 71_457,
    pauseSnapshotMs: 75_458,
    rangeFailureMs: 77_863,
  };
  assert.ok(run5Timing.pauseSnapshotMs - run5Timing.revealMs > 3_200,
    "run5's Pause scan returned after the normal chrome timer");
  assert.ok(run5Timing.rangeFailureMs > run5Timing.pauseSnapshotMs);
  assert.equal(selectPlayerTransport([dialog, playingPause], "Pause"), playingPause);
  assert.equal(selectPlayerSeekObservation(hiddenAfterSlowIndependentScan), null,
    "the run5-style later independent scan loses the transient range");
  assert.deepEqual(verifyFocusedPlayingSnapshot([
    [dialog, playingPause, playingSeek],
    [dialog, focusedPause, playingSeek],
  ]), { position: 13, focusActions: 1 });

  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, playingPause, playingSeek],
  ]), /fresh focused playing state/);
  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, { ...playingPause, focusable: false }, playingSeek],
  ]), /not focusable/);
  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, playingPause, playingSeek],
    [dialog, focusedPause, playingSeek],
  ], false), /focus action failed/);
  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, playingPause, playingSeek],
    [dialog, { ...focusedPause, text: "Play" }, playingSeek],
  ]), /fresh focused playing state/);
  assert.equal(verifyFocusedPlayingSnapshot([
    [dialog, playingPause, { ...playingSeek, range: null }],
    [dialog, focusedPause, { ...playingSeek, range: null }],
  ]).position, 13, "strict same-node aria-valuetext remains valid without RangeInfo");
  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, { ...playingPause, packageName: "other.package" }, playingSeek],
  ]), /playing Pause not observed/);
  assert.throws(() => verifyFocusedPlayingSnapshot([
    [dialog, { ...playingPause, parent: { parent: null } }, playingSeek],
  ]), /playing Pause not observed/);
  assert.throws(() => scanPlayerAxFrame([
    dialog, playingPause, { ...playingPause, bounds: { left: 200, top: 876, right: 360, bottom: 1047 } },
  ]), /ambiguous/);
  assert.throws(() => scanPlayerAxFrame([
    dialog, playingPause, { ...playingPause, text: "Play" }, playingSeek,
  ]), /both Play and Pause/);
  assert.equal(scanPlayerAxFrame([
    dialog, playingPause, { ...playingSeek, range: { min: 0, current: Number.NaN, max: 30 } },
  ]).nativeRange, null);
  assert.equal(scanPlayerAxFrame([
    dialog, playingPause, { ...playingSeek, bounds: { left: 0, top: 0, right: 43, bottom: 44 } },
  ]).nativeRange, null);

  const revealMethod = exactSlice(
    driver,
    "static boolean shouldRevealPlayerSurface(",
    "\n    private int revealPlayerSurfaceOnceIfHidden(",
  );
  const shouldReveal = (snapshot, reveals) => snapshot.nestedDialogs === 0
    && executeJavaBooleanReturn(revealMethod,
      ["activeDialogs", "pauseControls", "playControls", "reveals"],
      [snapshot.activeDialogs, snapshot.pauseControls, snapshot.playControls, reveals]);
  const waitForPosition = (frames) => {
    let reveals = 0;
    for (const nodes of frames) {
      const snapshot = scanPlayerAxFrame(nodes);
      if (snapshot.semanticClock >= 0) {
        return { position: snapshot.semanticClock, reveals };
      }
      if (shouldReveal(snapshot, reveals)) reveals++;
    }
    return { position: -1, reveals };
  };
  assert.deepEqual(waitForPosition([
    [dialog],
    [dialog, focusedPause, playingSeek],
  ]), { position: 13, reveals: 1 });
  assert.deepEqual(waitForPosition([[dialog], [dialog], [dialog]]), { position: -1, reveals: 1 });
  assert.deepEqual(waitForPosition([
    [dialog, { ...playingSeek, text: "0:13 of 0:30, Seek", range: null }],
  ]), { position: 13, reveals: 0 }, "strict same-node aria-valuetext does not require RangeInfo");

  const observerMethods = [
    exactSlice(driver, "private int waitForPlaybackPositionAtLeast(", "\n    private int waitForPlaybackPositionAtMost("),
    exactSlice(driver, "private int waitForPlaybackPositionAtMost(", "\n    private int waitForPlaybackPositionAvailable("),
    exactSlice(driver, "private int waitForPlaybackPositionAvailable(", "\n    private int waitForStrictTimelineTotal("),
    exactSlice(driver, "private int waitForStrictTimelineTotal(", "\n    private PlayerAxSnapshot readPlayerAxSnapshot("),
  ];
  for (const observer of observerMethods) {
    assert.match(observer, /long deadline = SystemClock\.uptimeMillis\(\) \+ timeoutMs/);
    assert.match(observer, /readPlayerAxSnapshot\(false\)/);
    assert.match(observer, /revealPlayerSurfaceOnceIfHidden\(/);
    assert.doesNotMatch(observer, /parsePlaybackPosition|centerX|width\(\).*position/);
  }
  assert.match(observerMethods[1], /last >= 0 && last <= maximum/,
    "an absent strict semantic clock must not satisfy an at-most wait");
  assert.match(observerMethods[2], /snapshot\.playbackPositionSeconds\(\)/);
  assert.match(observerMethods[3], /snapshot\.clockTotalSeconds/);
  assert.doesNotMatch(driver, /private int readPlaybackPosition\(/);
});

test("native Pause focus is blocked before input when the exact player has a nested modal", () => {
  const snapshotReader = exactSlice(
    driver,
    "private PlayerAxSnapshot readPlayerAxSnapshot(boolean requestPlayingPauseFocus)",
    "\n    private Rect uniqueBounds(",
  );
  assert.match(snapshotReader, /if \(requestPlayingPauseFocus\s*&& snapshot\.activeDialogs == 1\s*&& snapshot\.nestedDialogs == 0\s*&& snapshot\.pauseControls == 1/);

  const dialog = playerDialog();
  const container = { parent: dialog };
  const nestedModal = {
    packageName: PRODUCT_PACKAGE,
    className: "android.app.Dialog",
    text: "Audio tracks",
    parent: container,
  };
  const playingPause = {
    packageName: PRODUCT_PACKAGE, className: "android.widget.ToggleButton",
    text: "Pause", description: "", visible: true, enabled: true, clickable: true,
    focusable: true, focused: false,
    bounds: { left: 443, top: 876, right: 603, bottom: 1047 }, parent: container,
  };
  const snapshot = scanPlayerAxFrame([dialog, nestedModal, playingPause], {
    requestPlayingPauseFocus: true,
  });
  assert.equal(snapshot.activeDialogs, 1);
  assert.equal(snapshot.nestedDialogs, 1);
  assert.equal(snapshot.pauseControls, 1);
  assert.equal(snapshot.pauseFocusActionAttempted, false,
    "a nested player modal must suppress ACTION_FOCUS before any input is sent");
});

test("hidden touch chrome gets one exact-dialog surface reveal and bounded failure-only diagnostics", () => {
  const revealMethod = exactSlice(
    driver,
    "static boolean shouldRevealPlayerSurface(",
    "\n    private void recordFailureNativeSnapshot()",
  );
  const reveal = (activeDialogs, pauseControls, playControls, reveals) => executeJavaBooleanReturn(
    revealMethod,
    ["activeDialogs", "pauseControls", "playControls", "reveals"],
    [activeDialogs, pauseControls, playControls, reveals],
  );
  assert.equal(javaIntConstant("MAX_SURFACE_REVEALS"), 1);
  assert.equal(reveal(1, 0, 0, 0), true);
  assert.equal(reveal(0, 0, 0, 0), false);
  assert.equal(reveal(2, 0, 0, 0), false);
  assert.equal(reveal(1, 1, 0, 0), false);
  assert.equal(reveal(1, 0, 1, 0), false);
  assert.equal(reveal(1, 0, 0, 1), false);

  const initialWait = exactSlice(driver, "private PlayerAxSnapshot waitForInitialPlayingTransport()", "\n    static boolean shouldRevealPlayerSurface(");
  assert.match(initialWait, /long deadline = started \+ MEDIA_WAIT_MS/);
  assert.match(initialWait, /readPlayerAxSnapshot\(true\)/);
  assert.match(initialWait, /readPlayerAxSnapshot\(false\)/);
  assert.match(initialWait, /focused\.pauseControls == 1 && focused\.playControls == 0/);
  assert.match(initialWait, /focused\.focusedPauseControls == 1/);
  assert.match(initialWait, /revealPlayerSurfaceOnceIfHidden\([\s\S]*"initial playing transport", snapshot\)/);
  assert.match(initialWait, /nextSnapshot = now \+ 2_000/);
  assert.match(initialWait, /checks\.put\("initialSurfaceRevealUsed", reveals == 1\)/);
  assert.match(initialWait, /checks\.put\("initialPlayingControlFocusActionUsed", focusActionUsed\)/);
  assert.match(initialWait, /checks\.put\("initialPlayingControlFocusActionSucceeded",[\s\S]*snapshot\.pauseFocusActionSucceeded\)/);
  assert.match(initialWait, /checks\.put\("initialPlayingStatePreservedAcrossFocus", true\)/);
  assert.doesNotMatch(initialWait, /capture\(|dumpWindowHierarchy|evaluateJavascript|executeShellCommand/);

  const capture = exactSlice(driver, "private void capture(String label)", "\n    private void log(String value)");
  assert.ok(capture.indexOf("device.takeScreenshot") < capture.indexOf("device.dumpWindowHierarchy"));
  assert.match(driver, /private static final int MAX_NATIVE_POLL_SNAPSHOTS = 72/);
  assert.match(driver, /nativePollDiagnostics\.size\(\) >= MAX_NATIVE_POLL_SNAPSHOTS/);
  assert.match(driver, /stage=failure-range nativeRangePresent=%d currentMillis=%d maximumMillis=%d semanticClockSeconds=%d focusedPause=%d/);
  assert.match(driver, /if \(failure != null\) \{\s*receipt\.put\("failureNativePollDiagnostics"/);
  assert.match(driver, /receipt\.put\("nativePollDiagnosticsTruncated", nativePollDiagnosticsTruncated\)/);
  assert.doesNotMatch(driver, /receipt\.put\("failureNativePollDiagnostics"[^]*?else/);
});

test("every explicit player-control wait reveals hidden chrome once and requires a fresh target", () => {
  const transportWait = exactSlice(
    driver,
    "private UiObject2 waitForPlayerTransport(",
    "\n    private void clickPlayerTransport(",
  );
  assert.match(transportWait, /revealPlayerSurfaceOnceIfHidden\(reveals, description\)/,
    "transport waits must recover normal chrome autohide");
  assert.match(transportWait, /long deadline = SystemClock\.uptimeMillis\(\) \+ timeoutMs/);
  const labeledWait = exactSlice(
    driver,
    "private UiObject2 waitForPlayerLabeledClickable(",
    "\n    private void clickPlayerLabeled(",
  );
  const seekWait = exactSlice(
    driver,
    "private UiObject2 waitForPlayerSeekBar(",
    "\n    private boolean isBoundedVisibleTarget(",
  );
  const audioWait = exactSlice(
    driver,
    "private void openCurrentAudioSheet(",
    "\n    private boolean hasPlayerTextOrDescription(",
  );
  for (const source of [labeledWait, seekWait, audioWait]) {
    assert.match(source, /revealPlayerSurfaceOnceIfHidden\(/);
    assert.match(source, /long deadline = SystemClock\.uptimeMillis\(\) \+ (?:timeoutMs|MEDIA_WAIT_MS)/);
  }
  const revealHelper = exactSlice(
    driver,
    "private int revealPlayerSurfaceOnceIfHidden(",
    "\n    private void recordFailureNativeSnapshot()",
  );
  assert.match(revealHelper, /snapshot\.nestedDialogs > 0/);
  assert.match(revealHelper, /shouldRevealPlayerSurface\(snapshot\.activeDialogs,[\s\S]*snapshot\.pauseControls, snapshot\.playControls, reveals\)/);
  assert.match(revealHelper, /device\.click\(x, y\)/);
  assert.match(revealHelper, /return updatedReveals/);
  assert.doesNotMatch(revealHelper, /evaluateJavascript|executeShellCommand|setText|deadline/);

  const revealMethod = exactSlice(
    driver,
    "static boolean shouldRevealPlayerSurface(",
    "\n    private int revealPlayerSurfaceOnceIfHidden(",
  );
  const reveal = (frame, reveals) => !frame.nested && executeJavaBooleanReturn(
    revealMethod,
    ["activeDialogs", "pauseControls", "playControls", "reveals"],
    [frame.activeDialogs, frame.pauseControls, frame.playControls, reveals],
  );
  const runWait = (frames) => {
    let reveals = 0;
    let inputs = 0;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (frame.requestedControl === true) return { found: true, inputs, index };
      if (reveal(frame, reveals)) {
        reveals++;
        inputs++;
      }
    }
    return { found: false, inputs, index: -1 };
  };
  const hidden = {
    activeDialogs: 1, pauseControls: 0, playControls: 0,
    nested: false, requestedControl: false,
  };
  assert.deepEqual(runWait([
    hidden,
    { ...hidden, pauseControls: 1, requestedControl: true },
  ]), { found: true, inputs: 1, index: 1 });
  assert.deepEqual(runWait([hidden, hidden, hidden]), { found: false, inputs: 1, index: -1 });
  assert.deepEqual(runWait([{ ...hidden, nested: true }, { ...hidden, nested: true }]),
    { found: false, inputs: 0, index: -1 });
  assert.deepEqual(runWait([{ ...hidden, playControls: 1 }, { ...hidden, playControls: 1 }]),
    { found: false, inputs: 0, index: -1 });
  assert.deepEqual(runWait([{ ...hidden, requestedControl: true }]),
    { found: true, inputs: 0, index: 0 });

  const runFlow = exactSlice(driver, "private void runFlow()", "\n    private void openCurrentAudioSheet(");
  assert.doesNotMatch(runFlow, /assertNotNull\([^\n]+findPlayerTransport/);
  for (const description of [
    "paused Play after transport seeks", "paused Play after scrub",
    "paused Play after audio handoff", "paused Play after side double tap",
  ]) assert.ok(runFlow.includes(description), description);
});

test("driver stays in product UI and exercises every touch-player behavior", () => {
  for (const text of [
    "RuntimeTouchPlayerFlowTest", "firstDecodeClockAdvanced", "centralPauseResume",
    "pausedBackForward", "touchScrubDeltaSeconds", "twoRealAudioTracksObserved",
    "japaneseSelectionPersistedAfterHandoff", "pausedSideDoubleTapSingleSeek",
    "portraitLandscapePortrait", "audioSelectionPersistedAcrossOrientation",
    "device.setOrientationLeft()", "device.setOrientationNatural()",
    "device.swipe(", "injectNativePausedDoubleTap", "MotionEvent.ACTION_DOWN",
    "InputDevice.SOURCE_TOUCHSCREEN", "injectInputEvent(event, false)",
  ]) assert.ok(driver.includes(text), text);
  assert.doesNotMatch(driver, /evaluateJavascript|executeShellCommand|pm grant/i);
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
  assert.match(driver, /receipt\.put\("strictSeekSemanticObserved", strictSeekSemanticObserved\)/);
  assert.match(driver, /receipt\.put\("nativeSeekRangeObserved", nativeSeekRangeObserved\)/);
  assert.match(driver, /receipt\.put\("playbackClockObservationBasis", observationBasis\)/);
  assert.match(driver, /receipt\.put\("nativeDoubleTapInjectionUsed", nativeDoubleTapInjectionUsed\)/);
  assert.match(driver, /receipt\.put\("doubleTapObservationBasis", doubleTapObservationBasis\)/);
  assert.match(driver, /receipt\.put\("manualGestureReviewRequired", true\)/);
  assert.doesNotMatch(driver, /receipt\.put\("decodedPlaybackClaimed", "passed"\.equals\(outcome\)\)/);
});

test("layout checks bind the visible transport state at each call site", () => {
  assert.match(driver, /assertCoreLayoutSnapshot\("portrait-playing", initialPlaying, "Pause"\)/);
  assert.doesNotMatch(driver, /assertCoreLayout\("portrait-playing", "Pause"\)/);
  assert.match(driver, /assertCoreLayout\("landscape", "Play"\)/);
  assert.match(driver, /assertCoreLayout\("portrait-return", "Play"\)/);
  assert.match(driver, /private void assertCoreLayout\(String label, String expectedPlayPauseLabel\)/);
  assert.match(driver, /waitForPlayerTransport\(\s*expectedPlayPauseLabel, SHORT_WAIT_MS/);
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
  assert.match(driver, /private PlayerAxSnapshot readPlayerAxSnapshot\(boolean requestPlayingPauseFocus\) \{\s*refreshObservation\(\)/);
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
  assert.match(audio, /waitForPlayerLabeledClickable\("Audio track, " \+ JAPANESE/);
  assert.match(audio, /!hasPlayerTextOrDescription\("Close audio tracks"\)/);
  assert.match(audio, /openCurrentAudioSheet\("Audio track, " \+ JAPANESE\)/);
  assert.match(audio, /clickPlayerLabeled\("Close audio tracks", "close persisted audio tracks"/);
});

test("driver positions paused playback away from either clamp before one ten-second side double tap", () => {
  assert.match(driver, /seekBounds\.left \+ seekBounds\.width\(\) \* 2 \/ 3/);
  const doubleTap = driver.slice(driver.indexOf('transition("paused-side-double-tap-after-hls")'),
    driver.indexOf('transition("complete")'));
  const orientation = driver.slice(driver.indexOf('transition("orientation-round-trip")'),
    driver.indexOf('transition("paused-side-double-tap-after-hls")'));
  assert.ok(orientation.length > 0, "orientation checks must complete before the independent gesture case");
  assert.match(orientation, /Math\.abs\(postRotationPosition - preRotationPosition\) <= 1/);
  assert.match(doubleTap, /clickPlayerLabeled\("Back 10 seconds", "paused Back 10 before side double tap"/);
  assert.match(doubleTap, /beforeDoubleTap >= 8 && beforeDoubleTap <= 12/);
  assert.match(doubleTap, /capture\("before-side-double-tap"\)/);
  assert.match(doubleTap, /PlayerAxSnapshot gestureSnapshot = waitForPausedGestureSafetySnapshot\(\)/);
  assert.match(doubleTap, /injectNativePausedDoubleTap\(gestureSnapshot, x, y\)/);
  assert.match(doubleTap, /capture\("after-side-double-tap"\)/);
  assert.match(doubleTap, /waitForPlaybackPositionAtLeast\(beforeDoubleTap \+ 9/);
  assert.match(doubleTap, /doubleTapDelta >= 9/);
  assert.match(doubleTap, /doubleTapDelta <= 11/);
  assert.match(driver, /assertAbsoluteThirtySecondTimeline\(\)/);
  assert.match(driver, /assertEquals\("HLS audio handoff changed the absolute 30 second timeline", 30, total\)/);
});

test("exact Playback actions rail pans to a reachable non-launched external action and closes", () => {
  const runFlow = exactSlice(driver, "private void runFlow()", "\n    private PlayerAxSnapshot waitForPausedGestureSafetySnapshot(");
  const orientationAt = runFlow.indexOf('transition("orientation-round-trip")');
  const railAt = runFlow.indexOf('transition("touch-action-rail-and-settings")');
  const gestureAt = runFlow.indexOf('transition("paused-side-double-tap-after-hls")');
  assert.ok(orientationAt >= 0 && orientationAt < railAt && railAt < gestureAt);

  const reachability = exactSlice(
    driver,
    "private void verifyScrollablePlaybackActionsAndSettings()",
    "\n    private UiObject2 findPlaybackActionsRail()",
  );
  for (const text of [
    "attempt < 4",
    "rail.scroll(Direction.RIGHT, 0.72f)",
    'findPlayerLabeledClickable("Playback settings")',
    'guardedClick(more, "Playback settings after horizontal action-rail pan")',
    'waitForExactNestedPlayerDialog("Playback settings", SHORT_WAIT_MS)',
    'findPlayerLabeledClickableAny(',
    '"Open in external player Choose VLC or another installed video app"',
    "settingsScroller.scroll(Direction.DOWN, 0.70f)",
    "external.isEnabled() && external.isClickable()",
    'checks.put("externalPlayerActionLaunched", false)',
    'findPlayerLabeledClickable("Close playback settings")',
    "settingsScroller.scroll(Direction.UP, 0.70f)",
    'guardedClick(close, "Close playback settings after reachability proof")',
    "rail.scroll(Direction.LEFT, 0.72f)",
    'findPlayerLabeledClickable("Audio track, " + JAPANESE)',
    "Math.abs(afterSettings - beforeSettings) <= 1",
  ]) assert.ok(reachability.includes(text), text);
  assert.doesNotMatch(reachability, /guardedClick\(external|external\.click\(|Open in external player[^\n]*guardedClick/);

  const rail = exactSlice(
    driver,
    "private UiObject2 findPlaybackActionsRail()",
    "\n    private UiObject2 findScrollableInsideExactDialog(",
  );
  assert.match(rail, /By\.clazz\("android\.view\.View"\)/);
  assert.match(rail, /text\(exactLabel\("Playback actions"\)\)\.scrollable\(true\)/);
  assert.match(rail, /isInsideActivePlayerDialog\(candidate\)/);
  assert.match(rail, /isBoundedVisibleTarget\(candidate\.getVisibleBounds\(\), 44, 44\)/);
});

test("native double-tap timing and four-event sequence reject invalid harness gestures", () => {
  const timing = exactSlice(
    driver,
    "static boolean isValidNativeDoubleTapTiming(",
    "\n    private int positionPausedClockAtMostFive(",
  );
  const valid = (values, source = timing) => executeJavaBooleanReturn(source,
    ["firstDown", "firstUp", "secondDown", "secondUp"], values);
  assert.equal(valid([1000, 1040, 1140, 1180]), true);
  for (const values of [
    [1000, 1000, 1100, 1140],
    [1000, 1101, 1200, 1240],
    [1000, 1040, 1241, 1281],
    [1000, 1040, 1140, 1241],
    [1000, 1040, 1100, 1361],
    [1000, 1050, 1049, 1090],
  ]) assert.equal(valid(values), false, values.join("/"));

  const nonMonotonicMutant = timing.replace(
    "firstDown < firstUp && firstUp < secondDown && secondDown < secondUp",
    "firstDown <= firstUp && firstUp < secondDown && secondDown < secondUp",
  );
  assert.notEqual(nonMonotonicMutant, timing);
  assert.equal(valid([1000, 1000, 1100, 1140], nonMonotonicMutant), true,
    "the equality mutant must be killed by the boundary oracle");
  const gapMutant = timing.replace("&& secondDown - firstUp <= 200L", "");
  assert.notEqual(gapMutant, timing);
  assert.equal(valid([1000, 1040, 1241, 1281], gapMutant), true,
    "the unbounded inter-tap mutant must be killed by the boundary oracle");

  const injection = exactSlice(
    driver,
    "private long[] injectNativePausedDoubleTap(",
    "\n    static boolean isValidNativeDoubleTapTiming(",
  );
  for (const text of [
    "PRODUCT_PACKAGE.equals(device.getCurrentPackageName())",
    "snapshot.activeDialogs == 1 && snapshot.nestedDialogs == 0",
    "hasCompleteCoreSnapshot(snapshot) && snapshot.actionableBounds.size() >= 5",
    "snapshot.playControls == 1 && snapshot.pauseControls == 0",
    "snapshot.playerDialogBounds.contains(x, y)",
    "!actionable.contains(x, y)",
    "MotionEvent.ACTION_DOWN, 0L, x, y, \"first DOWN\"",
    "MotionEvent.ACTION_UP, firstDown, x, y, \"first UP\"",
    "MotionEvent.ACTION_DOWN, 0L, x, y, \"second DOWN\"",
    "MotionEvent.ACTION_UP, secondDown, x, y, \"second UP\"",
    "event.setSource(InputDevice.SOURCE_TOUCHSCREEN)",
    "injectInputEvent(event, false)",
    "event.recycle()",
  ]) assert.ok(injection.includes(text), text);
  const firstInjection = injection.indexOf("injectNativeTouchEvent(MotionEvent.ACTION_DOWN");
  for (const safety of ["getCurrentPackageName", "nestedDialogs", "playerDialogBounds.contains", "actionable.contains"]) {
    assert.ok(injection.indexOf(safety) >= 0 && injection.indexOf(safety) < firstInjection, safety);
  }
  const orderedEvents = [
    'MotionEvent.ACTION_DOWN, 0L, x, y, "first DOWN"',
    'MotionEvent.ACTION_UP, firstDown, x, y, "first UP"',
    'MotionEvent.ACTION_DOWN, 0L, x, y, "second DOWN"',
    'MotionEvent.ACTION_UP, secondDown, x, y, "second UP"',
  ].map((event) => injection.indexOf(event));
  assert.ok(orderedEvents.every((index) => index >= 0));
  assert.deepEqual([...orderedEvents].sort((a, b) => a - b), orderedEvents);
  assert.ok(injection.indexOf("event.setSource(InputDevice.SOURCE_TOUCHSCREEN)")
    < injection.indexOf("injectInputEvent(event, false)"));
  assert.ok(injection.indexOf("injectInputEvent(event, false)")
    < injection.indexOf("event.recycle()"));
  assert.match(injection, /secondUp <= observedAfterSequence/);
  assert.doesNotMatch(injection, /device\.click|evaluateJavascript|eventTime\s*[+-]|uptimeMillis\(\)\s*[+-]/);
});

test("bounded receipt validator accepts complete evidence and kills each semantic omission", () => {
  const accepted = validateTouchPlayerEvidence(validUi(), validServer());
  assert.equal(accepted.outcome, "provisional");
  assert.equal(accepted.decodedPlaybackClaimed, false);
  assert.equal(accepted.manualDecodedPlaybackReviewRequired, true);
  assert.equal(accepted.playbackClockObservationBasis, "native-seekbar-aria-valuetext");
  assert.equal(accepted.nativeSeekRangeObserved, false);
  assert.equal(accepted.nativeDoubleTapInjectionUsed, true);
  assert.equal(accepted.doubleTapObservationBasis,
    "uiautomation-motion-event-source-touchscreen-uptime");
  assert.equal(accepted.manualGestureReviewRequired, true);
  assert.equal(accepted.playbackActionsRailScrolled, true);
  assert.equal(accepted.externalPlayerActionReachable, true);
  assert.equal(accepted.externalPlayerActionLaunched, false);
  assert.equal(accepted.selectedAudioHlsStartSeconds, 20);
  const withRange = validUi();
  withRange.nativeSeekRangeObserved = true;
  withRange.checks.nativeSeekRangeObserved = true;
  withRange.playbackClockObservationBasis = "native-seekbar-range-plus-aria-valuetext";
  withRange.checks.playbackClockObservationBasis = "native-seekbar-range-plus-aria-valuetext";
  assert.equal(validateTouchPlayerEvidence(withRange, validServer()).nativeSeekRangeObserved, true);
  const mutants = [
    () => { const x = validUi(); x.checks.firstDecodeClockAdvanced = false; return [x, validServer()]; },
    () => { const x = validUi(); x.strictSeekSemanticObserved = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.strictSeekSemanticObserved = false; return [x, validServer()]; },
    () => { const x = validUi(); x.playbackClockObservationBasis = "none"; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackClockObservationBasis = "none"; return [x, validServer()]; },
    () => { const x = validUi(); x.nativeSeekRangeObserved = true; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.nativeSeekRangeObserved = true; return [x, validServer()]; },
    () => { const x = validUi(); x.playbackClockObservationBasis = "native-seekbar-range-plus-aria-valuetext"; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.pausedClockBeforeResumeSeconds = 6; return [x, validServer()]; },
    () => { const x = validUi(); x.manualGestureReviewRequired = false; return [x, validServer()]; },
    () => { const x = validUi(); x.manualGestureReviewCaptureLabels.reverse(); return [x, validServer()]; },
    () => { const x = validUi(); x.nativeDoubleTapInjectionUsed = false; return [x, validServer()]; },
    () => { const x = validUi(); x.doubleTapObservationBasis = "device-click"; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapObservationBasis = "device-click"; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.nativeDoubleTapInjectionUsed = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapGestureTimingValid = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapPlayerSafetyVerified = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapPointOutsideActionableControls = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapSecondDownUptimeMs = 1040; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapSecondDownUptimeMs = 1241; x.checks.doubleTapSecondUpUptimeMs = 1281; x.checks.doubleTapUpToUpGapMs = 241; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapUpToUpGapMs = 139; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.doubleTapPointXPx = 0; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.pausedSideDoubleTapDeltaSeconds = 12; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.postRotationAbsolutePositionSeconds = 18; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackActionsRailScrolled = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackActionsRailPanAttempts = 0; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackSettingsOpened = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackSettingsVerticalPanAttempts = 5; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.externalPlayerActionReachable = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.externalPlayerActionLaunched = true; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackSettingsUpwardPanAttempts = -1; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackActionsRailReturnPanAttempts = 5; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.playbackSettingsCloseUsed = false; return [x, validServer()]; },
    () => { const x = validUi(); x.checks.pausedJapanesePreservedAfterPlaybackSettings = false; return [x, validServer()]; },
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
