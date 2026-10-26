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
    'CANDIDATE_RUN_ID: "39857024891"',
    'CANDIDATE_RUN_WORKFLOW_ID: "299659497"',
    "CANDIDATE_RUN_HEAD_BRANCH: codex/qa-platform-release-2326",
    "CANDIDATE_SOURCE_SHA: e7e2b7796684bf437bb10fdc9fc51263a8ba016a",
    "CANDIDATE_APK_SHA256: 23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3",
    'CANDIDATE_APK_SIZE: "88558465"',
    "CANDIDATE_ACTIONS_ARTIFACT: android-phone-verification-candidate",
    'CANDIDATE_DRAFT_RELEASE_ID: "421230453"',
    "CANDIDATE_DRAFT_RELEASE_TAG: v2.3.31-web",
    "CANDIDATE_DRAFT_TAG_OBJECT_SHA: 7672ea318acecd01d449cf9f71ade3509bfc3d3d",
    "CANDIDATE_DRAFT_TAG_COMMIT_SHA: 25fb08df12a24c535113b745328f72cb63a3b51e",
    'CANDIDATE_DRAFT_ASSET_ID: "667390405"',
    "CANDIDATE_DRAFT_ASSET_NAME: YAWF.Stream_Android_2.3.31.apk",
    "CANDIDATE_APK: candidate/YAWF.Stream_Android_2.3.31.apk",
    "CANDIDATE_VERSION: 2.3.31", 'CANDIDATE_VERSION_CODE: "2003031"',
    "SYSTEM_IMAGE_PACKAGE: system-images;android-30;google_apis;x86_64",
  ]) assert.ok(job.includes(literal), `missing exact candidate binding: ${literal}`);
  assert.match(job, /test "\$\(git -C candidate-source rev-parse HEAD\)" = "\$CANDIDATE_SOURCE_SHA"/);
  const resolve = job.indexOf("- name: Resolve exact private historical candidate delivery");
  const actions = job.indexOf("- name: Download exact signed candidate Actions artifact");
  const draft = job.indexOf("- name: Recover exact signed candidate from authenticated draft asset");
  const verify = job.indexOf("python3 candidate-source/scripts/verify_android_apk.py");
  const install = job.indexOf('install --no-streaming "$CANDIDATE_APK"');
  assert.ok(resolve > 0 && actions > resolve && draft > actions && verify > draft && install > verify);
  assert.match(job, /if: steps\.candidate_source\.outputs\.kind == 'actions'[\s\S]*uses: actions\/download-artifact@v4/);
  assert.match(job, /if: steps\.candidate_source\.outputs\.kind == 'draft'[\s\S]*timeout 180s gh api[\s\S]*releases\/assets\/\$CANDIDATE_DRAFT_ASSET_ID/);
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job, /test "\$\(stat -c %s "\$CANDIDATE_APK"\)" = "\$CANDIDATE_APK_SIZE"/);
  assert.equal((job.match(/stat -c %s "\$CANDIDATE_APK"/g) ?? []).length, 2);
  assert.match(job, /sha256sum --check -/);
  assert.match(job, /assert total == 0, "Candidate Actions artifact is missing from a nonempty inventory"/);
  assert.match(job, /classification=private-historical-signed-fixture/);
  assert.match(job, /releasedOta=false/);
  assert.match(job, /publicDownload=false/);
  assert.match(job, /otaPublicationEvidence=false/);
  assert.doesNotMatch(job, /continue-on-error|browser_download_url/);
  assert.match(job, /--certificate-pin candidate-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(job, /test "\$installed_hash" = "\$CANDIDATE_APK_SHA256"/);
  assert.match(job, /providers==\[\('com.google.android.webview','83.0.4103.106'\)\]/);
  assert.match(job, /RuntimeWebViewCompatibilityTest#unsupportedStockWebViewShowsNativeRecoveryOnly/);
  assert.match(job, /node --test scripts\/android_webview83_runtime_driver.test.mjs/);
  assert.match(job, /node --test scripts\/android_webview83_runtime_driver.test.mjs scripts\/runtime_webview_hierarchy_redaction.test.mjs/);
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

test("both jobs execute the same fail-closed metadata resolver before selecting a delivery path", () => {
  const blocks = [...workflow.matchAll(
    /- name: Resolve exact private historical candidate delivery[\s\S]*?python3 - <<'PY'\n([\s\S]*?)\n          PY/g,
  )].map((match) => match[1]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], blocks[1]);
  for (const required of [
    'run.get("head_sha") == source_sha',
    'release.get("draft") is True and release.get("immutable") is False',
    'asset = get(f"releases/assets/{asset_id}")',
    'comparison = get(f"compare/{source_sha}...{tag_commit}")',
  ]) {
    assert.ok(blocks[0].includes(required));
  }
  assert.doesNotMatch(blocks[0], /except\s/);
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
  ["APK identity", (s) => s.replaceAll("23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3", "0".repeat(64))],
  ["stock provider admission", (s) => s.replace("providers==[('com.google.android.webview','83.0.4103.106')]", "providers")],
  ["installed byte check", (s) => s.replaceAll('test "$installed_hash" = "$CANDIDATE_APK_SHA256"', 'test -n "$installed_hash"')],
  ["production signer verification", (s) => s.replaceAll("--certificate-pin candidate-source/web/src-tauri/SIGNING_CERT_SHA256", "--certificate-pin unknown")],
  ["host task evidence", (s) => s.replace("assert records, 'Unrecognized task dump format'", "assert True")],
  ["host task absence", (s) => s.replace("assert not any('com.tgk30.debridstreamer' in record for record in records)", "assert True")],
  ["false OTA claim", (s) => s.replace("assert receipt[key] is False", "assert receipt[key] is True")],
  ["unbounded evidence", (s) => s.replace("assert 0<len(data)<=8*1024*1024", "assert len(data)>0")],
  ["provider replacement", (s) => s + "\n          adb shell cmd webviewupdate set-webview-implementation com.android.webview\n"],
  ["XML redaction gate omitted", (s) => s.replace(" scripts/runtime_webview_hierarchy_redaction.test.mjs", "")],
  ["fallback release identity", (s) => s.replaceAll('CANDIDATE_DRAFT_RELEASE_ID: "421230453"', 'CANDIDATE_DRAFT_RELEASE_ID: "1"')],
  ["empty-inventory admission", (s) => s.replaceAll('assert total == 0, "Candidate Actions artifact is missing from a nonempty inventory"', "assert total >= 0")],
  ["private fixture classification", (s) => s.replaceAll("classification=private-historical-signed-fixture", "classification=public-release")],
  ["authenticated draft download", (s) => s.replaceAll('GH_TOKEN: ${{ github.token }}', "GH_TOKEN: unavailable")],
]) {
  test(`rejects mutated ${name}`, () => {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow);
    assert.throws(() => validate(changed));
  });
}
