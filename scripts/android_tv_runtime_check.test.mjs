import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, "..");
const hostPath = join(scripts, "android_tv_runtime_check.py");
const fixturePath = join(scripts, "android_tv_runtime_fixture.py");
const javaPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeTvFlowTest.java",
);
const manifestPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/main/AndroidManifest.xml",
);
const workflowPath = join(root, ".github/workflows/android-tv-runtime.yml");
const python = process.env.PYTHON || "python3";

const read = (path) => readFileSync(path, "utf8");

function runPythonSelfTest(path) {
  return spawnSync(python, [path, "self-test"], { encoding: "utf8" });
}

function killedPythonMutant(path, search, replacement, args = ["--self-test"]) {
  const original = read(path);
  assert.equal(original.split(search).length, 2, `mutation anchor must be unique: ${search}`);
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-mutant-"));
  const mutant = join(directory, path.endsWith("fixture.py") ? "fixture.py" : "host.py");
  writeFileSync(mutant, original.replace(search, replacement));
  const result = spawnSync(python, [mutant, ...args], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `semantic mutant survived:\n${result.stdout}\n${result.stderr}`);
}

function assertSetupEmulatorPath(source) {
  const start = source.indexOf("      - name: Admit exact official Android TV API 36 image revision");
  const end = source.indexOf("      - name: Run policy tests, generate fixture, and build isolated harness", start);
  assert.ok(start >= 0 && end > start, "SDK admission step must be explicit");
  const setup = source.slice(start, end);
  assert.ok(setup.includes('test -x "$sdk_root/emulator/emulator"'));
  assert.ok(setup.includes('"$sdk_root/emulator/emulator" -version'));
  assert.doesNotMatch(setup, /^\s*emulator -version/m);
}

function assertScopedVolumeCommand(source) {
  assert.ok(source.includes('adb -s "$EMULATOR_SERIAL" shell cmd media_session volume --stream 3 --set 0'));
  assert.doesNotMatch(source, /shell\s+media\s+volume/);
}

function assertHarnessVisibilityPolicy(source) {
  const queries = source.match(/<queries>[\s\S]*?<\/queries>/g) ?? [];
  assert.equal(queries.length, 1, "harness must have one package visibility block");
  assert.match(queries[0], /<package\s+android:name="com\.yawf\.stream\.tv"\s*\/>/);
  assert.equal((queries[0].match(/<package\b/g) ?? []).length, 1);
  assert.doesNotMatch(source, /QUERY_ALL_PACKAGES|<uses-permission\b/);
}

function assertWorkflowPolicy(source) {
  assertScopedVolumeCommand(source);
  assertSetupEmulatorPath(source);
  assert.match(source, /on:\s*\n\s*workflow_dispatch:\s*\n/);
  assert.match(source, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;android-tv;x86_64/);
  assert.match(source, /SYSTEM_IMAGE_REVISION: "4"/);
  assert.match(source, /Reject unresolved signed artifact pins before setup/);
  assert.match(source, /test "\$TV_RELEASE_TAG" = "v2\.3\.25-web"/);
  assert.equal((source.match(/TV_RELEASE_ID: 418070552/g) ?? []).length, 2);
  assert.equal((source.match(/TV_ASSET_ID: 660632273/g) ?? []).length, 2);
  assert.equal((source.match(/TV_APK_SHA256: fdd2ba7ae2c1badadf6177cde7271628380a7be05a22793fd9d3fb4a51dd6006/g) ?? []).length, 2);
  assert.equal((source.match(/TV_APK_SIZE: "5056474"/g) ?? []).length, 2);
  assert.match(source, /TV_SIGNER_SHA256: 6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e/);
  assert.match(source, /name: tv-signed-static-transport/);
  assert.match(source, /--validate-static-transport/);
  assert.match(source, /signed-source\/android-tv\/SIGNING_CERT_SHA256/);
  assert.match(source, /\[\[ "\$TV_APK_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(source, /test -z "\$\(adb devices/);
  assert.match(source, /-port 5556/);
  assert.match(source, /reverse "tcp:\$FIXTURE_PORT" "tcp:\$FIXTURE_PORT"/);
  assert.doesNotMatch(source, /adb\s+kill-server|adb\s+start-server|pm\s+grant|appops|run-as\s+com\.yawf\.stream\.tv/);
  const readOnlyJob = source.slice(source.indexOf("  signed-tv-api36:"));
  const privilegedJob = source.slice(source.indexOf("  transport:"), source.indexOf("  signed-tv-api36:"));
  assert.doesNotMatch(readOnlyJob, /GH_TOKEN|contents:\s*write|gh\s+(api|release)/);
  assert.doesNotMatch(privilegedJob, /actions\/checkout|scripts\/|npm |node |gradle |cargo /);
  assert.match(privilegedJob, /contents: write/);
  assert.match(privilegedJob, /git\/ref\/tags\/\$TV_RELEASE_TAG/);
  assert.match(privilegedJob, /actions\/runs\/\$TV_SIGNING_RUN_ID/);
  assert.match(readOnlyJob, /needs: transport/);
  assert.match(readOnlyJob, /permissions:\s*\n      contents: read\s*\n      actions: read/);
  assert.match(readOnlyJob, /uses: actions\/download-artifact@v4/);
  assert.doesNotMatch(source, /input\s+(tap|swipe|text)/);
  const finish = source.slice(source.indexOf("finish() {"), source.indexOf("trap finish EXIT"));
  assert.ok(finish.indexOf("capture_failure") < finish.indexOf("cleanup"));
  assert.match(source, /captureBeforeCleanup=true/);
  assert.match(source, /assert packages == \["com\.yawf\.stream\.tv"\], packages/);
}

function javaMethod(source, name) {
  const signature = new RegExp(`private\\s+[A-Za-z0-9_<>]+\\s+${name}\\(`);
  const match = signature.exec(source);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unclosed Java method ${name}`);
}

function assertObservationOnly(source) {
  for (const name of ["waitForPositionAtLeast", "readPositionSeconds"]) {
    const body = javaMethod(source, name);
    assert.doesNotMatch(body, /press(?:DPad|KeyCode)|revealControls|focusAndActivate|focusTarget/);
  }
  assert.match(source, /playPauseSelector\("Pause"\).*semantic Pause state before pausing/s);
  assert.match(source, /playPauseSelector\("Play"\).*semantic Play state before resuming/s);
}

function assertImeDismissalPolicy(source) {
  assert.match(source,
    /private static final String PINNED_TV_IME = "com\.google\.android\.inputmethod\.latin";/);
  const flow = javaMethod(source, "runFlow");
  const addressVerified = flow.indexOf(
    'assertEquals("Server address was not entered through the visible UI", FIXTURE_URL, address.getText());',
  );
  const dismissal = flow.indexOf("dismissVisiblePinnedTvIme();");
  const connect = flow.indexOf('focusAndActivate(By.text("Connect"), "Connect", 6);');
  assert.ok(addressVerified >= 0 && addressVerified < dismissal && dismissal < connect,
    "the exact entered address must be verified before IME dismissal and Connect activation");

  const body = javaMethod(source, "dismissVisiblePinnedTvIme");
  assert.match(body, /BySelector imeSelector = By\.pkg\(PINNED_TV_IME\);/);
  assert.match(body,
    /UiObject2 ime = waitFor\(imeSelector, UI_WAIT, "visible pinned TV input method"\);/);
  assert.match(body, /!ime\.getVisibleBounds\(\)\.isEmpty\(\)/);
  assert.equal((body.match(/device\.pressBack\(\)/g) ?? []).length, 1,
    "IME dismissal must send exactly one remote Back");
  assert.match(body, /device\.wait\(Until\.gone\(imeSelector\), UI_WAIT\)/);
  assert.doesNotMatch(body,
    /executeShellCommand|input\s+keyevent|pressDPad|pressKeyCode|\.click\s*\(|\bfor\s*\(|\bwhile\s*\(/);
}

function assertJavaSemanticPolicy(source) {
  for (const marker of [
    'assertTrue("Playback position did not advance"',
    'assertTrue("Decoded center frame did not change while playback advanced"',
    'assertTrue("Position advanced materially while paused"',
    'assertTrue("D-pad seek did not move by a meaningful delta"',
    'assertTrue("Back did not restore focus to the WebView or one of its descendants"',
    'checks.put("decodedFrameChanged", true)',
    'checks.put("playbackRecoveredAfterError", true)',
    'checks.put("fitGeometryVerified", false)',
  ]) assert.ok(source.includes(marker), marker);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /input\s+(tap|swipe)|executeShellCommand|SharedPreferences/);
}

test("host admission and semantic receipt policy self-tests execute", () => {
  const result = spawnSync(python, [hostPath, "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 8 tests/);
});

test("fixture path and native bridge contract self-tests execute", () => {
  const result = runPythonSelfTest(fixturePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 2 tests/);
});

test("host tests kill removal of decoded-frame semantic admission", () => {
  killedPythonMutant(hostPath, '"playingPositionAdvanced", "decodedFrameChanged", "pauseStable",',
    '"playingPositionAdvanced", "pauseStable",');
});

test("host tests kill replacement-install admission regression", () => {
  killedPythonMutant(hostPath,
    'if list(command)[-3:] != ["install", "--no-streaming", str(product_apk)]:',
    'if list(command)[-2:] != ["-r", str(product_apk)]:');
});

test("host tests kill removal of diagnostic URL redaction", () => {
  killedPythonMutant(hostPath,
    'value = URL.sub("<redacted-url>", value)',
    'value = value');
});

test("fixture tests kill traversal and bridge payload regressions independently", () => {
  killedPythonMutant(fixturePath,
    'if not url_path.startswith("/media/") or ".." in decoded.parts:',
    'if not url_path.startswith("/media/"):');
  killedPythonMutant(fixturePath,
    "title:'YAWF Android TV 4:3 runtime fixture',sourceFileName:'fixture-master.m3u8',",
    "title:'YAWF Android TV 4:3 runtime fixture',sourceFileName:'fixture-master.mp4',");
});

test("workflow is manual, fail-closed, revision-4 TV-only, and device scoped", () => {
  const source = read(workflowPath);
  assertWorkflowPolicy(source);
  for (const [before, after] of [
    ["TV_RELEASE_ID: 418070552", "TV_RELEASE_ID: 1"],
    ["TV_ASSET_ID: 660632273", "TV_ASSET_ID: 1"],
    ["TV_APK_SHA256: fdd2ba7ae2c1badadf6177cde7271628380a7be05a22793fd9d3fb4a51dd6006", "TV_APK_SHA256: " + "0".repeat(64)],
    ['TV_APK_SIZE: "5056474"', 'TV_APK_SIZE: "0"'],
    ["TV_SIGNER_SHA256: 6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e", "TV_SIGNER_SHA256: " + "0".repeat(64)],
  ]) {
    assert.ok(source.includes(before));
    assert.throws(() => assertWorkflowPolicy(source.replace(before, after)));
  }
  assert.throws(() => assertWorkflowPolicy(source.replace(
    'SYSTEM_IMAGE_REVISION: "4"', 'SYSTEM_IMAGE_REVISION: "3"')));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    'if [ "$result" -ne 0 ]; then capture_failure; fi\n            cleanup',
    'cleanup\n            if [ "$result" -ne 0 ]; then capture_failure; fi')));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    "name: Retrieve only fixed asset metadata and bytes without repository checkout",
    "uses: actions/checkout@v4")));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    "name: Download the isolated static transport artifact",
    "name: Download the isolated static transport artifact\n        env:\n          GH_TOKEN: forbidden")));
});

test("SDK admission invokes the newly installed emulator before PATH becomes available", () => {
  const source = read(workflowPath);
  assertSetupEmulatorPath(source);
  const mutant = source.replace('"$sdk_root/emulator/emulator" -version', 'emulator -version');
  assert.notEqual(mutant, source);
  assert.throws(() => assertSetupEmulatorPath(mutant));
});

test("TV muting uses the media_session service rather than the absent legacy shell binary", () => {
  const source = read(workflowPath);
  assertScopedVolumeCommand(source);
  const mutant = source.replace('shell cmd media_session volume', 'shell media volume');
  assert.notEqual(mutant, source);
  assert.throws(() => assertScopedVolumeCommand(mutant));
});

test("TV harness can discover only the exact signed product package", () => {
  const source = read(manifestPath);
  assertHarnessVisibilityPolicy(source);
  const missing = source.replace(/\s*<queries>[\s\S]*?<\/queries>\s*/, "\n");
  assert.notEqual(missing, source);
  assert.throws(() => assertHarnessVisibilityPolicy(missing));
  const wrongPackage = source.replace("com.yawf.stream.tv", "com.yawf.stream.wrong");
  assert.notEqual(wrongPackage, source);
  assert.throws(() => assertHarnessVisibilityPolicy(wrongPackage));
});

test("TV setup dismisses the exact visible pinned IME once before focusing Connect", () => {
  const source = read(javaPath);
  assertImeDismissalPolicy(source);
  const mutants = [
    source.replace(
      '        device.pressBack();\n        assertTrue("Pinned TV input method did not dismiss after one remote Back",',
      '        assertTrue("Pinned TV input method did not dismiss after one remote Back",',
    ),
    source.replace("Until.gone(imeSelector)", "Until.hasObject(imeSelector)"),
    source.replace("com.google.android.inputmethod.latin", "com.google.android.inputmethod.wrong"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, source);
    assert.throws(() => assertImeDismissalPolicy(mutant));
  }
});

test("position observers cannot toggle or repair playback", () => {
  const source = read(javaPath);
  assertObservationOnly(source);
  const mutant = source.replace(
    "while (SystemClock.uptimeMillis() < deadline) {",
    "while (SystemClock.uptimeMillis() < deadline) { device.pressDPadCenter();",
  );
  assert.throws(() => assertObservationOnly(mutant));
});

test("instrumentation requires observable playback behavior rather than click-only success", () => {
  const source = read(javaPath);
  assertJavaSemanticPolicy(source);
  assertObservationOnly(source);
  assert.match(source, /webView\.isFocused\(\) \|\| webView\.findObject\(By\.focused\(true\)\) != null/);
  const mutant = source.replace(
    'checks.put("decodedFrameChanged", true);',
    'checks.put("decodedFrameChanged", false);',
  );
  assert.throws(() => assertJavaSemanticPolicy(mutant));
});

test("all five admission files compile or parse without touching Android SDK", () => {
  execFileSync(python, ["-c", [
    "from pathlib import Path",
    `compile(Path(${JSON.stringify(hostPath)}).read_text(), ${JSON.stringify(hostPath)}, 'exec')`,
    `compile(Path(${JSON.stringify(fixturePath)}).read_text(), ${JSON.stringify(fixturePath)}, 'exec')`,
  ].join(";")]);
  JSON.parse(execFileSync(python, ["-c", [
    "import json,re,pathlib",
    `s=pathlib.Path(${JSON.stringify(javaPath)}).read_text()`,
    "assert s.count('{')==s.count('}')",
    "print(json.dumps({'javaBraceBalance':True}))",
  ].join(";")], { encoding: "utf8" }));
  assertWorkflowPolicy(read(workflowPath));
});
