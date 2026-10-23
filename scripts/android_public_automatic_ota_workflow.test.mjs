import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/android-public-automatic-ota-runtime.yml");
const hostPath = resolve(root, "scripts/android_public_ota_runtime_check.py");

function validateWorkflow(source) {
  const failures = [];
  const need = (token, message) => {
    if (!source.includes(token)) failures.push(message);
  };
  need("workflow_dispatch:", "manual dispatch is missing");
  if (/\n\s+(?:push|pull_request|schedule):/.test(source)) failures.push("automatic trigger is forbidden");
  need("permissions:\n  contents: read", "read-only contents permission is missing");
  need("github.repository == 'Tgk-30/YAWF-Stream'", "repository scope is missing");
  need("github.repository_owner == 'Tgk-30'", "owner scope is missing");
  need("github.actor == 'Tgk-30'", "dispatch actor scope is missing");
  need("github.ref_type == 'branch'", "branch scope is missing");
  if (!/^\s{4}timeout-minutes: 45$/m.test(source)) failures.push("45-minute outer SDK bound is missing");

  const exactPins = [
    "BASELINE_VERSION: 2.3.27",
    'BASELINE_VERSION_CODE: "2003027"',
    "BASELINE_TAG: android-v2.3.27",
    "BASELINE_SOURCE_SHA: 9fc94a237d99b849cfc18a01085bb487915dd978",
    "BASELINE_APK_SHA256: f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb",
    'BASELINE_APK_SIZE: "88558465"',
    "BASELINE_APK: public-assets/YAWF.Stream_Android_2.3.27.apk",
    "OTA_MODE: automatic-initial-cancel-due-resume",
  ];
  exactPins.forEach((pin) => need(pin, `missing exact public 2.3.27 pin: ${pin}`));

  for (const input of [
    "target_version", "target_version_code", "target_source_revision", "target_build_run",
    "target_apk_sha256", "target_apk_size", "target_manifest_sha256",
    "target_verification_sha256",
  ]) {
    const match = new RegExp(`^      ${input}:\\n([\\s\\S]*?)(?=^      [a-z_]+:|^\\npermissions:)`, "m").exec(source);
    if (match == null || !/required: true/.test(match[1]) || /default:/.test(match[1])) {
      failures.push(`future tuple input ${input} is not explicit and default-free`);
    }
  }
  if (/TARGET_(?:VERSION|VERSION_CODE|SOURCE_SHA|BUILD_RUN|APK_SHA256|APK_SIZE):\s+(?!\$\{\{ inputs\.)/.test(source)) {
    failures.push("a future target field is hardcoded instead of explicit input");
  }
  if (/\b(?:2\.3\.31|2003031)\b/.test(source)) failures.push("nonexistent public 2.3.31 was inferred");

  need("node scripts/android_public_automatic_ota_admission.mjs", "current admission helper is not executed");
  need('--verify-inputs-only \\\n            --automatic-binding "$AUTOMATIC_BINDING"', "byte preflight is not bound to admission");
  need('--verify-apks-only \\\n            --automatic-binding "$AUTOMATIC_BINDING"', "both downloaded APK identities are not host-verified");
  need('--apksigner "${ANDROID_SDK_ROOT:-$ANDROID_HOME}/build-tools/36.0.0/apksigner"', "apksigner is missing");
  need('--apkanalyzer "$(command -v apkanalyzer)"', "manifest identity verification is missing");
  need('assert digest(os.environ["TARGET_MANIFEST"]) == os.environ["TARGET_MANIFEST_SHA256"]', "actual manifest bytes are not bound");
  need('assert digest(os.environ["TARGET_VERIFICATION"]) == os.environ["TARGET_VERIFICATION_SHA256"]', "actual verification bytes are not bound");
  need('"targetCommitish": release.get("target_commitish")', "official source metadata is not admitted");
  need('"publishedAt": release.get("published_at")', "official publication metadata is not admitted");
  need('"targetBuildRun": os.environ["TARGET_BUILD_RUN"]', "build run is not compared to explicit input");
  need('test "$(git -C target-source rev-parse HEAD)" = "$TARGET_SOURCE_SHA"', "target source checkout is not exact");
  need("persistenceProof=task-relaunch-only", "task-relaunch-only boundary is missing");
  need("independentColdProcessProof=false", "cold-process non-claim is missing");
  need("if: always()", "bounded evidence upload on failure is missing");
  need("system-images;android-36;google_apis;x86_64", "official API 36 image identity is missing");
  need('if adb devices | awk', "pre-attached device rejection is missing");
  need('stop_owned_emulator()', "owned emulator cleanup is missing");
  need('--flow-timeout 720', "bounded UI flow timeout is missing");

  const preflight = source.indexOf("Admit official public tuple and bind actual bytes before SDK setup");
  const jdk = source.indexOf("Set up JDK 17");
  const sdk = source.indexOf("Set up Android SDK command line tools");
  if (!(preflight >= 0 && jdk > preflight && sdk > preflight)) {
    failures.push("official public admission does not fail before SDK setup");
  }
  const runtime = source.slice(source.indexOf("Run one public automatic native OTA"));
  if (!runtime.includes('--automatic-binding "$AUTOMATIC_BINDING"')) {
    failures.push("runtime driver is not bound to the admitted tuple");
  }
  if (runtime.includes('--ota-mode "$OTA_MODE"') || /manual-reconsent|CHECK_NOW|tapVisibleAndroidUpdateCheckCard/.test(runtime)) {
    failures.push("manual fallback or reconsent was admitted into automatic runtime");
  }
  for (const line of source.split("\n")) {
    if (/^\s*adb\b/.test(line) && /\$TARGET_APK|YAWF\.Stream_Android/.test(line)) {
      failures.push("target APK reference reached an ADB command");
    }
    if (/^\s*adb\b/.test(line) && /\b(?:install|install-multiple|push|sync)\b/.test(line)) {
      failures.push("workflow bypasses the host install/transfer budget");
    }
    if (/^\s*adb\b/.test(line) && /\b(?:settings|device_config|appops|setprop|date|pm grant|pm revoke)\b/.test(line)) {
      failures.push("workflow performs a forbidden feed, clock, or permission mutation");
    }
  }
  return failures;
}

test("future automatic workflow is owner-scoped, public-byte-bound, and task-relaunch-only", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.deepEqual(validateWorkflow(workflow), []);
});

test("each automatic workflow mutant is rejected individually", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const mutants = [
    ["permissions:\n  contents: read", "permissions:\n  contents: write"],
    ["github.repository == 'Tgk-30/YAWF-Stream'", "github.repository == github.repository"],
    ["github.actor == 'Tgk-30'", "github.actor != ''"],
    ["timeout-minutes: 45", "timeout-minutes: 90"],
    ["BASELINE_SOURCE_SHA: 9fc94a237d99b849cfc18a01085bb487915dd978", `BASELINE_SOURCE_SHA: ${"0".repeat(40)}`],
    ["BASELINE_APK_SHA256: f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb", `BASELINE_APK_SHA256: ${"0".repeat(64)}`],
    ['BASELINE_APK_SIZE: "88558465"', 'BASELINE_APK_SIZE: "1"'],
    ["node scripts/android_public_automatic_ota_admission.mjs", "node scripts/ignored_caller_data_helper.mjs"],
    ["--verify-inputs-only", "--self-test"],
    ["--verify-apks-only", "--self-test"],
    ['assert digest(os.environ["TARGET_MANIFEST"]) == os.environ["TARGET_MANIFEST_SHA256"]', "assert True"],
    ['assert digest(os.environ["TARGET_VERIFICATION"]) == os.environ["TARGET_VERIFICATION_SHA256"]', "assert True"],
    ['"targetCommitish": release.get("target_commitish")', '"targetCommitish": os.environ["TARGET_SOURCE_SHA"]'],
    ["persistenceProof=task-relaunch-only", "persistenceProof=cold-process-proven"],
    ["independentColdProcessProof=false", "independentColdProcessProof=true"],
  ];
  for (const [before, after] of mutants) {
    assert.equal(workflow.split(before).length - 1, 1, `mutation site must be unique: ${before}`);
    assert.notDeepEqual(validateWorkflow(workflow.replace(before, after)), [], `mutant survived: ${before}`);
  }

  for (const injected of [
    '          adb -s "$EMULATOR_SERIAL" install "$TARGET_APK"\n',
    '          adb -s "$EMULATOR_SERIAL" push "$TARGET_APK" /sdcard/target.apk\n',
    '          adb -s "$EMULATOR_SERIAL" shell settings put global yawf_feed private\n',
    '          adb -s "$EMULATOR_SERIAL" shell appops set com.tgk30.debridstreamer REQUEST_INSTALL_PACKAGES allow\n',
  ]) {
    assert.notDeepEqual(validateWorkflow(workflow + injected), [], `ADB mutant survived: ${injected}`);
  }
});

test("host source gates final pull on validated automatic receipt and never sends target to ADB", async () => {
  const source = await readFile(hostPath, "utf8");
  const validate = source.indexOf("validate_receipt(receipt, self.ota_mode, binding)");
  const mark = source.indexOf("self.adb.mark_installer_success_receipt()", validate);
  const finalPull = source.indexOf("self.adb.pull_final_once(self.base_path(), pulled)", mark);
  assert.ok(validate >= 0 && mark > validate && finalPull > mark);
  assert.match(source, /if any\(str\(self\.target_apk\)\.casefold\(\) in part/);
  assert.match(source, /self\._require_automatic_read_only_command\(args\)/);
  assert.match(source, /self\.adb\.run_automatic_instrumentation_once\(/);
  assert.match(source, /self\.harness_install_count != 2/);
  assert.match(source, /self\.adb\.harness_install_count != 2 or self\.adb\.baseline_install_count != 1/);
});
