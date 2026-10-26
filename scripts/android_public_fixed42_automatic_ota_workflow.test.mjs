import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkflow = path.join(
  root,
  ".github/workflows/android-public-fixed42-automatic-ota-runtime.yml",
);
const workflowPath = process.env.FIXED42_WORKFLOW_SOURCE == null
  ? defaultWorkflow
  : path.resolve(process.env.FIXED42_WORKFLOW_SOURCE);
const source = fs.readFileSync(workflowPath, "utf8");
const runtimeSource = fs.readFileSync(
  path.join(root, "scripts/android_public_ota_runtime_check.py"),
  "utf8",
);

function need(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function contract(yaml) {
  for (const token of [
    "BASELINE_VERSION: 2.3.42",
    'BASELINE_VERSION_CODE: "2003042"',
    "BASELINE_SOURCE_SHA: ae9b35f8513c9f7e203508f2c95f1f99d77ddcf5",
    "BASELINE_BUILD_RUN: \"40025606020\"",
    "BASELINE_APK_SHA256: 3e1f72c2d1214b491fb505b5ea85ccc507d2478288066ff9cf846c5924d1805c",
    "BASELINE_APK_SIZE: \"88583041\"",
    "BASELINE_MANIFEST_SHA256: 26fedf40c35011ecf3edaa29462c18f04301dafae7dd9e3808e1ea1e2a3001a8",
    "BASELINE_VERIFICATION_SHA256: a87360645d7700f7c2ff9a99629d714b7d126fbe5d66a9a2e44a10baad42c4dc",
    "TARGET_VERSION: 2.3.59",
    'TARGET_VERSION_CODE: "2003059"',
    "TARGET_SOURCE_SHA: ac885bb98b2672614beb801b5aea11eb2f98ab40",
    "TARGET_BUILD_RUN: \"40169716770\"",
    "TARGET_APK_SHA256: 5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47",
    "TARGET_APK_SIZE: \"88644481\"",
    "TARGET_MANIFEST_SHA256: 8d0f680abc7d52cd467ef79b3fd860e18c7e1dd15a7c5fd765a9d3941c974af6",
    "TARGET_VERIFICATION_SHA256: 28ccb986f613b68917a907b5dd9632c02e98185413ce9d09bc745eb564541294",
    "UPDATER_SOURCE_SHA256: 129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d",
    "OTA_MODE: public-fixed42-to59-initial-cancel-due-resume-v1",
  ]) need(yaml, token, `fixed workflow lost ${token}`);
  assert.equal(yaml.includes("inputs."), false, "fixed profile admits arbitrary dispatch inputs");
  assert.equal(yaml.includes("workflow_dispatch:\n    inputs:"), false, "fixed profile exposes inputs");
}

function mutate(original, replacement) {
  need(source, original, `mutation anchor is missing: ${original}`);
  const changed = source.replace(original, replacement);
  assert.throws(() => contract(changed));
}

test("workflow is a separately named immutable 2.3.42 to 2.3.59 profile", () => {
  contract(source);
  mutate("BASELINE_VERSION: 2.3.42", "BASELINE_VERSION: 2.3.27");
  mutate("TARGET_VERSION: 2.3.59", "TARGET_VERSION: 2.3.60");
  mutate(
    "OTA_MODE: public-fixed42-to59-initial-cancel-due-resume-v1",
    "OTA_MODE: automatic-initial-cancel-due-resume",
  );
});

test("workflow freshly admits both official public release records and every required asset", () => {
  for (const token of [
    '"$repo/$BASELINE_TAG/YAWF.Stream_Android_${BASELINE_VERSION}.apk"',
    '"$repo/$BASELINE_TAG/android-update.json"',
    '"$repo/$BASELINE_TAG/Android_${BASELINE_VERSION}_verification.json"',
    '"$repo/$BASELINE_TAG/SHA256SUMS"',
    '"$repo/$TARGET_TAG/YAWF.Stream_Android_${TARGET_VERSION}.apk"',
    '"$repo/$TARGET_TAG/android-update.json"',
    '"$repo/$TARGET_TAG/Android_${TARGET_VERSION}_verification.json"',
    '"$repo/$TARGET_TAG/SHA256SUMS"',
    '"https://api.github.com/repos/Tgk-30/YAWF-Stream/releases?per_page=20&page=$page"',
    '"publishedAt": release.get("published_at")',
    '"targetCommitish": release.get("target_commitish")',
    'node scripts/android_public_fixed42_automatic_ota_admission.mjs',
  ]) need(source, token, `fresh publication admission lost ${token}`);
  const changed = source.replace('"targetCommitish": release.get("target_commitish")', '"targetCommitish": os.environ["TARGET_SOURCE_SHA"]');
  assert.equal(changed.includes('"targetCommitish": release.get("target_commitish")'), false);
});

test("workflow checks out both exact sources and proves updater byte identity", () => {
  for (const token of [
    "ref: ${{ env.BASELINE_SOURCE_SHA }}",
    "path: baseline-source",
    "ref: ${{ env.TARGET_SOURCE_SHA }}",
    "path: target-source",
    'test "$(git -C baseline-source rev-parse HEAD)" = "$BASELINE_SOURCE_SHA"',
    'test "$(git -C target-source rev-parse HEAD)" = "$TARGET_SOURCE_SHA"',
    "baseline-source/scripts/android/YawfAndroidUpdater.kt | sha256sum -c -",
    "target-source/scripts/android/YawfAndroidUpdater.kt | sha256sum -c -",
  ]) need(source, token, `source admission lost ${token}`);
});

test("workflow pins Node 24.22.1, JDK 17, API 36, and executes the new gates", () => {
  for (const token of [
    'node-version: "24.22.1"',
    'test "$(node --version)" = "v24.22.1"',
    'java-version: "17"',
    "system-images;android-36;google_apis;x86_64",
    "scripts/android_public_fixed42_automatic_ota_admission.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_policy.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_driver.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_workflow.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_host.test.py",
  ]) need(source, token, `tool or gate pin lost ${token}`);
  const changed = source.replace('node-version: "24.22.1"', 'node-version: "node"');
  assert.equal(changed.includes('node-version: "24.22.1"'), false);
});

test("target APK remains a host reference and only the baseline is installed through ADB", () => {
  need(source, "AUTOMATIC_BINDING: public-assets/fixed42-automatic-admission.json", "fixed host binding is absent");
  need(source, '--baseline-apk "$BASELINE_APK"', "baseline host input is absent");
  need(source, '--target-apk "$TARGET_APK"', "target host reference is absent");
  assert.equal(/adb[^\n]*(?:install|push)[^\n]*\$TARGET_APK/.test(source), false);
  assert.equal(/adb[^\n]*(?:install|push)[^\n]*YAWF\.Stream_Android_2\.3\.59\.apk/.test(source), false);
  need(source, "python3 scripts/android_public_ota_runtime_check.py", "guarded host driver is absent");
});

test("recorded protocol separates automatic discovery from one later manual inspection", () => {
  for (const token of [
    'echo "preOfferManualDiscoveries=0"',
    'echo "postInstallManualInspectionChecks=1"',
    'echo "postInstallNativeOkClosures=1"',
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=false"',
  ]) need(source, token, `binding non-claim lost ${token}`);
  const changed = source.replace(
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=false"',
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=true"',
  );
  assert.equal(changed.includes('echo "automaticDiscoveryProofIncludesPostInstallInspection=false"'), false);
});

test("failure trap always retains bounded host health before conditional device evidence", () => {
  for (const token of [
    "collect_fixed42_host_failure_diagnostics",
    '--fixed42-host-failure-diagnostics',
    '--fixed42-device-capture-gate',
    '--emulator-pid-liveness "$emulator_pid_liveness"',
    '--emulator-exit-status "$emulator_exit_status"',
    '--runner-temp "$RUNNER_TEMP"',
    '--workspace "$GITHUB_WORKSPACE"',
    'command -v adb',
    'status=$?',
    'exit "$status"',
  ]) need(source, token, `bounded host failure observation lost ${token}`);
  for (const token of [
    'sha256_file(resolved_adb)',
    'os.statvfs(path)',
    '"MemAvailable"',
    '[str(resolved_adb), "version"]',
    '[str(resolved_adb), "-s", serial, "get-state"]',
    'workflow-host-diagnostics.json',
    '"workflow-adb-get-state"',
    'f"{stem}-{stream}-retention.json"',
  ]) need(runtimeSource, token, `bounded host failure observation lost ${token}`);

  const hostStart = source.indexOf("collect_fixed42_host_failure_diagnostics");
  const deviceGate = source.indexOf('if [ "$get_state" != "device" ]', hostStart);
  assert.ok(hostStart >= 0, "host evidence must be collected");
  assert.equal(deviceGate, -1, "stdout text alone must not admit device capture");
  const semanticGate = source.indexOf("--fixed42-device-capture-gate", hostStart);
  const deviceUnavailable = source.indexOf('echo "deviceEvidence=unavailable"', semanticGate);
  assert.ok(semanticGate > hostStart && deviceUnavailable > semanticGate,
    "validated host receipt must gate conditional device evidence");
  assert.equal(source.includes("adb reconnect"), false);
  assert.equal(source.includes("adb kill-server"), false);
  assert.equal(source.includes("adb start-server"), false);
  assert.equal(/\bps\s+(?:aux|-[a-z]*e)/.test(source), false, "failure evidence must not enumerate processes");
  assert.equal(/\benv\b\s*>/.test(source), false, "failure evidence must not dump environment values");
});
