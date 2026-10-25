import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = process.env.ANDROID_CURRENT_RUNTIME_WORKFLOW
  ?? join(root, ".github/workflows/android-current-runtime.yml");
const workflow = readFileSync(workflowPath, "utf8");

function assertExternalPlayerOuterTimeout(source) {
  const marker = "\n  external-player-fixture:\n";
  assert.equal(source.split(marker).length, 2);
  const start = source.indexOf(marker);
  const nextJob = source.indexOf("\n  touch-player-fixture:\n", start + marker.length);
  assert.ok(nextJob > start);
  const externalPlayerJob = source.slice(start, nextJob);
  const externalLimits = [...externalPlayerJob.matchAll(/^    timeout-minutes: (\d+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(externalLimits, ["45"]);
  const allJobLimits = [...source.slice(0, source.indexOf("\n  touch-player-fixture:\n"))
    .matchAll(/^    timeout-minutes: (\d+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(allJobLimits, ["25", "45"]);
}

function extractSystemImageMetadataPolicy() {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) =>
    line.includes("# BEGIN OFFICIAL_SYSTEM_IMAGE_METADATA_POLICY"));
  const end = lines.findIndex((line) =>
    line.includes("# END OFFICIAL_SYSTEM_IMAGE_METADATA_POLICY"));
  assert.ok(start >= 0 && end > start, "metadata policy markers are missing");
  return lines.slice(start + 1, end)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function runSystemImageMetadataPolicy(metadata) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-sdk-metadata-"));
  const metadataPath = join(directory, "sdkmanager.txt");
  const receiptPath = join(directory, "receipt.txt");
  writeFileSync(metadataPath, metadata);
  const result = spawnSync("python3", ["-c", extractSystemImageMetadataPolicy()], {
    encoding: "utf8",
    env: {
      ...process.env,
      SDK_METADATA: metadataPath,
      SDK_ADMISSION_RECEIPT: receiptPath,
      SYSTEM_IMAGE_PACKAGE: "system-images;android-36;google_apis;x86_64",
    },
  });
  return {
    ...result,
    receipt: result.status === 0 ? readFileSync(receiptPath, "utf8") : "",
  };
}

test("is manual branch-only read-only supplementary coverage", () => {
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  (?:pull_request|push|schedule):/);
  assert.match(workflow, /if: github\.ref_type == 'branch'/);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
  assert.match(workflow, /acceptanceRuns=1-fresh-avd/);
  assert.match(workflow, /timeout-minutes: 25/);
});

test("pins one exact signed candidate without changing the public channel", () => {
  assert.match(workflow, /CANDIDATE_RUN_ID: "39857024891"/);
  assert.match(workflow, /CANDIDATE_SOURCE_SHA: e7e2b7796684bf437bb10fdc9fc51263a8ba016a/);
  assert.match(workflow, /CANDIDATE_APK_SHA256: 23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3/);
  assert.match(workflow, /CANDIDATE_VERSION: 2\.3\.31/);
  assert.match(workflow, /CANDIDATE_VERSION_CODE: "2003031"/);
  assert.match(workflow, /PUBLISHED_ANDROID_VERSION: 2\.3\.27/);
  assert.match(workflow, /--certificate-pin candidate-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(workflow, /python3 candidate-source\/scripts\/verify_android_apk\.py/);
});

test("admits an exact API 36 image row from installed or available SDK metadata", () => {
  assert.match(workflow, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64/);
  assert.match(workflow, /sdkmanager --list --channel=0/);
  assert.match(workflow, /sdkmanager --list_installed --channel=0/);
  assert.match(workflow, /sha256sum "\$image_root\/package\.xml" "\$image_root\/source\.properties"/);
  const packagePath = "system-images;android-36;google_apis;x86_64";
  const row = `${packagePath} | 8 | Google APIs Intel x86_64 Atom System Image`;
  const installed = runSystemImageMetadataPolicy(`Installed packages:\n${row}\nAvailable Packages:\n`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.receipt, /metadataSections=installed/);
  const available = runSystemImageMetadataPolicy(`Installed packages:\nAvailable Packages:\n${row}\nAvailable Updates:\n`);
  assert.equal(available.status, 0, available.stderr);
  assert.match(available.receipt, /metadataSections=available/);
  const suffix = runSystemImageMetadataPolicy(`Available Packages:\n${packagePath}-translation | 8 | Wrong package\n`);
  assert.notEqual(suffix.status, 0);
  const outside = runSystemImageMetadataPolicy(`${row}\nAvailable Packages:\n`);
  assert.notEqual(outside.status, 0);
});

test("treats the ABI list as informational while binding the primary ABI", () => {
  assert.match(workflow, /test "\$primary_abi" = "x86_64"/);
  assert.match(workflow, /echo "abiList=\$abi_list"/);
  assert.match(workflow, /abiListClassification=informational-only/);
  assert.doesNotMatch(workflow, /case ",\$abi_list,"|unexpectedly declares an ARM ABI/);
});

test("binds API ABI page size and stock WebView identity and hashes", () => {
  assert.match(workflow, /test "\$api_level" = "36"/);
  assert.match(workflow, /test "\$primary_abi" = "x86_64"/);
  assert.match(workflow, /test "\$page_size" = "4096"/);
  assert.ok(workflow.includes(String.raw`Current WebView package \(name, version\):`));
  assert.match(workflow, /assert major >= 90/);
  assert.match(workflow, /classification": "stock-system-image-provider"/);
  assert.match(workflow, /shell sha256sum "\$provider_path"/);
  assert.match(workflow, /--expected-webview-package "\$current_package"/);
  assert.match(workflow, /--expected-webview-version "\$current_version"/);
  assert.doesNotMatch(workflow, /set-webview-implementation|WEBVIEW_SOURCE_COMMIT|yawf-ci-webview/);
});

test("reuses the production verifier and persistent runtime driver unchanged", () => {
  const hashCheck = workflow.indexOf(
    `printf '%s  %s\\n' "$CANDIDATE_APK_SHA256" "$CANDIDATE_APK" | sha256sum -c -`,
  );
  const verifier = workflow.indexOf("candidate-source/scripts/verify_android_apk.py");
  const driver = workflow.indexOf("python3 scripts/android_phone_runtime_check.py \\");
  assert.ok(hashCheck >= 0);
  assert.ok(verifier > hashCheck);
  assert.ok(driver > verifier);
  assert.match(workflow, /scripts\/android-runtime-instrumentation\/policy_mutation_check\.py/);
  assert.match(workflow, /:app:assembleDebugAndroidTest/);
  assert.doesNotMatch(workflow, /settings put|run-as .*shared_prefs|javascript:|evaluateJavascript|adb root/);
});

test("uses one fresh owned emulator and scoped bounded cleanup", () => {
  assert.match(workflow, /acceptanceRuns=1-fresh-avd/);
  assert.doesNotMatch(workflow, /for run_number in|acceptanceRuns=2/);
  assert.match(workflow, /deadline=\$\(\(SECONDS \+ 300\)\)/);
  assert.match(workflow, /timeout 10s adb -s "\$EMULATOR_SERIAL" emu kill/);
  assert.match(workflow, /kill "\$emulator_pid"/);
  assert.doesNotMatch(workflow, /adb (?:kill-server|start-server)|pkill|killall/);
  assert.match(workflow, /if adb devices \| awk/);
});

test("states the proof limits in the durable evidence", () => {
  assert.match(workflow, /supplementaryCurrentApiCoverage=true/);
  assert.match(workflow, /arm16KiBProof=false/);
  assert.match(workflow, /otaTransactionProof=false/);
  assert.match(workflow, /latestWebViewSecurityProof=false/);
  assert.match(workflow, /classification=locally-generated-runtime-verification-metadata/);
  assert.match(workflow, /otaPublicationEvidence=false/);
});

test("external player fixture has a scoped 45-minute outer job budget", () => {
  assertExternalPlayerOuterTimeout(workflow);
});

test("external player outer timeout guard rejects the previous 30-minute cutoff", () => {
  const marker = "\n  external-player-fixture:\n";
  const [head, externalPlayerJob] = workflow.split(marker);
  const mutant = head + marker + externalPlayerJob.replace(
    "    timeout-minutes: 45",
    "    timeout-minutes: 30",
  );
  assert.notEqual(mutant, workflow);
  assert.throws(() => assertExternalPlayerOuterTimeout(mutant));
});
