import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/android-runtime-check.yml", import.meta.url), "utf8");

function validate(source) {
  const marker = "  api30-stock-webview-guide:";
  assert.equal(source.split(marker).length, 2);
  const job = source.slice(source.indexOf(marker));
  for (const literal of [
    'CANDIDATE_RUN_ID: "39834571270"',
    "CANDIDATE_SOURCE_SHA: 72bd21cf466d495349617bc3fab7a1ec59687c84",
    "CANDIDATE_APK_SHA256: 5029ad310fb15a93c2e2c29cb814e6a0c2dde2d2b0cfb239402553c77097c058",
    "CANDIDATE_APK: candidate/YAWF.Stream_Android_2.3.30.apk",
    "CANDIDATE_VERSION: 2.3.30", 'CANDIDATE_VERSION_CODE: "2003030"',
    "SYSTEM_IMAGE_PACKAGE: system-images;android-30;google_apis;x86_64",
  ]) assert.ok(job.includes(literal), `missing exact candidate binding: ${literal}`);
  assert.match(job, /test "\$\(git -C candidate-source rev-parse HEAD\)" = "\$CANDIDATE_SOURCE_SHA"/);
  const verify = job.indexOf("python3 candidate-source/scripts/verify_android_apk.py");
  const install = job.indexOf('install --no-streaming "$CANDIDATE_APK"');
  assert.ok(verify > 0 && install > verify);
  assert.match(job, /--certificate-pin candidate-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(job, /test "\$installed_hash" = "\$CANDIDATE_APK_SHA256"/);
  assert.match(job, /providers==\[\('com.google.android.webview','83.0.4103.106'\)\]/);
  assert.match(job, /RuntimeWebViewCompatibilityTest#unsupportedStockWebViewShowsNativeRecoveryOnly/);
  assert.match(job, /node --test scripts\/android_webview83_runtime_driver.test.mjs/);
  assert.match(job, /:app:assembleDebug :app:assembleDebugAndroidTest/);
  assert.match(job, /timeout 240s adb/);
  assert.match(job, /hostTaskRemovalCheckRequired'\] is True/);
  assert.match(job, /\['playbackTested','otaTested','providerInstalledOrUpdated','taskRemovalClaimed'\]/);
  assert.match(job, /assert receipt\[key\] is False/);
  assert.match(job, /\['shell','dumpsys','activity','recents'\]/);
  assert.match(job, /assert records, 'Unrecognized task dump format'/);
  assert.match(job, /assert not any\('com.tgk30.debridstreamer' in record for record in records\)/);
  assert.match(job, /timeout 10s adb -s "\$EMULATOR_SERIAL" emu kill/);
  assert.match(job, /kill "\$emulator_pid"/);
  assert.match(job, /trap cleanup EXIT/);
  assert.match(job, /assert 0<len\(names\)<=20/);
  assert.match(job, /assert allowed.fullmatch\(name\)/);
  assert.match(job, /assert 0<len\(data\)<=8\*1024\*1024/);
  assert.doesNotMatch(job, /set-webview-implementation|WEBVIEW_SOURCE_COMMIT|pm grant|appops|adb root|kill-server|start-server|javascript:|evaluateJavascript/);
  assert.equal((job.match(/avdmanager create avd/g) ?? []).length, 1);
}

test("stock API30 guide is exact-candidate, native-only, bounded, and separately corroborated", () => {
  validate(workflow);
});

function remoteLabelArguments(source) {
  const job = source.slice(source.indexOf("  api30-stock-webview-guide:"));
  const lines = job.split("\n").filter((line) => line.trim().startsWith("-e expectedWebViewLabel "));
  assert.equal(lines.length, 1);
  const command = lines[0].trim().replace(/\s*\\$/, "");
  const capture = 'capture() { printf "%s\\0" "$@"; }; capture ';
  const parse = (input) => {
    const result = spawnSync("sh", ["-c", capture + input], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\0").slice(0, -1);
  };
  // adb shell joins host argv with spaces before the remote shell parses it.
  return parse(parse(command).join(" "));
}

test("the fixed multiword App info label survives host and adb remote shell parsing", () => {
  assert.deepEqual(remoteLabelArguments(workflow), ["-e", "expectedWebViewLabel", "Android System WebView"]);
  const changed = workflow.replace('"\'Android System WebView\'"', "'Android System WebView'");
  assert.notEqual(changed, workflow);
  assert.notDeepEqual(remoteLabelArguments(changed), ["-e", "expectedWebViewLabel", "Android System WebView"]);
});

for (const [name, mutate] of [
  ["APK identity", (s) => s.replaceAll("5029ad310fb15a93c2e2c29cb814e6a0c2dde2d2b0cfb239402553c77097c058", "0".repeat(64))],
  ["stock provider admission", (s) => s.replace("providers==[('com.google.android.webview','83.0.4103.106')]", "providers")],
  ["installed byte check", (s) => s.replaceAll('test "$installed_hash" = "$CANDIDATE_APK_SHA256"', 'test -n "$installed_hash"')],
  ["production signer verification", (s) => s.replaceAll("--certificate-pin candidate-source/web/src-tauri/SIGNING_CERT_SHA256", "--certificate-pin unknown")],
  ["host task evidence", (s) => s.replace("assert records, 'Unrecognized task dump format'", "assert True")],
  ["host task absence", (s) => s.replace("assert not any('com.tgk30.debridstreamer' in record for record in records)", "assert True")],
  ["false OTA claim", (s) => s.replace("assert receipt[key] is False", "assert receipt[key] is True")],
  ["unbounded evidence", (s) => s.replace("assert 0<len(data)<=8*1024*1024", "assert len(data)>0")],
  ["provider replacement", (s) => s + "\n          adb shell cmd webviewupdate set-webview-implementation com.android.webview\n"],
]) {
  test(`rejects mutated ${name}`, () => {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow);
    assert.throws(() => validate(changed));
  });
}
