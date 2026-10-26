import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/android-runtime-check.yml", import.meta.url), "utf8");

function publicAdmissionScripts(source) {
  const marker = "  api30-stock-webview-guide:";
  const job = source.slice(source.indexOf(marker));
  const start = job.indexOf("- name: Download and admit exact public current release candidate");
  const end = job.indexOf("- name: Set up JDK 17");
  assert.ok(start > 0 && end > start);
  const scripts = [...job.slice(start, end).matchAll(
    /python3 - <<'PY'\n([\s\S]*?)\n          PY/g,
  )].map((match) => match[1]);
  assert.equal(scripts.length, 2);
  return scripts;
}

function validate(source) {
  const marker = "  api30-stock-webview-guide:";
  assert.equal(source.split(marker).length, 2);
  const job = source.slice(source.indexOf(marker));
  for (const literal of [
    'CANDIDATE_RUN_ID: "40238512551"',
    'CANDIDATE_RUN_WORKFLOW_ID: "387280245"',
    "CANDIDATE_RUN_HEAD_BRANCH: codex/touch-dialog-ux61",
    "CANDIDATE_SOURCE_SHA: e2dee689276610ffb1685a6f47ac37f183f35a7e",
    "CANDIDATE_APK_SHA256: a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247",
    'CANDIDATE_APK_SIZE: "88640385"',
    'CANDIDATE_RELEASE_ID: "423712065"',
    "CANDIDATE_RELEASE_TAG: android-v2.3.61",
    "CANDIDATE_TAG_OBJECT_SHA: c86f5788a8ae2984aca4087101d7b98532cb0c30",
    'CANDIDATE_APK_ASSET_ID: "676347366"',
    "CANDIDATE_MANIFEST_SHA256: 8828c76dd0696c7b70d548fcfdbb4657076825c5b40e5fa81b2ce1dd23be9815",
    "CANDIDATE_VERIFICATION_SHA256: 25afa6bca5261b02a0372eb0fc88934573ae2bce0091bd526007f963fe5b26b2",
    "CANDIDATE_CHECKSUMS_SHA256: 46ab6b40b63ea787feb33215df993d99898d023e4371b986b79d4eb1ac94e1a8",
    "CANDIDATE_CERT_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
    "CANDIDATE_APK: candidate/YAWF.Stream_Android_2.3.61.apk",
    "CANDIDATE_VERSION: 2.3.61", 'CANDIDATE_VERSION_CODE: "2003061"',
    "SYSTEM_IMAGE_PACKAGE: system-images;android-30;google_apis;x86_64",
  ]) assert.ok(job.includes(literal), `missing exact candidate binding: ${literal}`);
  assert.match(job, /test "\$\(git -C candidate-source rev-parse HEAD\)" = "\$CANDIDATE_SOURCE_SHA"/);
  const download = job.indexOf("- name: Download and admit exact public current release candidate");
  const verify = job.indexOf("python3 candidate-source/scripts/verify_android_apk.py");
  const install = job.indexOf('install --no-streaming "$CANDIDATE_APK"');
  assert.ok(download > 0 && verify > download && install > verify);
  assert.match(job, /https:\/\/api\.github\.com\/repos\/\$GITHUB_REPOSITORY/);
  assert.match(job, /https:\/\/github\.com\/\$GITHUB_REPOSITORY\/releases\/download\/\$CANDIDATE_RELEASE_TAG/);
  assert.match(job, /--proto '=https' --proto-redir '=https'/);
  assert.match(job, /--max-filesize "\$CANDIDATE_APK_SIZE"/);
  assert.match(job, /test "\$\(stat -c %s "\$CANDIDATE_APK"\)" = "\$CANDIDATE_APK_SIZE"/);
  assert.equal((job.match(/stat -c %s "\$CANDIDATE_APK"/g) ?? []).length, 2);
  assert.match(job, /sha256sum --check -/);
  assert.match(job, /classification=official-public-current-platform-runtime-fixture/);
  assert.match(job, /currentPlatformVerification=true/);
  assert.match(job, /legacy31CompatibilityEvidence=false/);
  assert.match(job, /automaticOtaEvidence=false/);
  assert.doesNotMatch(job, /continue-on-error|GH_TOKEN|CANDIDATE_DRAFT|actions\/download-artifact|private-historical-signed-fixture/);
  assert.doesNotMatch(job, /39857024891|23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3|YAWF\.Stream_Android_2\.3\.31\.apk/);
  const [metadata, assets] = publicAdmissionScripts(source);
  assert.match(metadata, /release\.get\("draft"\) is False and release\.get\("prerelease"\) is False/);
  assert.match(metadata, /set\(observed_assets\) == set\(expected_assets\)/);
  assert.match(metadata, /run\.get\("head_sha"\) == source/);
  assert.match(metadata, /release\.get\("target_commitish"\) == source/);
  assert.match(metadata, /tag\.get\("object", \{\}\)\.get\("sha"\) == source/);
  assert.match(assets, /verification\["certificateSha256"\] == os\.environ\["CANDIDATE_CERT_SHA256"\]/);
  assert.match(assets, /read_text\(\)\.splitlines\(\) == expected_sums/);
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

test("stock API30 guide uses exact public 61 bytes and remains native-only and bounded", () => {
  validate(workflow);
});

test("both jobs execute the same fail-closed public metadata and asset admission", () => {
  const runtime = workflow.slice(workflow.indexOf("  api30-runtime:"), workflow.indexOf("  api30-stock-webview-guide:"));
  const guide = workflow.slice(workflow.indexOf("  api30-stock-webview-guide:"));
  const extract = (job) => {
    const start = job.indexOf("- name: Download and admit exact public current release candidate");
    const end = job.indexOf("- name: Set up JDK 17");
    return [...job.slice(start, end).matchAll(/python3 - <<'PY'\n([\s\S]*?)\n          PY/g)].map((match) => match[1]);
  };
  assert.deepEqual(extract(runtime), extract(guide));
  assert.equal(extract(runtime).length, 2);
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
  ["APK identity", (s) => s.replaceAll("a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247", "0".repeat(64))],
  ["stock provider admission", (s) => s.replace("providers==[('com.google.android.webview','83.0.4103.106')]", "providers")],
  ["installed byte check", (s) => s.replaceAll('test "$installed_hash" = "$CANDIDATE_APK_SHA256"', 'test -n "$installed_hash"')],
  ["production signer verification", (s) => s.replaceAll("--certificate-pin candidate-source/web/src-tauri/SIGNING_CERT_SHA256", "--certificate-pin unknown")],
  ["host task evidence", (s) => s.replace("assert records, 'Unrecognized task dump format'", "assert True")],
  ["host task absence", (s) => s.replace("assert not any('com.tgk30.debridstreamer' in record for record in records)", "assert True")],
  ["false OTA claim", (s) => s.replace("assert receipt[key] is False", "assert receipt[key] is True")],
  ["unbounded evidence", (s) => s.replace("assert 0<len(data)<=8*1024*1024", "assert len(data)>0")],
  ["provider replacement", (s) => s + "\n          adb shell cmd webviewupdate set-webview-implementation com.android.webview\n"],
  ["XML redaction gate omitted", (s) => s.replace(" scripts/runtime_webview_hierarchy_redaction.test.mjs", "")],
  ["public release identity", (s) => s.replaceAll('CANDIDATE_RELEASE_ID: "423712065"', 'CANDIDATE_RELEASE_ID: "1"')],
  ["public release state", (s) => s.replaceAll('release.get("draft") is False', 'release.get("draft") is True')],
  ["public release source", (s) => s.replaceAll('release.get("target_commitish") == source', 'release.get("target_commitish") == "main"')],
  ["current public classification", (s) => s.replaceAll("classification=official-public-current-platform-runtime-fixture", "classification=private-fixture")],
  ["automatic OTA boundary", (s) => s.replaceAll("automaticOtaEvidence=false", "automaticOtaEvidence=true")],
  ["private token access", (s) => s.replaceAll("shell: bash\n        run:", "shell: bash\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run:")],
]) {
  test(`rejects mutated ${name}`, () => {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow);
    assert.throws(() => validate(changed));
  });
}
